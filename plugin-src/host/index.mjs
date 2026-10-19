/**
 * dsh-dingtalk-connector —— DSH 插件入口（宿主半侧，唯一真源）。
 *
 * 架构：包装钉钉官方 `dws`（dingtalk-workspace-cli）执行 `dws aitable ...`。
 * 与钉钉官方 OpenClaw connector 同构（经浏览器直读其仓库确认，非推测）：
 *   connector 自己也不直连 REST，而是注入 DWS_CLIENT_ID/SECRET 后调用 dws。
 *
 * 工具：10 个（1 自检 + 4 操作族 + 1 记录读写 + 1 受控直通 + 1 扫描 + 1 导出 + 1 定时任务）。
 * 写门禁：allowWrite / allowDelete 双锁，删除另需逐次 confirm=true。
 *
 * ⚠️ 本文件是**宿主半侧**：只 import `@deepseek-ai/dsh-tools`（由 Host 运行时提供，
 *    绝不可写进 package.json 的任何依赖节——DSH 运行时包用模块局部 Symbol 做 key，
 *    装第二份物理副本会破坏 Host 查找）。
 *
 * 发布产物由 `npm run build` 生成到 lib/；本文件不直接对外。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { AITABLE_COMMANDS, baseDocUri, buildCommand, commandKeys, isDestructive } from './endpoints.mjs'
import { DwsError, runDws, runDwsRaw } from './client.mjs'
import { exportTableCsv } from './export.mjs'
import { scanAitable } from './scan.mjs'
import { JobStore, defaultJobsFile } from './jobs.mjs'
import { createScheduler, computeNextRun } from './scheduler.mjs'
import { registerConnectorRpc, RPC_ENDPOINT } from './rpc.mjs'
import { listAccounts, unbindAccount, createLoginManager } from './accounts.mjs'

export const name = 'dingtalk-connector'
export const inject = ['tools']

const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

const ok = payload => JSON.stringify(payload, null, 2)

function fail(error) {
  if (error instanceof DwsError) {
    return ok({
      ok: false,
      error: error.message,
      diagnostic: error.toDiagnostic(),
      ...(error.stderr === undefined ? {} : { stderr: error.stderr }),
      ...(error.stdout === undefined ? {} : { stdout: error.stdout }),
    })
  }
  return ok({ ok: false, error: String(error?.message ?? error) })
}

/** camelCase → --kebab-case，丢弃空值。 */
function kebab(source) {
  const out = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null || value === '') continue
    out[key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)] = value
  }
  return out
}

/** 把 JSON 字符串参数解析为对象；已是对象则原样返回。 */
function parseJsonFields(args, keys) {
  const out = { ...args }
  for (const key of keys) {
    const value = out[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    try {
      out[key] = JSON.parse(value)
    } catch (cause) {
      throw new DwsError('BAD_JSON', `参数 ${key} 不是合法 JSON：${cause.message}`, {
        hint: `请传入 JSON 字符串，例如 [{"fieldName":"任务名称","type":"text"}]`,
      })
    }
  }
  return out
}

/**
 * 挂载插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  /** 凭证（解析一次，供环境注入）。 */
  let credentialPromise

  async function credentials() {
    credentialPromise ??= (async () => {
      const idEnv = config.clientIdEnv ?? 'DWS_CLIENT_ID'
      const secretEnv = config.clientSecretEnv ?? 'DWS_CLIENT_SECRET'
      // 直传 config → 环境变量；都拿不到就返回空（交给 dws 自己的 OAuth 登录态）
      const clientId = (config.clientId ?? process.env[idEnv] ?? '').trim()
      const clientSecret = (config.clientSecret ?? process.env[secretEnv] ?? '').trim()
      const source = clientId && clientSecret ? `env/config(${idEnv})` : '无（使用 dws auth login 的登录态）'
      ctx.logger?.info?.(`[dingtalk-connector] 凭证来源：${source}`)
      return { clientId, clientSecret, source }
    })()
    return credentialPromise
  }

  /** 门禁：写 / 删除。 */
  function assertAllowed(kind, args) {
    if (kind === 'delete') {
      if (config.allowDelete !== true) {
        throw new DwsError('DELETE_DISABLED', '删除操作被插件门禁拒绝（allowDelete 未开启）。', {
          hint: '在 profile 的 cordis.patch.yml 里为 dingtalk-connector 设 allowDelete: true 后重启 Host。',
        })
      }
      if (args.confirm !== true) {
        throw new DwsError('CONFIRM_REQUIRED',
          '删除不可逆，须逐次确认：请先向用户展示目标记录并取得同意，再以 confirm=true 重试。', {
            hint: '官方 skill 同样要求：危险操作先展示摘要 → 用户明确同意 → 才加 --yes。',
          })
      }
      return
    }
    if (config.allowWrite !== true) {
      throw new DwsError('WRITE_DISABLED', '写操作被插件门禁拒绝（allowWrite 未开启）。', {
        hint: '在 profile 的 cordis.patch.yml 里为 dingtalk-connector 设 allowWrite: true 后重启宿主。',
      })
    }
  }

  /** 批量上限（官方 connector skill：单次批量不超过 30 条）。 */
  function assertBatchSize(records) {
    const max = Number(config.maxBatch ?? 30)
    if (Array.isArray(records) && records.length > max) {
      throw new DwsError('BATCH_TOO_LARGE', `单次批量 ${records.length} 条超过上限 ${max} 条。`, {
        hint: `拆成多次调用，或把配置 maxBatch 调大（dws 接口本身上限 100）。`,
      })
    }
  }

  /** 底层：跑一条注册表内命令，返回 dws 的 body 与实际参数。 */
  async function callDws(key, args, extraFlags = []) {
    const { clientId, clientSecret } = await credentials()
    const argv = buildCommand(key, args)
    if (isDestructive(key)) argv.push('--yes')   // 非交互执行必须跳确认，否则会挂住等输入
    argv.push(...extraFlags)
    const result = await runDws({ args: argv, config, credentials: { clientId, clientSecret }, logger: ctx.logger })
    return { body: result.body, argv }
  }

  /** 底层：直接跑一组 dws 参数（不经注册表；统一补 --format json）。 */
  async function runDwsArgs(args) {
    // 防呆：参数必须以子命令开头（如 aitable record query）。直接以 --flag 开头说明调用方漏了前缀，
    // 否则只会得到 dws 那句难懂的 "unknown flag: --base-id"。这里拦下来给出可执行的错误。
    if (typeof args[0] === 'string' && args[0].startsWith('--')) {
      throw new DwsError('INTERNAL_BAD_ARGS',
        `dws 参数缺少子命令前缀：${args.slice(0, 4).join(' ')}`, {
          hint: 'run() 的 args 必须以子命令开头（例如 ["aitable","record","query", ...]），不能以 --flag 开头。',
        })
    }
    const { clientId, clientSecret } = await credentials()
    const argv = [...args, '--format', 'json']
    const result = await runDws({ args: argv, config, credentials: { clientId, clientSecret }, logger: ctx.logger })
    return result.body
  }

  /** 供 scan / export / scheduler 使用的运行器（只暴露它们需要的三样东西）。 */
  const runner = {
    call: async (key, args) => (await callDws(key, args)).body,
    run: runDwsArgs,
    logger: ctx.logger,
  }

  /** 同步任务存储与调度器（config.jobsFile 可覆盖任务文件位置）。 */
  const jobStore = new JobStore(config.jobsFile ?? defaultJobsFile())
  const scheduler = createScheduler({ runner, store: jobStore, logger: ctx.logger })

  /** 统一执行入口：编译参数 → 调 dws → 回传。 */
  async function exec(key, args) {
    const { body, argv } = await callDws(key, args)
    const baseId = args['base-id']
    return ok({
      ok: true,
      command: `dws ${argv.join(' ')}`,
      ...(baseId ? { docUri: baseDocUri(baseId) } : {}),
      data: body,
    })
  }

  /** 把失败包成 DwsError 之外的通用错误。 */
  async function guarded(fn, args) {
    try {
      return await fn()
    } catch (error) {
      return fail(error)
    }
  }

  // ── ① 自检 ───────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dingtalk_aitable_diagnose',
    description: '钉钉 AI 表格连接自检：检查 dws CLI 是否安装与版本、是否已授权、列出已注册子命令。'
      + '首次配置后先跑这个——失败信息会直接指出是"未安装 / 未登录 / 权限不足 / token 过期"。不产生写操作。',
    parameters: {},
    output: textOutput,
    async execute() {
      return guarded(async () => {
        const report = { ok: true, registeredCommands: commandKeys(), steps: {} }

        try {
          const version = await runDwsRaw(['--version'], { config, logger: ctx.logger })
          report.steps.cliVersion = {
            ok: true,
            output: String(version.body ?? version.stdout ?? '').trim() || '(无输出；dws --version 可能不写 stdout)',
          }
        } catch (error) {
          report.ok = false
          report.steps.cliVersion = {
            ok: false,
            diagnostic: error instanceof DwsError ? error.toDiagnostic() : String(error?.message ?? error),
          }
          return ok(report)   // 没装 CLI 就没必要继续
        }

        try {
          const status = await runDwsRaw(['auth', 'status', '--format', 'json'], { config, logger: ctx.logger })
          report.steps.authStatus = { ok: true, data: status.body }
        } catch (error) {
          report.ok = false
          report.steps.authStatus = {
            ok: false,
            diagnostic: error instanceof DwsError ? error.toDiagnostic() : String(error?.message ?? error),
          }
        }

        const cred = await credentials()
        report.credentialSource = cred.source
        report.rpcEndpoint = rpcState   // 面板可用性自证：registered=true 才说明 /api 端点挂上了

        // 多账号自证：把 profile list 的解析结果与原始返回一起报出来，
        // 便于核对 dws 的真实字段名（面板「刷新账号」走的就是同一条解析）。
        try {
          const accountReport = await listAccounts(runner)
          report.accounts = accountReport.accounts
          report.accountsRaw = accountReport.raw
        } catch (error) {
          report.accounts = null
          report.accountsError = error instanceof DwsError ? error.toDiagnostic() : String(error?.message ?? error)
        }
        report.writeGate = { allowWrite: config.allowWrite === true, allowDelete: config.allowDelete === true }
        report.nextStep = report.ok
          ? '凭证与授权就绪。下一步：base action=search（或 list）拿 baseId → table action=get 拿 tableId 与 fieldId。'
          : '按上面 failed 步骤的 diagnostic 处理；顺序：装 dws → dws auth login → 开权限。'
        return ok(report)
      }, {})
    },
  }))

  // ── ② base：AI 表格文件 ───────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dingtalk_aitable_base',
    description: 'AI 表格文件（Base）操作。action=list 列出最近访问的 Base；search 按名称搜索；'
      + 'get 取该 Base 下的数据表清单；create/update 改名或新建；delete 删除（危险）。'
      + '拿 baseId 是后续一切操作的第一步。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | search | get | create | update | delete' },
      baseId: { type: 'string', description: 'action=get/update/delete 时必填' },
      query: { type: 'string', description: 'action=search 时必填，名称关键词（≥2 字符）' },
      name: { type: 'string', description: 'action=create/update 时必填，1-50 字符' },
      desc: { type: 'string', description: 'action=update 时的备注' },
      templateId: { type: 'string', description: 'action=create 时的模板 ID' },
      cursor: { type: 'string', description: '分页游标，首次不传' },
      limit: { type: 'number', description: '每页数量（list 最大 10）' },
      confirm: { type: 'boolean', description: 'action=delete 时须为 true（已获用户同意）' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const key = `base.${args.action}`
        if (isDestructive(key)) assertAllowed('delete', args)
        const parsed = parseJsonFields(args, [])
        const { action, confirm, ...rest } = parsed
        return exec(key, kebab(rest))
      })
    },
  }))

  // ── ③ table：数据表 ───────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dingtalk_aitable_table',
    description: '数据表（Table）操作。⚠️ action=get **必须传 tableIds 才返回字段目录**'
      + '（不传只返回表名与视图清单——实测确认，dws 官方提示 "to get fields, call get_tables with specific tableIds"）；'
      + '写记录前必须先跑这个拿 fieldId。create 建表（须给初始字段）；update 改名；delete 删表（危险）。',
    parameters: {
      action: { type: 'string', required: true, description: 'get | create | update | delete' },
      baseId: { type: 'string', required: true, description: '所属 Base ID' },
      tableId: { type: 'string', description: 'action=get/update/delete 时必填' },
      tableIds: { type: 'string', description: 'action=get 时**必传**才返回字段目录（不传只返回表与视图清单），逗号分隔，最多 10 个' },
      name: { type: 'string', description: 'action=create/update 时必填，1-100 字符' },
      fields: { type: 'string', description: 'action=create 时必填，JSON 数组字符串（1-15 个）' },
      reason: { type: 'string', description: 'action=delete 时的删除原因' },
      confirm: { type: 'boolean', description: 'action=delete 时须为 true' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const key = `table.${args.action}`
        if (isDestructive(key)) assertAllowed('delete', args)
        const parsed = parseJsonFields(args, ['fields'])
        const { action, confirm, ...rest } = parsed
        return exec(key, kebab(rest))
      })
    },
  }))

  // ── ④ field：列 ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dingtalk_aitable_field',
    description: '字段（Field/列）操作。action=get 取字段完整配置（含 singleSelect 的 option id）；'
      + 'create/update 增改字段；delete 删字段（危险）。',
    parameters: {
      action: { type: 'string', required: true, description: 'get | create | update | delete' },
      baseId: { type: 'string', required: true, description: 'Base ID' },
      tableId: { type: 'string', required: true, description: 'Table ID' },
      fieldId: { type: 'string', description: 'action=get/update/delete 时必填' },
      fieldIds: { type: 'string', description: 'action=get 时可选，逗号分隔，最多 10 个' },
      fields: { type: 'string', description: 'action=create 时必填，JSON 数组字符串（1-15 个）' },
      name: { type: 'string', description: 'action=update 时的新字段名' },
      config: { type: 'string', description: 'action=update 时的字段配置 JSON；改 options 须传完整列表' },
      confirm: { type: 'boolean', description: 'action=delete 时须为 true' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const key = `field.${args.action}`
        if (isDestructive(key)) assertAllowed('delete', args)
        const parsed = parseJsonFields(args, ['fields', 'config'])
        const { action, confirm, ...rest } = parsed
        return exec(key, kebab(rest))
      })
    },
  }))

  // ── ⑤ 读记录 ──────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dingtalk_aitable_record_query',
    description: '查询 AI 表格记录（行）。两种模式：按 ID 取（recordIds）或条件查（filters + sort + cursor 分页）。'
      + '字段多时用 fieldIds 裁剪返回体积。',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Base ID' },
      tableId: { type: 'string', required: true, description: 'Table ID' },
      recordIds: { type: 'string', description: '按 ID 取，逗号分隔，最多 100 个（传了就忽略 filters/sort）' },
      fieldIds: { type: 'string', description: '只返回这些字段，逗号分隔，最多 100 个' },
      filters: { type: 'string', description: '结构化过滤 JSON，如 {"operator":"and","operands":[{"operator":"is","operands":["fldX","值"]}]}' },
      sort: { type: 'string', description: '排序 JSON 数组' },
      keyword: { type: 'string', description: '全文关键词搜索' },
      limit: { type: 'number', description: '单次最大记录数，默认 100，最大 100' },
      cursor: { type: 'string', description: '分页游标，首次不传' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const parsed = parseJsonFields(args, ['filters', 'sort'])
        return exec('record.query', kebab(parsed))
      })
    },
  }))

  // ── ⑥ 写记录 ──────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dingtalk_aitable_record_write',
    description: '新增/更新/删除 AI 表格记录。⚠️ records 里 cells 的 key 必须是 **fieldId**（fldXXX），'
      + '不是字段名——先跑 table action=get 取 fieldId。删除需 allowDelete + confirm=true。',
    parameters: {
      action: { type: 'string', required: true, description: 'create | update | delete' },
      baseId: { type: 'string', required: true, description: 'Base ID' },
      tableId: { type: 'string', required: true, description: 'Table ID' },
      records: { type: 'string', description: 'action=create 必填：[{"cells":{"fldXXX":"值"}}]；'
        + 'action=update 必填（每条含 recordId 与 cells）' },
      recordIds: { type: 'string', description: 'action=delete 必填，逗号分隔，最多 100 个' },
      confirm: { type: 'boolean', description: 'action=delete 时须为 true' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const { action } = args
        const key = `record.${action}`
        assertAllowed(isDestructive(key) ? 'delete' : 'write', args)
        const parsed = parseJsonFields(args, ['records'])
        if (key === 'record.create' || key === 'record.update') assertBatchSize(parsed.records)
        const { action: _a, confirm, ...rest } = parsed
        return exec(key, kebab(rest))
      })
    },
  }))

  // ── ⑦ 受控直通 ────────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dingtalk_aitable_raw',
    description: '受控直通：执行注册表内任一 dws aitable 子命令（如 template.search、attachment.*）。'
      + 'command 必须是已注册键；flags 为 flag 名到值的对象（kebab-case，值可为对象，会被 JSON 化）。'
      + '用于注册表未单独封装的动作。',
    parameters: {
      command: { type: 'string', required: true, description: `已注册键，如 ${commandKeys().slice(0, 3).join(' / ')} 等` },
      flags: { type: 'string', description: 'JSON 对象字符串，键为 kebab-case flag 名' },
      confirm: { type: 'boolean', description: '危险命令须为 true' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        if (!Object.hasOwn(AITABLE_COMMANDS, args.command)) {
          throw new DwsError('UNKNOWN_COMMAND', `未注册的子命令：${args.command}`, {
            hint: `可用命令：${commandKeys().join(', ')}`,
          })
        }
        if (isDestructive(args.command)) assertAllowed('delete', args)
        const flags = parseJsonFields({ flags: args.flags }, ['flags']).flags ?? {}
        return exec(args.command, flags)
      })
    },
  }))

  // ── ⑧ 扫描：候选发现 + 可读性实测 ────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dingtalk_aitable_scan',
    description: '扫描钉钉 AI 表格：多渠道发现候选 Base（base list 最近访问 ∪ base search 多关键词 ∪ 人工补录），'
      + '并对每个候选做**可读性实测**（base get 成功=可读，失败记原因）。'
      + '⚠️ 钉钉侧没有"列出我全部 Base"的接口：base list 只给最近访问，base search 每次约 4 条且**游标翻页无效**'
      + '（实测：hasMore 是误报）。所以本清单是"候选 ∪ 补录"，不保证穷尽——多给关键词或直接给 baseId 可扩大覆盖。',
    parameters: {
      keywords: { type: 'string', description: '搜索关键词，逗号分隔（如 "报表,管理"）。越多覆盖越广' },
      extraBaseIds: { type: 'string', description: '人工补录的 baseId，逗号分隔（从表格 URL 或已知清单来）' },
      withTables: { type: 'boolean', description: '是否顺带返回每个可读 Base 的数据表清单（tableId+表名）' },
      tableLimit: { type: 'number', description: 'withTables=true 时每 Base 最多返回几张表，默认 0=不限制' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        const keywords = String(args.keywords ?? '').split(',').map(text => text.trim()).filter(Boolean)
        const extraBaseIds = String(args.extraBaseIds ?? '').split(',').map(text => text.trim()).filter(Boolean)
        const report = await scanAitable(runner, {
          keywords,
          extraBaseIds,
          withTables: args.withTables === true,
          tableLimit: Number(args.tableLimit ?? 0),
          concurrency: Number(config.scanConcurrency ?? 4),
          logger: ctx.logger,
        })
        return ok({ ok: true, ...report })
      })
    },
  }))

  // ── ⑨ 导出：全量 → CSV（BOM）→ 覆盖 ──────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dingtalk_aitable_export_csv',
    description: '把一张 AI 表格数据表**全量导出为 CSV**：自动翻页拉全（--all），表头用字段中文名，'
      + '编码为**带 BOM 的 UTF-8**（Excel 直开不乱码），**默认直接覆盖同名文件**。'
      + '不用于「一般文档」——文档只能导出 docx/markdown/pdf。',
    parameters: {
      baseId: { type: 'string', required: true, description: 'Base ID' },
      tableId: { type: 'string', required: true, description: 'Table ID' },
      outputPath: { type: 'string', required: true, description: 'CSV 绝对路径（同名直接覆盖）' },
      pageLimit: { type: 'number', description: '自动翻页上限，默认 0=不限制（CLI 内部默认 50 页/5000 条）' },
      fieldIds: { type: 'string', description: '可选。只导出这些字段，逗号分隔，单次最多 100 个' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        // 可选：用 exportRoot 把落盘限制在指定目录内（config 未设则不限制）
        if (typeof config.exportRoot === 'string' && config.exportRoot !== '') {
          const { resolve, relative, isAbsolute } = await import('node:path')
          const root = resolve(config.exportRoot)
          const target = resolve(String(args.outputPath))
          const rel = relative(root, target)
          if (rel.startsWith('..') || isAbsolute(rel)) {
            throw new DwsError('PATH_OUTSIDE_EXPORT_ROOT',
              `落盘路径不在允许的 exportRoot 内：${target}`, {
                hint: `当前 exportRoot=${root}；改配置或换路径。`,
              })
          }
        }
        const stats = await exportTableCsv(runner, {
          baseId: args.baseId,
          tableId: args.tableId,
          outputPath: args.outputPath,
          pageLimit: Number(args.pageLimit ?? 0),
          fieldIds: args.fieldIds,
        })
        return ok({ ok: true, ...stats })
      })
    },
  }))

  // ── ⑩ 定时同步任务 ───────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'dingtalk_sync_job',
    description: '管理「钉钉 AI 表格定时导出」任务。action=create 建任务（每天/每周固定时间导出 CSV，覆盖同名）；'
      + 'list 查看任务与下次触发时间；run-now 立即跑一次；enable/disable 启停；remove 删除。'
      + '⚠️ 定时器跑在 DSH host 进程内：**DSH 关着时不执行**（已确认接受的语义），重启后自动重算下次触发点。',
    parameters: {
      action: { type: 'string', required: true, description: 'create | list | remove | enable | disable | run-now' },
      id: { type: 'string', description: 'action=remove/enable/disable/run-now 时必填' },
      baseId: { type: 'string', description: 'action=create 必填' },
      tableId: { type: 'string', description: 'action=create 必填' },
      outputPath: { type: 'string', description: 'action=create 必填，CSV 绝对路径（同名覆盖）' },
      frequency: { type: 'string', description: 'daily（默认）或 weekly' },
      time: { type: 'string', description: 'action=create 必填，"HH:MM" 24 小时制，如 "09:00"' },
      weekday: { type: 'number', description: 'frequency=weekly 时填 1-7（1=周一 … 7=周日）' },
      label: { type: 'string', description: '可选。任务别名，便于识别' },
      pageLimit: { type: 'number', description: '可选。自动翻页上限，默认 0=不限制' },
    },
    output: textOutput,
    async execute(args) {
      return guarded(async () => {
        switch (args.action) {
          case 'create': {
            const job = await jobStore.add({
              baseId: args.baseId,
              tableId: args.tableId,
              outputPath: args.outputPath,
              frequency: args.frequency ?? 'daily',
              time: args.time,
              weekday: args.weekday,
              label: args.label,
              pageLimit: Number(args.pageLimit ?? 0),
            })
            await scheduler.reschedule(job.id)
            const fresh = jobStore.get(job.id) ?? job
            return ok({
              ok: true, job: fresh,
              nextRunLocal: fresh.nextRun ? new Date(fresh.nextRun).toLocaleString() : undefined,
              note: '已排程。定时器随 DSH host 存活：DSH 关着时不会执行（已确认的语义）。',
            })
          }
          case 'list':
            return ok({ ok: true, jobsFile: jobStore.file, jobs: scheduler.status() })
          case 'remove': {
            if (!args.id) throw new DwsError('ID_REQUIRED', 'action=remove 需要 id')
            const removed = await jobStore.remove(args.id)
            scheduler.stop()          // 简化：移除后停止全部定时器再重排
            await scheduler.start()
            return ok({ ok: true, removed: removed.id })
          }
          case 'enable':
          case 'disable': {
            if (!args.id) throw new DwsError('ID_REQUIRED', `action=${args.action} 需要 id`)
            await jobStore.update(args.id, { enabled: args.action === 'enable' })
            await scheduler.reschedule(args.id)
            return ok({ ok: true, job: scheduler.status().find(row => row.id === args.id) })
          }
          case 'run-now': {
            if (!args.id) throw new DwsError('ID_REQUIRED', 'action=run-now 需要 id')
            const outcome = await scheduler.runNow(args.id)
            return ok({ ok: outcome.ok, outcome })
          }
          default:
            throw new DwsError('UNKNOWN_ACTION',
              `未知 action：${args.action}`, { hint: '可用：create | list | remove | enable | disable | run-now' })
        }
      })
    },
  }))

  /** 面板用：连接与授权状态（只读）。 */
  async function connectorStatus() {
    const cred = await credentials()
    const out = {
      ok: true,
      credentialSource: cred.source,
      writeGate: { allowWrite: config.allowWrite === true, allowDelete: config.allowDelete === true },
      jobsFile: jobStore.file,
      registeredCommands: commandKeys(),
      dwsCommand: config.dwsCommand ?? 'dws',
      // 面板「选表后自动填路径」用的默认目录（config 未设则由面板退化为只填文件名）
      defaultExportDir: typeof config.defaultExportDir === 'string' ? config.defaultExportDir : '',
    }
    try {
      const version = await runDwsRaw(['--version'], { config, logger: ctx.logger })
      out.cliVersion = String(version.body ?? version.stdout ?? '').trim() || '(无输出)'
    } catch (error) {
      out.cliVersion = null
      out.cliError = error instanceof DwsError ? error.toDiagnostic() : String(error?.message ?? error)
    }
    try {
      const status = await runDwsRaw(['auth', 'status', '--format', 'json'], { config, logger: ctx.logger })
      out.auth = status.body?.data ?? status.body
    } catch (error) {
      out.auth = null
      out.authError = error instanceof DwsError ? error.toDiagnostic() : String(error?.message ?? error)
    }
    return out
  }

  /** 面板用：任务清单。 */
  function jobsSummary() {
    return { jobsFile: jobStore.file, jobs: scheduler.status() }
  }

  // 多账号：登录会话管理器（长驻进程，等用户扫码；支持探针模式与取消）
  const loginManager = createLoginManager({
    config,
    logger: ctx.logger,
    // 登录会话的环境注入是同步的：只读环境变量里的应用凭证（设备流本身是用户 OAuth，通常不需要）
    getEnv: () => {
      const idEnv = config.clientIdEnv ?? 'DWS_CLIENT_ID'
      const secretEnv = config.clientSecretEnv ?? 'DWS_CLIENT_SECRET'
      const out = {}
      if (process.env[idEnv]) out.DWS_CLIENT_ID = process.env[idEnv]
      if (process.env[secretEnv]) out.DWS_CLIENT_SECRET = process.env[secretEnv]
      return out
    },
  })

  // 设置面板的 RPC 端点（客户端半侧通过这些方法读写；全部只读或本地文件操作）
  //
  // ★ 必须 scoped 注入，不能直接调 registerConnectorRpc(ctx, …)：
  //   `connection` 只存在于 web 平面（packages/bundle/web-app 挂 @deepseek-ai/dsh-client-connection）。
  //   若把它写进本插件的 inject = ['tools','connection']，headless / tui 等无 web 连接的 profile 里
  //   整个插件会永远停在 inactive —— 连 10 个 dingtalk_aitable_* 工具一起消失。
  //   ctx.inject(['connection'], cb) 在当前 fiber 下开子 fiber：依赖就绪才执行回调，无此服务则静默不执行，
  //   正好是"可选依赖"的语义。官方同款见 packages/api/gateway/src/index.ts:198。
  let rpcState = { registered: false, reason: '等待 connection 服务（仅 web 平面存在）' }
  ctx.inject(['connection'], (rpcCtx) => {
    const disposeRpc = registerConnectorRpc(rpcCtx, {
      runner, jobStore, scheduler, jobsSummary, scanAitable, exportTableCsv, connectorStatus,
      listAccounts, unbindAccount, loginManager,
    })
    rpcState = typeof disposeRpc === 'function'
      ? { registered: true, reason: 'ok', endpoint: `/api/${RPC_ENDPOINT}` }
      : { registered: false, reason: 'connection.fetch.register 不可用' }
    rpcCtx.effect(function* () {
      yield () => { if (typeof disposeRpc === 'function') disposeRpc() }
    }, 'dingtalk-connector rpc endpoint')
  })

  // 启动调度器（异步，失败只记日志不阻塞挂载）
  ctx.effect(function* () {
    yield () => scheduler.stop()
  }, 'dingtalk-connector scheduler')
  void scheduler.start().catch(error => {
    ctx.logger?.error?.(`[dingtalk-connector] 调度器启动失败：${error?.message ?? error}`)
  })

  ctx.logger?.info?.('[dingtalk-connector] 已注册 10 个工具（dws 包装架构；写门禁：'
    + `allowWrite=${config.allowWrite === true}, allowDelete=${config.allowDelete === true}）`)
}
