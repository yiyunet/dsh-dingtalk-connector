#!/usr/bin/env node
/**
 * CLI 引导：把本插件装进指定 DSH profile，或做一次环境体检。
 *
 *   npx @yiyunet/dsh-dingtalk-connector install [--profile web]
 *   npx @yiyunet/dsh-dingtalk-connector doctor
 *   npx @yiyunet/dsh-dingtalk-connector --help
 *
 * 设计原则：**不替用户改配置**。install 只调用 dsh 官方命令并回显结果，
 * 需要用户决策的地方（开写门禁、设 exportRoot）只提示、不代劳。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SELF = '@yiyunet/dsh-dingtalk-connector'
const manifest = require('../package.json')

/** 跑一条命令并把输出直通给用户。 */
function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options })
    child.on('error', error => resolvePromise({ ok: false, error }))
    child.on('close', code => resolvePromise({ ok: code === 0, code }))
  })
}

/** 跑一条命令并捕获输出（用于体检）。 */
function capture(command, args) {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { shell: process.platform === 'win32', windowsHide: true })
    } catch (error) {
      resolvePromise({ ok: false, stdout: '', stderr: String(error?.message ?? error), code: null })
      return
    }
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', error => resolvePromise({ ok: false, stdout, stderr: String(error?.message ?? error), code: null }))
    child.on('close', code => resolvePromise({ ok: code === 0, stdout, stderr, code }))
  })
}

function parseArgs(argv) {
  const out = { command: argv[0] ?? '--help', profile: 'web', positionals: [] }
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--profile' || token === '-p') {
      out.profile = argv[index + 1] ?? 'web'
      index += 1
    } else if (token.startsWith('--profile=')) {
      out.profile = token.slice('--profile='.length)
    } else {
      out.positionals.push(token)
    }
  }
  return out
}

function usage() {
  console.log(`
${SELF} v${manifest.version}
${manifest.description}

用法：
  install [--profile <name>]   把插件装进指定 DSH profile（默认 web），装完需重启 dsh
  doctor                       体检：dsh / dws / Node 版本与授权状态
  --help                       显示本帮助

前置条件：
  1. 安装 dws CLI：npm i -g dingtalk-workspace-cli   （需 >= 1.0.6）
  2. 授权：dws auth login                            （或设 DWS_CLIENT_ID / DWS_CLIENT_SECRET）
  3. 在钉钉开发者后台开通 AI 表格（多维表）读写权限，并把应用加为目标 Base 的协作者
     —— 这两件事缺一不可，漏了必然 403。

安全默认：写与删除门禁**默认全关**；删除另需逐次 confirm=true。
详见 README「安全与边界」。
`)
}

async function install(profile) {
  console.log(`→ 安装到 profile「${profile}」…`)
  const result = await run('dsh', ['plugin', '--profile', profile, 'add', SELF])
  if (!result.ok) {
    console.error('\n✗ 安装失败。请确认 dsh 在 PATH 上（dsh --version），或改用本地路径安装：')
    console.error(`   dsh plugin --profile ${profile} add "<本仓库绝对路径>"`)
    process.exitCode = 1
    return
  }
  console.log('\n→ 核对配置层：')
  await run('dsh', ['--profile', profile, '--dump-config'])
  console.log('\n✓ 装好了。请重启 dsh（如 dsh web），然后在「设置 → 钉钉文档」里绑定账号。')
}

async function doctor() {
  const rows = []

  const dshVersion = await capture('dsh', ['--version'])
  rows.push(['dsh', dshVersion.ok ? dshVersion.stdout.trim() || '(无输出)' : `✗ ${dshVersion.stderr.trim() || '未找到 dsh'}`])

  const dwsVersion = await capture('dws', ['--version'])
  rows.push(['dws CLI', dwsVersion.ok ? dwsVersion.stdout.trim() || '(无输出)' : `✗ ${dwsVersion.stderr.trim() || '未找到 dws —— npm i -g dingtalk-workspace-cli'}`])

  if (dwsVersion.ok) {
    const authStatus = await capture('dws', ['auth', 'status', '--format', 'json'])
    rows.push(['dws 授权', authStatus.ok ? '✓ 已授权' : `✗ 未授权或已过期 —— 跑 dws auth login`])
  } else {
    rows.push(['dws 授权', '（跳过：CLI 未就绪）'])
  }

  rows.push(['Node', process.version])
  rows.push(['插件版本', manifest.version])
  rows.push(['写门禁', '默认全关（在 profile 的 cordis.patch.yml 里开 allowWrite / allowDelete）'])
  rows.push(['凭证来源', process.env.DWS_CLIENT_ID && process.env.DWS_CLIENT_SECRET ? '✓ 环境变量 DWS_CLIENT_ID/SECRET' : '（未设环境变量，将使用 dws 自己的登录态）'])

  const width = Math.max(...rows.map(([label]) => label.length))
  console.log('\n体检结果：\n')
  for (const [label, value] of rows) console.log(`  ${label.padEnd(width)}  ${value}`)
  console.log('\n若 dws 报 permission denied / 403：去钉钉开发者后台开通 AI 表格读写权限，')
  console.log('并把该应用加为目标 Base 的协作者（权限给到可编辑），改完需发布生效。\n')
}

const { command, profile } = parseArgs(process.argv.slice(2))
switch (command) {
  case 'install':
    await install(profile)
    break
  case 'doctor':
    await doctor()
    break
  case '--help':
  case '-h':
  case 'help':
    usage()
    break
  default:
    console.error(`未知命令：${command}\n`)
    usage()
    process.exitCode = 1
}
