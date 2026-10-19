/**
 * 发布契约校验 —— `npm run verify`（CI 会跑）。
 *
 * 校验的不是"代码对不对"，而是**发布形态有没有被破坏**。所有断言都来自真实踩过的坑，
 * 不是形式主义：任何一条红，都意味着"发布出去会出问题"。
 *
 *   ① 必需文件齐全（源码 + 构建产物 + 对外文档）
 *   ② 任何依赖节与 lock 文件都不得出现 @deepseek-ai/dsh-*
 *      —— DSH 运行时包用**模块局部 Symbol** 做 key，装第二份物理副本会破坏 Host 查找
 *   ③ 客户端产物必须注册正确的装载器 id
 *   ④ 客户端产物必须注册正确的设置面板契约（id / order / label）
 *   ⑤ 客户端产物不得含 ESM 语法（lib/ 是 esbuild 产物，不是源码）
 *   ⑥ RPC 端点名在宿主真源、客户端真源、客户端产物三处必须一致
 *      —— 曾因响应信封形状不一致导致面板渲染空壳而 RPC 不报错，端点名漂移同理致命
 *   ⑦ 全仓不得含个人绝对路径与凭证赋值；可选叠加私有词表扫描（⑦-2）
 *      —— 公开发布前必须清掉；这条防的是"忘了清就 publish"
 *         私有词表经环境变量 DSH_PRIVATE_TERMS 挂入，词表本身放仓库外，
 *         避免"防泄漏的机制自己成为泄漏源"
 *   ⑧ files 白名单必须自洽（条目在磁盘上存在 + 生命周期脚本引用的文件已入包 + 入口文件已入包）
 *      ＋ **安装期脚本禁则**：不得声明 preinstall / install / postinstall
 *        —— pnpm 10+ 默认拦截依赖的安装期脚本，会让消费者侧安装**直接失败**
 *      —— **本地 link: 装载时 files 完全不生效**，漏件在开发机上永远看不见；
 *         一旦 npm publish，安装方 postinstall 找不到文件 → npm install 直接失败
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { containsMarker, decodeEscapes } from './bundle-markers.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const failures = []

function check(condition, message) {
  if (!condition) failures.push(message)
}

async function readIfExists(relativePath) {
  try {
    return await readFile(resolve(ROOT, relativePath), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** 读 JSON；缺失或语法错都转成一条可读的校验失败，而不是抛栈崩掉整个校验。 */
async function readJson(relativePath) {
  const text = await readIfExists(relativePath)
  if (text === undefined) {
    failures.push(`缺少必需文件：${relativePath}`)
    return {}
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    failures.push(`${relativePath} 不是合法 JSON：${error.message}`)
    return {}
  }
}

// ── ① 必需文件 ────────────────────────────────────────────────────────────
const HOST_SOURCES = [
  'index.mjs', 'endpoints.mjs', 'client.mjs', 'export.mjs',
  'scan.mjs', 'jobs.mjs', 'scheduler.mjs', 'rpc.mjs', 'accounts.mjs',
]
const REQUIRED = [
  // 构建产物（宿主入口保留 .mjs —— lib/ 里是真 ESM，这个扩展名是准确描述；
  // 客户端产物是 esbuild 输出，按包内约定用 .js 供 dsh.client 引用）
  'lib/index.mjs',
  'lib/client.js',
  // 客户端源码（wrapper + 实现）
  'plugin-src/client/index.mjs',
  'plugin-src/client/impl.mjs',
  // 宿主源文件
  ...HOST_SOURCES.map(name => `plugin-src/host/${name}`),
  // 构建、校验与诊断脚本
  'scripts/build.mjs',
  'scripts/bundle-markers.mjs',
  'scripts/verify-package.mjs',
  'scripts/inspect-bundle.mjs',
  'scripts/doctor.mjs',
  'scripts/postinstall.mjs',
  // 配置
  'cordis.patch.yml',
  // 对外文档与法务件
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'CONTEXT.md',
  'THIRD_PARTY_NOTICES.md',
  // 门面文档（对照 dsh-im 的文档形态：安装手册 + ADR + 逐次实测留痕）
  'docs/README.md',
  'docs/安装与前置条件.md',
  'docs/发布与版本管理.md',
  'docs/adr/0001-从手搓REST改为包装dws.md',
  'docs/images/README.md',
  // 品牌资产
  'assets/README.md',
  'assets/logo.svg',
  'assets/logo-readme.svg',
]

for (const relativePath of REQUIRED) {
  const info = await stat(resolve(ROOT, relativePath)).catch(() => undefined)
  check(info?.isFile() === true, `缺少必需文件：${relativePath}`)
}

// ── ② 依赖禁则（四节 + bundleDependencies + lock）─────────────────────────
const FORBIDDEN = /^@deepseek-ai\/dsh-/
const manifest = await readJson('package.json')
for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const name of Object.keys(manifest[section] ?? {})) {
    check(!FORBIDDEN.test(name),
      `${name} 不得出现在 ${section} —— DSH 运行时包必须由 Host 提供；`
      + '装第二份物理副本会用模块局部 Symbol 破坏 Host 查找')
  }
}
for (const name of manifest.bundleDependencies ?? manifest.bundledDependencies ?? []) {
  check(!FORBIDDEN.test(name), `${name} 不得被打包（bundleDependencies）—— 必须来自 Host`)
}
const lockText = await readIfExists('package-lock.json')
if (lockText === undefined) {
  check(false, '缺少 package-lock.json —— CI 用 npm ci 需要它（本仓为离线占位，请在本机跑一次 npm install 生成真实 lock）')
} else {
  try {
    const lock = JSON.parse(lockText)
    const offenders = Object.keys(lock.packages ?? {})
      .filter(path => /(?:^|\/)node_modules\/@deepseek-ai\/dsh-[^/]+(?:\/|$)/.test(path))
    check(offenders.length === 0, `package-lock.json 不得安装 DSH 运行时包：${offenders.join(', ')}`)
  } catch (error) {
    check(false, `package-lock.json 不是合法 JSON：${error.message}`)
  }
}

// ── ③④⑤ 客户端产物契约 ───────────────────────────────────────────────────
const clientBundle = await readIfExists('lib/client.js')
const clientSource = await readIfExists('plugin-src/client/impl.mjs')
if (clientBundle === undefined) {
  check(false, 'lib/client.js 不存在 —— 先跑 npm run build（首次需先 npm install，构建依赖 esbuild）')
} else if (clientBundle.trim() === '') {
  check(false, 'lib/client.js 是空文件 —— 这是改造留下的占位，请跑 npm run build 生成真产物'
    + '（首次需先 npm install 装上 esbuild，再 npm run build）')
} else {
  // 产物形态不合格时，把体量打出来 —— 0 字节 / 半截产物与"契约漂移"是两类完全不同的病，
  // 不带这个信息就会误判成后者。
  const bundleKb = (Buffer.byteLength(clientBundle, 'utf8') / 1024).toFixed(1)
  const bundleSizeHint = `（实测 ${bundleKb} KB）`
  const escapeHint = ' —— 若确认是 esbuild 把中文转义了，请跑 `npm run inspect` 复核'
  // 客户端侧的面板 id 与 RPC 端点名同为 'dsh-dingtalk-connector'，此处只断一次存在性即可。
  const panelAndRpcPresent = containsMarker(clientBundle, 'dsh-dingtalk-connector')

  check(containsMarker(clientBundle, '@yiyunet/dsh-dingtalk-connector'),
    `lib/client.js 未注册装载器 id（应为 @yiyunet/dsh-dingtalk-connector）${bundleSizeHint}`)

  check(panelAndRpcPresent,
    `lib/client.js 未注册设置面板 id / RPC 端点名（应为 dsh-dingtalk-connector）${bundleSizeHint}`)
  check(/\border\s*:\s*22\b/u.test(decodeEscapes(clientBundle)),
    `lib/client.js 的设置面板 order 不是 22（与官方 IM 面板 order=21 的排序约定）${bundleSizeHint}`)
  check(containsMarker(clientBundle, 'settings.section'),
    `lib/client.js 未注册设置面板挂载点（settings.section）${bundleSizeHint}`)
  check(containsMarker(clientBundle, '钉钉文档'),
    `lib/client.js 未注册设置面板 label「钉钉文档」${bundleSizeHint}${escapeHint}`)

  check(!/^\s*(?:import|export)\s/mu.test(clientBundle),
    'lib/client.js 含 ESM 顶层 import/export —— 它是 esbuild 产物，出现源码语法说明有人直接改过产物')

  // 交叉验证：源码里的面板 label 与产物里的一致（防"改了源码没重新 build"）
  if (clientSource !== undefined && containsMarker(clientSource, '钉钉文档')
    && !containsMarker(clientBundle, '钉钉文档')) {
    check(false, '源码 impl.mjs 有「钉钉文档」但产物没有 —— 产物过期，重跑 npm run build')
  }
}

if (clientSource !== undefined) {
  check(/\bexport\s+const\s+inject\s*=/u.test(clientSource),
    'plugin-src/client/impl.mjs 未导出模块契约 inject')
  check(/\bexport\s+function\s+apply\b/u.test(clientSource),
    'plugin-src/client/impl.mjs 未导出模块契约 apply')
}

// ── ⑥ RPC 端点名三处一致 ──────────────────────────────────────────────────
const hostRpc = await readIfExists('plugin-src/host/rpc.mjs')
const hostEndpoint = /RPC_ENDPOINT\s*=\s*['"]([^'"]+)['"]/u.exec(hostRpc ?? '')?.[1]
const clientEndpoint = /RPC_ENDPOINT\s*=\s*['"]([^'"]+)['"]/u.exec(clientSource ?? '')?.[1]
check(typeof hostEndpoint === 'string' && hostEndpoint !== '',
  'plugin-src/host/rpc.mjs 未声明 RPC_ENDPOINT')
check(typeof clientEndpoint === 'string' && clientEndpoint !== '',
  'plugin-src/client/impl.mjs 未声明 RPC_ENDPOINT')
check(hostEndpoint === clientEndpoint,
  `RPC 端点名不一致：宿主「${hostEndpoint}」 vs 客户端「${clientEndpoint}」—— 面板会静默失效`)
check(clientBundle === undefined || clientBundle.trim() === '' || containsMarker(clientBundle, clientEndpoint ?? '\u0000'),
  `lib/client.js 里找不到端点名「${clientEndpoint}」—— 产物可能过期，重跑 npm run build`)

// ⑦ 客户端默认导出目录：宿主下发，客户端不得硬编码
if (clientSource !== undefined) {
  check(clientSource.includes('defaultExportDir'),
    'plugin-src/client/impl.mjs 未读取宿主下发的 defaultExportDir（客户端不得硬编码导出路径）')
}
const hostIndex = await readIfExists('plugin-src/host/index.mjs')
check((hostIndex ?? '').includes('defaultExportDir'),
  'plugin-src/host/index.mjs 未向面板下发 defaultExportDir')

// ── ⑦ 敏感信息扫描 ────────────────────────────────────────────────────────
const SCAN_FILES = [
  'package.json', 'cordis.patch.yml', 'README.md', 'README.en.md',
  'CONTEXT.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
  'docs/README.md', 'docs/安装与前置条件.md', 'docs/发布与版本管理.md',
  'docs/adr/0001-从手搓REST改为包装dws.md',
  'docs/实测/2026-09-14-钉钉AI表格实测记录.md',
  'docs/images/README.md',
  'plugin-src/client/index.mjs', 'plugin-src/client/impl.mjs',
  ...HOST_SOURCES.map(name => `plugin-src/host/${name}`),
  'scripts/build.mjs', 'scripts/verify-package.mjs',
]
const SENSITIVE = [
  { pattern: /[A-Za-z]:[\\/]{1,2}Users[\\/][A-Za-z0-9._-]+/u, label: 'Windows 个人绝对路径' },
  { pattern: /\/Users\/[A-Za-z0-9._-]+\//u, label: 'macOS 个人绝对路径' },
  { pattern: /\/home\/[A-Za-z0-9._-]+\//u, label: 'Linux 个人绝对路径' },
  { pattern: /\bclientSecret\s*[:=]\s*['"][A-Za-z0-9_\-+/=]{16,}['"]/u, label: '疑似硬编码凭证' },
]
// 产物同扫：消费者装的是 `lib/`，个人绝对路径与硬编码凭证在那里同样不许出现。
const libFiles = (await readdir(resolve(ROOT, 'lib'), { withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isFile() && /\.(?:mjs|cjs|js|json|md)$/iu.test(entry.name))
  .map(entry => `lib/${entry.name}`)
for (const relativePath of [...SCAN_FILES, ...libFiles]) {
  const text = await readIfExists(relativePath)
  if (text === undefined) continue
  for (const { pattern, label } of SENSITIVE) {
    if (pattern.test(text)) failures.push(`${relativePath} 命中敏感模式（${label}）—— 发布前必须清除`)
  }
}

// ── ⑦-2 私有词表扫描（可选，由发布者用环境变量挂入）──────────────────────
// 公开仓库不得出现内部信息（组织名、人名、内部路径、内部代号）。
// 词表**刻意不做成仓内文件**：scripts/ 在 package.json 的 files 白名单里，
// 放进去会被原样打进发布包 —— 那就成了"防泄漏的机制自己泄漏"。
// 因此改为由环境变量指向一份仓库外的私有词表：DSH_PRIVATE_TERMS=/abs/path/terms.txt
// 未设置时本项跳过（CI 上不会设置，因此 CI 永远不接触这些词）。
/** 把产物里的 `\uXXXX` 转义还原成明文 —— esbuild 会把中文字符串转义，直接搜原文必然漏。 */
const decodeEscaped = text => text.replace(/\\u([0-9A-Fa-f]{4})/gu, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))

const privateTermsPath = (process.env.DSH_PRIVATE_TERMS || '').trim()
if (privateTermsPath === '') {
  console.log('  ⚠️ 私有词表扫描：跳过（未设置 DSH_PRIVATE_TERMS）—— 发布前必须设置，否则本项等于没跑')
} else {
  const privateTermsText = await readFile(privateTermsPath, 'utf8').catch(() => undefined)
  if (privateTermsText === undefined) {
    failures.push(`DSH_PRIVATE_TERMS 指向的文件读不到：${privateTermsPath}`)
  } else {
    const terms = privateTermsText
      .split(/\r?\n/u)
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'))
    // `lib/` 必须扫：消费者拿到的是产物，源码干净不代表产物干净（改了源码不重建，
    // 发布出去的仍是旧内容 —— 这正是 1.0.2 漏出品牌名的路径）。
    const SKIP_DIRS = new Set(['node_modules', '.git', '.lib-staging', '.lib-backup', 'dingtalk-export'])
    const TEXT_EXT = /\.(?:md|mjs|cjs|js|json|ya?ml|txt|svg|html?)$/iu
    const collect = async (dir, prefix = '') => {
      const out = []
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          out.push(...await collect(resolve(dir, entry.name), `${prefix}${entry.name}/`))
        } else if (TEXT_EXT.test(entry.name)) {
          out.push(`${prefix}${entry.name}`)
        }
      }
      return out
    }
    for (const relativePath of await collect(ROOT)) {
      const text = await readIfExists(relativePath)
      if (text === undefined) continue
      for (const term of terms) {
        if (text.includes(term) || decodeEscaped(text).includes(term)) {
          failures.push(`${relativePath} 命中私有词表条目「${term}」—— 公开仓库不得包含内部信息，发布前必须清除`)
        }
      }
    }
  }
}

// ── ⑧ 发布白名单自洽（files ⟷ 磁盘 ⟷ 生命周期脚本 ⟷ 入口）────────────────
// 为什么必须有这条：`files` 白名单曾漏掉 scripts/，而 package.json 声明了
// `postinstall: node scripts/postinstall.mjs`。因为开发机走 link: 软链装载，
// files 字段根本不生效 —— 这个缺陷在开发机上**永远不会显形**，
// 直到 npm publish 之后，安装方的 postinstall 找不到文件，npm install 直接失败。
const filesWhitelist = Array.isArray(manifest.files) ? manifest.files : []
check(filesWhitelist.length > 0,
  'package.json 缺少 files 白名单 —— 发布时会把 node_modules 之外的杂物一并带上')

// ⑧-1 白名单里的每一条，磁盘上必须真的存在
for (const entry of filesWhitelist) {
  const info = await stat(resolve(ROOT, entry)).catch(() => undefined)
  check(info !== undefined,
    `files 白名单里的「${entry}」在仓库中不存在 —— 发布产物会缺件（npm 只会给个易忽略的警告）`)
}

// ⑧-2 生命周期脚本引用的本地文件，其所在目录必须进了白名单
const LIFECYCLE_HOOKS = [
  'preinstall', 'install', 'postinstall',
  'prepack', 'postpack', 'prepare', 'prepublishOnly',
]
for (const hook of LIFECYCLE_HOOKS) {
  const command = manifest.scripts?.[hook]
  if (typeof command !== 'string') continue
  for (const match of command.matchAll(/(?:^|\s)((?:\.\/)?scripts\/[^\s'"]+|(?:\.\/)?bin\/[^\s'"]+)/gu)) {
    const referenced = match[1].replace(/^\.\//u, '')
    const topLevel = referenced.split('/')[0]
    check(filesWhitelist.includes(topLevel) || filesWhitelist.includes(referenced),
      `${hook} 引用了「${referenced}」，但 files 白名单里既没有「${topLevel}」也没有该路径 —— `
      + '本地 link: 装载时问题不显形，npm publish 后安装方会因找不到该文件而 install 失败')
  }
}

// ⑧-3 package.json 对外声明的入口，必须都在白名单内
// （main / exports 的字符串目标 / bin / dsh.client 的显式入口）
//
// 例外：npm 无论 files 怎么写都**强制包含** package.json 与 README* / LICENSE* / LICENCE*，
// 所以这些不必（也不该）出现在白名单里 —— 不加豁免会在这里误报。
const ALWAYS_PACKED = /^(?:package\.json|readme(?:\..*)?|licen[cs]e(?:\..*)?)$/iu
const declaredEntries = [
  manifest.main,
  ...Object.values(manifest.exports ?? {}).filter(target => typeof target === 'string'),
  ...Object.values(manifest.bin ?? {}),
  typeof manifest.dsh?.client?.entry === 'string' ? manifest.dsh.client.entry : undefined,
].filter(target => typeof target === 'string' && target !== '')

for (const entry of declaredEntries) {
  const normalized = entry.replace(/^\.\//u, '')
  const basename = normalized.split('/').at(-1) ?? normalized
  if (ALWAYS_PACKED.test(basename)) continue
  const topLevel = normalized.split('/')[0]
  check(filesWhitelist.includes(normalized) || filesWhitelist.includes(topLevel),
    `package.json 声明的入口「${entry}」不在 files 白名单内 —— 发布后该入口会缺失`)
}

// ⑧-4 安装期脚本禁则
// 为什么：pnpm 10+ 默认**拦截依赖的安装期脚本**（供应链防护）。一旦本包声明
// `postinstall`，消费者用 pnpm 安装时会直接报 `ERR_PNPM_IGNORED_BUILDS` 并中断安装
// —— 实测（macOS + pnpm 11.24.0）`dsh plugin add` 就是因此失败的。
// 构建自动化必须走 `prepare`：它对 registry 依赖根本不执行，故不在拦截范围内，
// 但在开发安装 / git 依赖安装 / 发布前照常执行。
for (const hook of ['preinstall', 'install', 'postinstall']) {
  check(!(hook in (manifest.scripts ?? {})),
    `package.json 不得声明 \`${hook}\` —— pnpm 10+ 对依赖的安装期脚本默认拦截，`
    + '会让消费者侧安装**直接失败**（ERR_PNPM_IGNORED_BUILDS）。构建自动化请改用 `prepare`')
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`✗ 发布契约校验失败（${failures.length} 项）：\n`)
  for (const message of failures) console.error(`  · ${message}`)
  console.error('\n八类断言：必需文件 / 依赖禁则 / 装载器 id / 面板契约 / 产物无 ESM 语法 / RPC 端点一致 / 敏感信息 / 发布白名单自洽')
  process.exit(1)
}
console.log('✓ 发布契约校验通过（必需文件 · 依赖禁则 · 装载器 id · 面板契约 · 产物无 ESM · RPC 端点一致 · 敏感信息 · 发布白名单自洽）')
