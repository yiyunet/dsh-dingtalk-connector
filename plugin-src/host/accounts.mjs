/**
 * 多账号管理：列出 / 移除接入 / 扫码绑定。
 *
 * 事实来源（dws 官方技能，本机 ~/.agents/skills/ 下的 dingtalk-misc / dingtalk-shared）：
 *   · dingtalk-misc/references/profile.md:5   一个 profile = 一个 corpId + userId 身份；可同时登录多个账号
 *   · 同文件 :18  `dws profile list --format json` 列出全部账号，profile 是稳定选择器 corpId:userId
 *   · 同文件 :21  `dws auth login` 新账号新增 profile；同身份重登只刷新该账号
 *   · 同文件 :41  `auth logout` 传精确选择器只退出一个账号（不传＝退全部）
 *   · dingtalk-shared/references/global-reference.md:18-20  `auth login --recommend` / `--device --recommend`，均支持 --format json
 *
 * 短命令（list / logout）走既有安全执行器；只有**长驻的登录会话**需要单独 spawn（它要等用户扫码，不能等退出）。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** shell 模式下必须拒绝的字符（与 client.mjs 同一套约束）。 */
const SHELL_UNSAFE = /["'`$\\|&;<>^%!()\r\n\0]/

/** 把 selector 归一化：只允许 selector 字符集，防注入与误选。 */
function normalizeSelector(selector) {
  const value = String(selector ?? '').trim()
  if (value === '' || value.length > 200 || !/^[A-Za-z0-9:._@\u4e00-\u9fa5-]+$/.test(value)) {
    throw new Error(`非法的账号选择器：${JSON.stringify(selector)}`)
  }
  return value
}

/** 列出全部已绑定账号（含 isCurrent / isOrgCurrent 与 token 状态）。 */
export async function listAccounts(runner) {
  const body = await runner.run(['profile', 'list'])
  const data = body?.data ?? body
  const accounts = data?.profiles ?? data?.accounts ?? data?.items ?? []
  return {
    accounts: (Array.isArray(accounts) ? accounts : []).map(entry => ({
      profile: entry.profile ?? entry.selector ?? entry.id ?? `${entry.corpId ?? ''}:${entry.userId ?? ''}`,
      corpId: entry.corpId,
      corpName: entry.corpName ?? entry.corp_name,
      userId: entry.userId,
      userName: entry.userName ?? entry.user_name,
      isCurrent: entry.isCurrent === true,
      isOrgCurrent: entry.isOrgCurrent === true,
      authenticated: entry.authenticated ?? entry.token_valid ?? undefined,
      expiresAt: entry.expires_at ?? entry.expiresAt,
    })),
    raw: data,
  }
}

/**
 * 移除单个账号接入。
 * @param {object} runner
 * @param {string} selector - profile list 返回的稳定 corpId:userId（或本地 profile 名）
 */
export async function unbindAccount(runner, selector) {
  const stable = normalizeSelector(selector)
  const body = await runner.run(['auth', 'logout', '--profile', stable])
  return { selector: stable, result: body?.data ?? body }
}

/**
 * 登录会话管理器：把长驻的 `dws auth login` 变成一个可查询/可取消的会话。
 *
 * `dws auth login`（设备流）会一直等到用户在钉钉 App 完成扫码，因此**不能**走"等退出"的执行器。
 * 这里单独 spawn，增量收集输出，并支持：
 *   · probeMs —— 抓取若干毫秒后**自动杀掉**（用于探测输出形态）
 *   · cancel  —— 用户点「取消」时结束会话
 */
export function createLoginManager({ config, logger, getEnv }) {
  /** 同时只允许一个登录会话。 */
  let session

  function buildLaunch(args) {
    const entry = config.dwsEntry
    const useEntry = typeof entry === 'string' && entry !== '' && existsSync(entry)
    const needsShell = !useEntry && process.platform === 'win32'
    if (needsShell) {
      const bad = args.find(argument => SHELL_UNSAFE.test(argument))
      if (bad !== undefined) throw new Error(`登录参数含 shell 元字符，拒绝执行：${bad}`)
    }
    return {
      file: useEntry ? process.execPath : (config.dwsCommand ?? 'dws'),
      argv: useEntry ? [entry, ...args] : args,
      shell: needsShell,
    }
  }

  function snapshot() {
    if (session === undefined) return { active: false }
    return {
      active: session.child.exitCode === null && session.child.signalCode === null,
      id: session.id,
      phase: session.phase,          // running | exited | killed
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      exitCode: session.child.exitCode,
      output: session.output.slice(-8000),   // 只保留尾部，防内存膨胀
      urls: extractUrls(session.output),
      qrPayload: session.qrPayload,          // 二维码承载的深链（含 user_code）
      qrDataUrl: session.qrDataUrl,          // 宿主生成的二维码（data:image/svg+xml;base64,…）
      blocked: session.blocked,              // 组织级策略拦阻（如未开启 CLI 个人数据访问）
      note: session.note,
    }
  }

  function start(options = {}) {
    if (session !== undefined && session.child.exitCode === null && session.child.signalCode === null) {
      return { ok: false, error: { code: 'login-in-progress', message: '已有一个登录会话在进行中，请先取消', details: {} } }
    }
    const { device = true, probeMs = 0 } = options
    const args = ['auth', 'login']
    if (device) args.push('--device')
    args.push('--recommend', '--format', 'json')

    const launch = buildLaunch(args)
    const child = spawn(launch.file, launch.argv, {
      env: { ...process.env, DWS_CHANNEL: 'dsh', ...getEnv() },
      shell: launch.shell,
      windowsHide: true,
    })
    session = {
      id: `login-${Date.now().toString(36)}`,
      child,
      phase: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      output: '',
      // ⚠️ 措辞纠正（2026-09-14）：
      //    不要写成"设备流会被**自动批准**"，那是**误导**。
      //    真实原因：**本机当前已处于钉钉登录态**，设备流因此可直接选定对应的钉钉账号
      //    与企业组织，无需扫码即通过授权并走到换取令牌一步。
      //    推论（重要）：
      //      · 在已登录钉钉的电脑上，「扫码绑定」可能**不扫码就完成** —— 更省事，但也意味着
      //        它使用的是本机当前选定的那个账号/组织，而非让用户重新挑一个；
      //      · 因此探针**不是零副作用**：若组织已开启 CLI 访问，探测即可能真的新增账号。
      note: probeMs > 0
        ? `探针模式：${probeMs}ms 后自动结束。⚠️ 本机已处于钉钉登录态，设备流可直接选定账号与企业组织、无需扫码即通过授权 —— 所以探针不是零副作用（若组织已开启 CLI 访问，可能直接新增账号）。`
        : undefined,
    }

    /** 增量吃输出：抽链接 → 生成二维码 → 识别组织级拦阻。 */
    const ingest = (chunk) => {
      session.output += String(chunk)

      // 二维码：dws **不输出 QR**（实测只给 link + authorization code + 带 user_code 的深链），
      // 因此由宿主用 qrcode 包自己画，前端只渲染 <img src=data:…>。
      const deep = deepLinkOf(session.output)
      if (deep !== undefined && deep !== session.qrPayload) {
        session.qrPayload = deep
        void renderQr(config, deep).then((dataUrl) => {
          if (dataUrl !== undefined) session.qrDataUrl = dataUrl
        })
      }

      // 组织级拦阻：需要主管理员在开放平台开启「允许成员通过 CLI 访问个人数据」
      if (session.blocked === undefined && /CLI data access is not enabled/i.test(session.output)) {
        const admins = /组织主管理员：([^\n]+)/.exec(session.output)
        session.blocked = {
          reason: '组织未开启「允许成员通过 CLI 访问个人数据」',
          admins: admins === null ? undefined : admins[1].trim(),
          action: 'https://open-dev.dingtalk.com/fe/old#/developerSettings',
          hint: '需组织主管理员在钉钉开放平台开启该开关，然后重新扫码。这属组织管理动作，不是技术配置。',
        }
      }
    }
    logger?.info?.(`[dingtalk-connector] 登录会话启动：dws ${args.join(' ')}${probeMs > 0 ? `（探针 ${probeMs}ms）` : ''}`)

    child.stdout?.on('data', ingest)
    child.stderr?.on('data', ingest)
    child.on('error', (error) => {
      if (session === undefined) return
      session.output += `\n[spawn error] ${error?.message ?? error}`
      session.phase = 'exited'
      session.endedAt = new Date().toISOString()
    })
    child.on('close', (code, signal) => {
      if (session === undefined) return
      session.phase = signal !== null ? 'killed' : 'exited'
      session.endedAt = new Date().toISOString()
      session.exitCode = code
      logger?.info?.(`[dingtalk-connector] 登录会话结束：code=${code} signal=${signal}`)
    })

    if (probeMs > 0) {
      setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } }, probeMs)
    }
    return { ok: true, session: snapshot() }
  }

  function cancel() {
    if (session === undefined || session.child.exitCode !== null) return { ok: true, session: snapshot() }
    try { session.child.kill() } catch (error) { logger?.warn?.(`[dingtalk-connector] 取消登录失败：${error?.message ?? error}`) }
    return { ok: true, session: snapshot() }
  }

  return { start, cancel, status: snapshot, isActive: () => session !== undefined && session.child.exitCode === null }
}

/** 从任意文本里抽出 http(s) 链接（登录 URL 可能在 JSON 里，也可能在人类可读输出里）。 */
export function extractUrls(text) {
  const matches = String(text ?? '').match(/https?:\/\/[^\s"'<>\\)\]]+/g)
  return matches === null ? [] : [...new Set(matches)]
}

/**
 * 抽出承载 user_code 的深链 —— 这才是该被扫码/打开的那个地址。
 *
 * 实测（2026-09-14）dws 设备流输出形如：
 *   link: https://login.dingtalk.com/oauth2/device/verify.htm
 *   authorization code: QMQK-PTMB
 *   Or open the following link:
 *     https://login.dingtalk.com/oauth2/device/verify.htm?user_code=QMQK-PTMB
 * **它不输出二维码**，所以要扫码必须由我们自己把这条深链画成二维码。
 */
export function deepLinkOf(text) {
  const match = String(text ?? '').match(/https?:\/\/[^\s"'<>]*user_code=[A-Za-z0-9_-]+/)
  return match === null ? undefined : match[0]
}

/**
 * 生成二维码 data URL（SVG）。**不调用任何第三方二维码服务** —— 认证链接不外发。
 *
 * qrcode 是本插件的**可选依赖**：解析成功就能扫码，失败则面板退化为"只显示深链 + 授权码"。
 * 解析顺序：
 *   ① 直接 import('qrcode')
 *   ② 配置 qrcodeFrom 指定的包目录（绝对路径；解析失败时的兜底，例如 profile 里已 hoist 的副本）
 *   ③ 都失败 → 返回 undefined（明确降级，不静默失败）
 */
async function renderQr(config, text) {
  const attempts = [() => import('qrcode')]
  if (typeof config.qrcodeFrom === 'string' && config.qrcodeFrom !== '') {
    attempts.push(() => import(pathToFileURL(join(config.qrcodeFrom, 'lib', 'index.js')).href))
  }
  for (const attempt of attempts) {
    try {
      const mod = await attempt()
      const QR = mod?.default ?? mod
      if (typeof QR?.toString === 'function') {
        const svg = await QR.toString(text, { type: 'svg', margin: 1, width: 260 })
        return `data:image/svg+xml;base64,${Buffer.from(String(svg)).toString('base64')}`
      }
    } catch {
      // 试下一个解析路径
    }
  }
  return undefined
}
