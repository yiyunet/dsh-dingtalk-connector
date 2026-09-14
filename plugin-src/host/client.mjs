/**
 * dws 执行器：把注册表编译出的参数交给 `dws` CLI，解析其 JSON 输出，并按**钉钉官方
 * 错误信号表**把失败翻译成可执行的下一步。
 *
 * 设计要点：
 *  - **不经 shell 传参**：优先用 dws 的 JS 入口 + node 直接 spawn（`dwsEntry`），
 *    这样记录文本里的引号/&/| 等字符不会被 shell 解释。仅在没有 JS 入口时才回退到
 *    带严格字符校验的 shell 模式。
 *  - **凭证只走环境变量**：DWS_CLIENT_ID / DWS_CLIENT_SECRET（官方支持的 headless 方式），
 *    绝不写进命令行参数（参数会出现在进程列表里）。
 *  - **错误分级**：照搬官方 skill 的错误信号识别表，403/未登录/未安装各有明确指引。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/** shell 模式下必须拒绝的字符（会被 cmd.exe / sh 解释）。 */
const SHELL_UNSAFE = /["'`$\\|&;<>^%!()\r\n\0]/

/** 官方错误信号 → 人类可执行的下一步。 */
const SIGNALS = [
  {
    test: /command not found|不是内部或外部命令|'dws' 不是/i,
    code: 'CLI_NOT_INSTALLED',
    hint: '安装 dws：npm i -g dingtalk-workspace-cli，然后 dws --version 确认 >= 1.0.6。',
  },
  {
    test: /AUTH_TOKEN_EXPIRED|USER_TOKEN_ILLEGAL|Token验证失败|token expired/i,
    code: 'AUTH_EXPIRED',
    hint: '执行 dws auth login 重新登录（headless 可先设 DWS_CLIENT_ID / DWS_CLIENT_SECRET 再 login）。',
  },
  {
    test: /请先执行 dws login|dws auth login|未登录|not logged in/i,
    code: 'NOT_LOGGED_IN',
    hint: '尚未授权：执行 dws auth login 用钉钉 App 扫码完成 OAuth 授权。',
  },
  {
    // 放在权限之前：`--all --page-limit N` 触顶时 dws 以退出码 1 + incomplete_result 结束，
    // 那是"部分成功可续拉"，不是权限问题。（本插件已改用显式游标翻页，正常不会再触发。）
    test: /page-limit reached|incomplete_result|more data available/i,
    code: 'PAGING_TRUNCATED',
    hint: '达到翻页上限但仍有数据：用返回的 cursor 继续拉取，或把 page-limit 调大／分段导出。',
  },
  {
    test: /permission denied|forbidden|403|权限不足|无权限/i,
    code: 'PERMISSION_DENIED',
    hint: '权限不足：到钉钉开发者后台为该应用开通 AI 表格（多维表）读写权限，'
      + '并把该应用加为目标 Base 的协作者；改完需发布生效。',
  },
  {
    test: /RECOVERY_EVENT_ID=([A-Za-z0-9_-]+)/,
    code: 'RECOVERY',
    hint: 'cli 已持久化失败快照：按 dws recovery plan/execute/finalize 闭环处理。',
  },
]

export class DwsError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'DwsError'
    this.code = code
    Object.assign(this, detail)
  }

  toDiagnostic() {
    const parts = [`code=${this.code}`]
    if (this.exitCode !== undefined) parts.push(`exit=${this.exitCode}`)
    if (this.command !== undefined) parts.push(`cmd=dws ${this.command}`)
    if (this.hint !== undefined) parts.push(`建议：${this.hint}`)
    return parts.join(' | ')
  }
}

/** 从混杂输出里提取最后一个 JSON 对象（CLI 可能先打日志再打结果）。 */
function extractJson(text) {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // 退化为"最后一个平衡的 {...}"
  }
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/**
 * 解析 dws 的结构化错误信封（形如 {"error":{"cause":…,"code":…,"category":…}}）。
 *
 * 为什么要单独解析：早先的实现对**整段 stderr 做正则匹配**，结果在一条含 "403" 的记录数据上
 * 命中了权限规则，把"翻页触顶"误报成 PERMISSION_DENIED。现在只拿信封里的语义字段做匹配。
 * @returns {object | undefined} 信封内的 error 对象
 */
function parseErrorEnvelope(text) {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && parsed.error !== undefined) return parsed.error
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 执行一次 dws。
 * @param {object} options
 * @param {string[]} options.args - 例如 ['aitable','record','query','--base-id','x','--format','json']
 * @param {object} [options.config] - 插件配置
 * @param {Record<string,string>} [options.credentials] - { clientId, clientSecret }
 * @param {{info?: Function, warn?: Function, error?: Function}} [options.logger]
 * @returns {Promise<{ok: boolean, body?: unknown, exitCode: number, stderr: string}>}
 */
export function runDws({ args, config = {}, credentials = {}, logger } = {}) {
  const timeoutMs = Number(config.timeoutMs ?? 60000)
  const command = config.dwsCommand ?? 'dws'
  const entry = config.dwsEntry
  const useEntry = typeof entry === 'string' && entry !== '' && existsSync(entry)

  // shell 回退仅在 win32 且未提供 JS 入口时使用，且先做严格字符校验。
  const needsShell = !useEntry && process.platform === 'win32'
  if (needsShell) {
    const bad = args.find(argument => SHELL_UNSAFE.test(argument))
    if (bad !== undefined) {
      return Promise.reject(new DwsError('ARG_UNSAFE',
        '参数含 shell 元字符，而当前只能走 shell 模式，拒绝执行以防注入。', {
          command: args.join(' '),
          hint: '在插件配置里把 dwsEntry 指向 dws 的 JS 入口（如 <npm root -g>\\dingtalk-workspace-cli\\bin\\dws.js），'
            + '即可无 shell 安全传参；记录文本里的引号/&/| 就需要这样处理。',
        }))
    }
  }

  const file = useEntry ? process.execPath : command
  const argv = useEntry ? [entry, ...args] : args

  const env = {
    ...process.env,
    DWS_CHANNEL: 'dsh',
    ...(credentials.clientId ? { DWS_CLIENT_ID: credentials.clientId } : {}),
    ...(credentials.clientSecret ? { DWS_CLIENT_SECRET: credentials.clientSecret } : {}),
  }

  logger?.info?.(`[dingtalk-connector] 执行：dws ${args.slice(0, 4).join(' ')} …`)

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, argv, { env, shell: needsShell, windowsHide: true })
    } catch (cause) {
      reject(new DwsError('SPAWN_FAILED', `无法启动 dws：${cause?.message ?? cause}`, {
        cause, hint: '确认 dws 在 PATH 上（dws --version），或配置 dwsEntry / dwsCommand。',
      }))
      return
    }

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new DwsError('TIMEOUT', `dws 执行超时（${timeoutMs}ms）。`, {
        command: args.join(' '),
        hint: '调大插件配置 timeoutMs，或缩小单次查询量（limit / field-ids）。',
      }))
    }, timeoutMs)

    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })

    child.on('error', (cause) => {
      clearTimeout(timer)
      const notFound = cause?.code === 'ENOENT'
      reject(new DwsError(notFound ? 'CLI_NOT_INSTALLED' : 'SPAWN_FAILED',
        notFound ? '找不到 dws 命令。' : `dws 启动失败：${cause?.message}`, {
          cause, exitCode: undefined, command: args.join(' '),
          hint: notFound ? '安装：npm i -g dingtalk-workspace-cli（需 >= 1.0.6）。' : undefined,
        }))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      const exitCode = code ?? 0

      if (exitCode === 0) {
        const parsed = extractJson(stdout)
        resolve({
          ok: true,
          body: parsed?.body ?? parsed,
          envelope: parsed,
          stdout,
          exitCode,
          stderr,
        })
        return
      }

      // 非零退出：解析 dws 的结构化错误信封，**只对语义字段做信号匹配**。
      // （对整段 stderr 正则匹配会把记录数据里的 "403" 误判成权限不足 —— 见 parseErrorEnvelope 注释）
      const envelope = parseErrorEnvelope(stderr) ?? parseErrorEnvelope(stdout)
      const probe = envelope
        ? [envelope.cause, envelope.message, envelope.reason, envelope.category].filter(Boolean).join(' | ')
        : `${stderr}\n${stdout}`
      const matched = SIGNALS.find(signal => signal.test.test(probe))
      reject(new DwsError(matched?.code ?? 'DWS_FAILED',
        `dws 退出码 ${exitCode}${matched ? `（${matched.code}）` : ''}。`, {
          exitCode, command: args.join(' '), hint: matched?.hint,
          providerCause: envelope?.cause,
          providerBody: envelope,
          stderr: stderr.trim().slice(0, 4000) || undefined,
          stdout: stdout.trim().slice(0, 1000) || undefined,
        }))
    })
  })
}

/** 便捷：跑一条不属于 aitable 的 dws 命令（诊断用）。 */
export function runDwsRaw(args, options = {}) {
  return runDws({ ...options, args })
}
