/**
 * 环境自检（只读）—— `npm run doctor`
 *
 * 回答一个问题：**"现在能不能构建/加载这个插件，如果不能，缺的是哪一块。"**
 *
 * 它不修改任何文件，也不启动 DSH。检查项：
 *   ① Node 版本是否满足 engines
 *   ② 构建依赖 esbuild 是否可用（能 import 到、能拿到版本、平台二进制是否匹配）
 *   ③ 宿主源码真源（plugin-src/host/，9 个文件）是否齐全
 *   ④ 发布产物（lib/）是否在位、入口是否按 package.json 声明存在
 *   ⑤ 可选依赖 qrcode（只在面板扫码绑定用到，缺失会明确降级，不算故障）
 *
 * 退出码：0 = 可构建且产物在位；1 = 有问题（逐条列出该跑什么）。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const problems = []
const notes = []

function ok(message) { console.log(`  ✓ ${message}`) }
function warn(message) { console.log(`  ! ${message}`); notes.push(message) }
function bad(message, fix) {
  console.log(`  ✗ ${message}`)
  if (fix !== undefined) console.log(`      → ${fix}`)
  problems.push(message)
}

async function exists(relativePath) {
  return (await stat(join(ROOT, relativePath)).catch(() => undefined))?.isFile() === true
}

/** 递归收集目录下的文件绝对路径（用于产物新鲜度比对）。目录不存在时返回空数组。 */
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const out = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

async function readJson(relativePath) {
  try {
    return JSON.parse(await readFile(join(ROOT, relativePath), 'utf8'))
  } catch {
    return undefined
  }
}

console.log(`\n插件环境自检：${ROOT}\n`)

// ── ① Node 版本 ───────────────────────────────────────────────────────────
const manifest = await readJson('package.json')
console.log('① Node 与包元数据')
if (manifest === undefined) {
  bad('package.json 读不到或不是合法 JSON', '检查文件是否损坏')
} else {
  const required = String(manifest.engines?.node ?? '>=0').replace(/^[^\d]*/u, '')
  const [major, minor] = process.versions.node.split('.').map(Number)
  const [needMajor, needMinor] = required.split('.').map(Number)
  const satisfies = major > needMajor || (major === needMajor && minor >= (needMinor || 0))
  if (satisfies) ok(`Node ${process.versions.node}（要求 ${manifest.engines?.node}）`)
  else bad(`Node ${process.versions.node} 不满足 engines: ${manifest.engines?.node}`, '升级 Node 后重试')
  ok(`包名 ${manifest.name}@${manifest.version}，入口 main = ${manifest.main}`)

  const entry = String(manifest.main ?? '').replace(/^\.\//u, '')
  if (entry !== '') {
    if (await exists(entry)) ok(`入口存在：${entry}`)
    else bad(`package.json 声明的入口不存在：${entry}`,
      '跑 `npm run build`（首次需先 `npm install` 装上 esbuild）')
  }
}

// ── ② 构建依赖 esbuild ────────────────────────────────────────────────────
console.log('\n② 构建依赖 esbuild')
let esbuildUsable = false
try {
  const esbuild = await import('esbuild')
  const version = esbuild.version ?? '(未报告版本)'
  ok(`可 import，版本 ${version}`)
  esbuildUsable = true
  if (process.platform === 'win32') {
    const binary = join(ROOT, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
    if (await exists(join('node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'))) {
      ok(`平台二进制在位：${binary}`)
    } else {
      warn('未找到 @esbuild/win32-x64/esbuild.exe —— 若构建时报"二进制缺失"，跑 `npm install` 重装')
    }
  }
} catch (error) {
  bad(`import 失败：${error?.code ?? error?.message ?? error}`,
    '在本目录跑 `npm install`（esbuild 是 devDependency，构建必需）')
}

// ── ③ 宿主源码真源 ────────────────────────────────────────────────────────
console.log('\n③ 宿主源码真源 plugin-src/host/')
const HOST_SOURCES = [
  'index.mjs', 'endpoints.mjs', 'client.mjs', 'export.mjs',
  'scan.mjs', 'jobs.mjs', 'scheduler.mjs', 'rpc.mjs', 'accounts.mjs',
]
const missingSources = []
for (const name of HOST_SOURCES) {
  if (!await exists(join('plugin-src', 'host', name))) missingSources.push(name)
}
if (missingSources.length === 0) ok(`${HOST_SOURCES.length} 个源文件齐全`)
else bad(`缺少源文件：${missingSources.join('、')}`, '从版本库恢复（plugin-src/ 是唯一真源，不可再生）')

if (await exists(join('plugin-src', 'client', 'impl.mjs'))) ok('客户端实现 plugin-src/client/impl.mjs 在位')
else bad('缺少 plugin-src/client/impl.mjs', '从版本库恢复——这是客户端唯一真源')

// ── ④ 发布产物 ────────────────────────────────────────────────────────────
console.log('\n④ 发布产物 lib/')
const libDir = await stat(join(ROOT, 'lib')).catch(() => undefined)
if (libDir?.isDirectory() !== true) {
  bad('lib/ 目录不存在 —— 插件当前**无法被 DSH 加载**',
    esbuildUsable
      ? '跑 `npm run build`（已具备构建条件）'
      : '先 `npm install`，再 `npm run build`')
} else {
  const produced = []
  for (const name of [...HOST_SOURCES.filter(n => n !== 'index.mjs').map(n => n), 'index.mjs', 'client.js']) {
    if (await exists(join('lib', name))) produced.push(name)
  }
  ok(`lib/ 在位，含 ${produced.length} 项产物`)

  if (produced.includes('index.mjs')) {
    const entryText = await readFile(join(ROOT, 'lib', 'index.mjs'), 'utf8')
    if (entryText.includes('由 `npm run build`') || entryText.includes('本文件由')) {
      ok('入口带"由构建生成"横幅（说明它是产物，真源在 plugin-src/）')
    } else {
      warn('入口没有构建横幅 —— 可能是手改过产物，或横幅格式变了')
    }
  } else {
    bad('lib/index.mjs 缺失（package.json 的 main 指向它）', '跑 `npm run build`')
  }

  if (produced.includes('client.js')) {
    const clientText = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')
    const kb = (Buffer.byteLength(clientText, 'utf8') / 1024).toFixed(1)
    if (clientText.trim() === '') bad('lib/client.js 是空文件', '跑 `npm run build`（它会重建整个 lib/）')
    else ok(`lib/client.js ${kb} KB`)
  } else {
    bad('lib/client.js 缺失（dsh.client 需要它，面板会不可用）', '跑 `npm run build`')
  }

  // 产物新鲜度：真源改过但没重建 ⇒ DSH 加载的是旧代码，症状是"我明明改了却没生效"
  const newestSource = Math.max(...(await Promise.all(
    ['plugin-src/host', 'plugin-src/client'].map(async directory => {
      const files = await walk(join(ROOT, directory))
      const times = await Promise.all(files.map(f => stat(f).then(s => s.mtimeMs).catch(() => 0)))
      return times.length === 0 ? 0 : Math.max(...times)
    }),
  )))
  const oldestArtifact = Math.min(...(await Promise.all(
    produced.map(name => stat(join(ROOT, 'lib', name)).then(s => s.mtimeMs).catch(() => Number.MAX_SAFE_INTEGER)),
  )))
  if (newestSource > oldestArtifact) {
    const driftMinutes = ((newestSource - oldestArtifact) / 60000).toFixed(1)
    bad(
      `产物落后于真源（真源比产物新 ${driftMinutes} 分钟）—— DSH 现在加载的是旧代码`,
      '跑 `npm run build` 重建；改过 plugin-src/ 之后必须重建才生效',
    )
  } else {
    ok('产物不比真源旧（无需重建）')
  }
}

// ── ⑤ 可选依赖 qrcode ─────────────────────────────────────────────────────
console.log('\n⑤ 可选依赖 qrcode（仅面板「扫码绑定」用）')
try {
  await import('qrcode')
  ok('解析成功 —— 面板会显示二维码')
} catch {
  warn('解析不到 —— 面板会降级为"只显示深链 + 授权码"，授权流程仍可完成（这是设计内的降级）')
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log('')
if (problems.length > 0) {
  console.log(`✗ 自检发现 ${problems.length} 个问题：`)
  for (const item of problems) console.log(`  · ${item}`)
  console.log('')
  process.exit(1)
}
console.log(`✓ 自检通过${notes.length > 0 ? `（另有 ${notes.length} 条提示，非阻塞）` : ''}`)
console.log('  下一步：npm run check（build + test + verify），然后重启 dsh web\n')
