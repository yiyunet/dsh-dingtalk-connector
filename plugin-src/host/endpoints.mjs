/**
 * dws 子命令注册表 —— 全插件唯一声明"能跑什么"的地方。
 *
 * 事实来源（2026-09-14 经浏览器直读钉钉官方 OpenClaw connector 仓库，**非推测**）：
 *   DingTalk-Real-AI/dingtalk-openclaw-connector @ v0.8.26
 *     · skills/dws-cli/SKILL.md
 *     · skills/dws-cli/references/products/aitable.md
 *     · skills/dws-cli/references/global-reference.md
 *
 * 架构结论（重要）：钉钉官方 connector 自己**不直连 AI 表格 REST API**，而是包装
 * `dws`（dingtalk-workspace-cli）执行 `dws aitable ...`。本插件采用同一架构——
 * 这消除了自研 REST 时"端点靠猜"的全部风险。
 *
 * 数据模型（关键，勿混淆）：
 *   base   = AI 表格文件（baseId）
 *   table  = 数据表（tableId）        ← 本插件 v0.1 曾误写 sheetId，已纠正
 *   field  = 列（fieldId，形如 fldXXX）
 *   record = 行（recordId，形如 recXXX）
 *
 * 铁律：records 的 `cells` 的 key 必须是 **fieldId**，不是字段名。
 */

/** 危险操作：执行前须显式门禁 + 加 --yes。 */
export const DESTRUCTIVE = 'destructive'

/**
 * 子命令规格。
 * @typedef {{path: string[], flags: Record<string, {type: 'string'|'number'|'json', required?: boolean}>, risk?: string, note?: string}} CommandSpec
 */

/** @type {Readonly<Record<string, CommandSpec>>} */
export const AITABLE_COMMANDS = Object.freeze({
  // ── base：AI 表格文件 ────────────────────────────────────────────────
  'base.list': {
    path: ['base', 'list'],
    flags: { cursor: { type: 'string' }, limit: { type: 'number' } },
    note: '⚠️ base list 只返回【最近访问过】的 Base，不是全部。找不到时改用 base.search，'
      + '或用 base.create 返回的 baseId。limit 默认 10、最大 10。',
  },
  'base.search': {
    path: ['base', 'search'],
    flags: { query: { type: 'string', required: true }, cursor: { type: 'string' } },
    note: 'query 建议至少 2 个字符。',
  },
  'base.get': {
    path: ['base', 'get'],
    flags: { 'base-id': { type: 'string', required: true } },
    note: '返回 baseName / tables / dashboards 概要（不含字段与记录详情）。**tableId 优先从这里取。**',
  },
  'base.create': {
    path: ['base', 'create'],
    flags: { name: { type: 'string', required: true }, 'template-id': { type: 'string' } },
    note: '创建后直接用返回的 baseId，无需再 list/search 查找。',
  },
  'base.update': {
    path: ['base', 'update'],
    flags: {
      'base-id': { type: 'string', required: true },
      name: { type: 'string', required: true },
      desc: { type: 'string' },
    },
  },
  'base.delete': {
    path: ['base', 'delete'],
    flags: { 'base-id': { type: 'string', required: true }, reason: { type: 'string' } },
    risk: DESTRUCTIVE,
    note: '删除整个 AI 表格，含全部数据表与记录，不可逆。',
  },

  // ── table：数据表 ────────────────────────────────────────────────────
  'table.get': {
    path: ['table', 'get'],
    flags: { 'base-id': { type: 'string', required: true }, 'table-ids': { type: 'string' } },
    note: '返回 tableId/tableName 与 fields 目录、views 目录。'
      + '**写记录前必须先跑这个拿 fieldId。**不传 table-ids 返回全部表；单次最多 10 个。',
  },
  'table.create': {
    path: ['table', 'create'],
    flags: {
      'base-id': { type: 'string', required: true },
      name: { type: 'string', required: true },
      fields: { type: 'json', required: true },
    },
    note: '初始字段至少 1 个、单次最多 15 个。'
      + '示例：[{"fieldName":"任务名称","type":"text"},{"fieldName":"优先级","type":"singleSelect",'
      + '"config":{"options":[{"name":"高"},{"name":"中"}]}}]',
  },
  'table.update': {
    path: ['table', 'update'],
    flags: {
      'base-id': { type: 'string', required: true },
      'table-id': { type: 'string', required: true },
      name: { type: 'string', required: true },
    },
  },
  'table.delete': {
    path: ['table', 'delete'],
    flags: {
      'base-id': { type: 'string', required: true },
      'table-id': { type: 'string', required: true },
      reason: { type: 'string' },
    },
    risk: DESTRUCTIVE,
    note: '不可逆；若为 Base 中最后一张表，删除会失败。',
  },

  // ── field：列 ────────────────────────────────────────────────────────
  'field.get': {
    path: ['field', 'get'],
    flags: {
      'base-id': { type: 'string', required: true },
      'table-id': { type: 'string', required: true },
      'field-ids': { type: 'string' },
    },
    note: '返回字段完整配置（含 options）。singleSelect 过滤用 option id 更可靠（从本命令取）。',
  },
  'field.create': {
    path: ['field', 'create'],
    flags: {
      'base-id': { type: 'string', required: true },
      'table-id': { type: 'string', required: true },
      fields: { type: 'json', required: true },
    },
    note: '至少 1 个、单次最多 15 个。允许部分成功，返回逐项状态。',
  },
  'field.update': {
    path: ['field', 'update'],
    flags: {
      'base-id': { type: 'string', required: true },
      'table-id': { type: 'string', required: true },
      'field-id': { type: 'string', required: true },
      name: { type: 'string' },
      config: { type: 'json' },
    },
    note: '不可变更字段类型。改 singleSelect/multipleSelect 的 options 须传完整列表，已有选项回传原 id。',
  },
  'field.delete': {
    path: ['field', 'delete'],
    flags: {
      'base-id': { type: 'string', required: true },
      'table-id': { type: 'string', required: true },
      'field-id': { type: 'string', required: true },
    },
    risk: DESTRUCTIVE,
    note: '不可逆；禁止删除主字段和最后一个字段。',
  },

  // ── record：行 ───────────────────────────────────────────────────────
  'record.query': {
    path: ['record', 'query'],
    flags: {
      'base-id': { type: 'string', required: true },
      'table-id': { type: 'string', required: true },
      'record-ids': { type: 'string' },
      'field-ids': { type: 'string' },
      filters: { type: 'json' },
      sort: { type: 'json' },
      keyword: { type: 'string' },
      limit: { type: 'number' },
      cursor: { type: 'string' },
      all: { type: 'boolean' },
      'page-limit': { type: 'number' },
    },
    note: '两种模式：按 ID 取（传 record-ids，忽略 filters/sort）或条件查（filters+sort+cursor 分页）。'
      + '**全量导出用 all=true**（CLI 自动翻页合并；pageLimit 默认 50 页/5000 条，0=无限制）；'
      + '被截断时返回 hasMore+cursor，用 cursor 续拉。'
      + '⚠️ filters 根节点不能直接用 eq（会被静默忽略并返回全表）；sort 方向字段是 direction 而非 order。'
      + 'limit 默认 100、最大 100。filters 结构：'
      + '{"operator":"and","operands":[{"operator":"is","operands":["<fieldId>","<value>"]}]}。'
      + '字段多时用 field-ids 裁剪返回体积（单次最多 100 个）。',
  },
  'record.create': {
    path: ['record', 'create'],
    flags: {
      'base-id': { type: 'string', required: true },
      'table-id': { type: 'string', required: true },
      records: { type: 'json', required: true },
    },
    note: '⚠️ 参数名是 records（不是 data）；cells 的 key 必须是 **fieldId**（fldXXX）而不是字段名。'
      + '示例：[{"cells":{"fldABC123":"Python入门"}}]。单次最多 100 条。',
  },
  'record.update': {
    path: ['record', 'update'],
    flags: {
      'base-id': { type: 'string', required: true },
      'table-id': { type: 'string', required: true },
      records: { type: 'json', required: true },
    },
    note: '每条须含 recordId 与 cells；只传要改的字段，未传的保持原值。'
      + '示例：[{"recordId":"recXXX","cells":{"fldStatusId":"已完成"}}]',
  },
  'record.delete': {
    path: ['record', 'delete'],
    flags: {
      'base-id': { type: 'string', required: true },
      'table-id': { type: 'string', required: true },
      'record-ids': { type: 'string', required: true },
    },
    risk: DESTRUCTIVE,
    note: '不可逆。调用前先用 record.query 确认目标记录。',
  },

  // ── template：模板 ───────────────────────────────────────────────────
  'template.search': {
    path: ['template', 'search'],
    flags: { query: { type: 'string', required: true }, cursor: { type: 'string' }, limit: { type: 'number' } },
    note: '返回 templateId，可用于 base.create --template-id。limit 默认 10、最大 30。',
  },
})

/** 全部已注册子命令键（供诊断与白名单使用）。 */
export function commandKeys() {
  return Object.keys(AITABLE_COMMANDS)
}

/** 该子命令是否危险（不可逆）。 */
export function isDestructive(key) {
  return AITABLE_COMMANDS[key]?.risk === DESTRUCTIVE
}

/** 文档 URI：把 baseId 变成人类可点的链接（官方 reference 明确要求回传）。 */
export function baseDocUri(baseId) {
  return `https://alidocs.dingtalk.com/i/nodes/${baseId}`
}

/**
 * 把工具入参编译成 dws 参数数组（**逐元素传递，不经 shell**）。
 * @param {string} key - AITABLE_COMMANDS 的键
 * @param {Record<string, unknown>} args - 工具入参
 * @returns {string[]} 例如 ['aitable','record','query','--base-id','xxx','--format','json']
 */
export function buildCommand(key, args = {}) {
  const spec = AITABLE_COMMANDS[key]
  if (!spec) throw new Error(`未注册的 dws 子命令：${key}`)

  const out = ['aitable', ...spec.path]
  for (const [flag, def] of Object.entries(spec.flags)) {
    const raw = args[flag]
    // 布尔开关：true → 只推 `--flag`；false/未给 → 跳过（不能推 `--flag false`）
    if (def.type === 'boolean') {
      if (raw === true || raw === 'true') out.push(`--${flag}`)
      continue
    }
    if (raw === undefined || raw === null || raw === '') {
      if (def.required) throw new Error(`${key} 缺少必填参数 --${flag}`)
      continue
    }
    // 0 是合法值（如 pageLimit=0 表示无限制），不能被当空值丢掉
    const value = typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
    out.push(`--${flag}`, value)
  }
  out.push('--format', 'json')
  return out
}
