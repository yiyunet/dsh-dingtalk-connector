/**
 * 构建脚本 —— 生成 lib/（发布产物）。唯一真源在 plugin-src/。
 *
 *   npm run build          # 全量构建
 *   npm run build:host     # 只构建宿主半侧
 *   npm run build:client   # 只构建客户端半侧
 *
 * ── 宿主半侧（plugin-src/host/ → lib/）────────────────────────────────
 *   纯 ESM，**不做转换**，只做两件事：
 *     ① 逐文件复制到 lib/（保持相对导入结构不变）
 *     ② 在每个文件头上加「本文件由构建生成」横幅 → 直接改 lib/ 会在下次构建时被覆盖
 *   之所以复制而不是 re-export：发布物与源码同构、可被 DSH 插件加载器直接解析，
 *   且 `lib/index.mjs` 是一个**真实文件**（避免 re-export 把入口解析链拉长；
 *   保留 `.mjs` 是因为 lib/ 里确实全是 ESM，这个扩展名比 `.js` 更准确）。
 *
 * ── 客户端半侧（plugin-src/client/ → lib/client.js）──────────────────
 *   1. esbuild 把 impl.mjs 打成 IIFE（globalName = __DshDingtalkConnector）
 *   2. 把 plugin-src/client/index.mjs（手写装载器 wrapper）套在外面
 *   → 产出 `window.__ModuleLoader__.load({ id, factory })`，与官方客户端模块系统同形。
 *
 *   打包产物**独占一行**，因此 wrapper 的行号不受影响。
 *
 * ⚠️ react / react-dom 必须保持 external：它们由平台冻结模块表提供，
 *    通过 factory 注入的 require 在**运行时**解析。打进来会与宿主 React 冲突。
 */
import { builtinModules } from 'node:module'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { runInNewContext } from 'node:vm'

import * as esbuild from 'esbuild'

import { auditMarkers } from './bundle-markers.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_HOST = join(ROOT, 'plugin-src', 'host')
const SRC_CLIENT = join(ROOT, 'plugin-src', 'client')
const LIB = join(ROOT, 'lib')
/** 构建暂存区：先造到这里，全部成功后才替换 lib/（见文件末尾的装配策略说明）。 */
const STAGING = join(ROOT, '.lib-staging')

/** 打包产物的全局名。wrapper（plugin-src/client/index.mjs）按这个名字取用。 */
const CLIENT_GLOBAL = '__DshDingtalkConnector'

/** 客户端只允许这些外部模块（其余一律打包进来或直接报错）。 */
const CLIENT_EXTERNAL = ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client']

/**
 * 瞬时文件锁退避重试 —— Windows 特有痛点的根治。
 *
 * 为什么需要：Windows 上 `rename()` 底层走 MoveFileEx，只要**源目录内任一文件**（或目标路径）
 * 被其它进程持有句柄，就返回 ERROR_ACCESS_DENIED → Node 报 `EPERM`。杀软实时扫描、Windows
 * 搜索索引器、编辑器与宿主进程的文件监听，都会在「刚写入的目录」上制造**毫秒到秒级**的瞬时占用。
 *
 * 实测（2026-09-14，Windows）：同一条命令连续 4 次里 **2 次 EPERM、2 次成功**；失败后立刻重跑即通过。
 * **POSIX 允许重命名已被打开的目录，故 Linux CI 从不触发本问题** —— 这是 Windows 开发机特有现象。
 *
 * 不重试的代价：把「等一秒就好」变成「构建失败」，进而让 `prepublishOnly` **中止整个发布流程**。
 * 而下面的原子替换设计本就是为了抗失败 —— 在最后一步功亏一篑最冤。
 *
 * @param {() => Promise<unknown>} operation 要执行的文件操作
 * @param {string} what 失败时用于指名道姓的说明（写「做什么」，不要写「失败了」）
 */
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function withTransientRetry(operation, what, { attempts = 6, baseDelayMs = 200 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const code = error?.code
      // 非瞬时错误（如路径不存在、参数错）立即抛出，不被退避拖慢
      if (!TRANSIENT_FS_CODES.has(code)) throw error
      if (attempt >= attempts) {
        throw new Error(
          `${what} 失败：连续 ${attempts} 次遇到瞬时文件锁（${code}）。\n`
          + '  · 常见原因：杀毒软件实时扫描 / Windows 搜索索引器 / 其它进程正持有该目录句柄\n'
          + '    （例如正在加载本插件的宿主进程 DSH）\n'
          + '  · 处理：关掉占用该目录的程序后重跑 `npm run build`；'
          + '或把本仓库目录加入杀毒软件排除项\n'
          + `  · 原始错误：${error.message}`,
        )
      }
      // 线性退避 200→400→600→800→1000ms（累计约 3s）：够覆盖杀软扫描窗口，
      // 又不至于让真正的权限问题拖太久才报出来。
      // 每次重试都出声 —— 否则补丁只是"悄悄生效"，事后无从判断它到底有没有用。
      console.warn(
        `  · 瞬时文件锁（${code}）：${what}`
        + ` → ${baseDelayMs * attempt}ms 后重试（第 ${attempt} 次，最多 ${attempts - 1} 次）`,
      )
      await new Promise(resolveDelay => { setTimeout(resolveDelay, baseDelayMs * attempt) })
    }
  }
}

const GENERATED_BANNER = name =>
  `// ⚠️ 本文件由 \`npm run build\` 从 plugin-src/ 生成 —— 请勿直接编辑。\n`
  + `// 真源：plugin-src/${name}\n`

const BUILTIN_SPECIFIERS = new Set([
  ...builtinModules,
  ...builtinModules.map(name => `node:${name}`),
])

/** 递归收集目录下的文件（返回相对 ROOT 的路径）。 */
async function walk(directory) {
  const out = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...await walk(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** 从 ESM 源码里抽出所有 import 的裸模块名（用于"客户端只能引 react"这类断言）。 */
function bareImportsOf(source) {
  const names = new Set()
  const patterns = [
    /^\s*import\s+[^'"]*?from\s*['"]([^'"]+)['"]/gmu,
    /^\s*import\s*['"]([^'"]+)['"]/gmu,
    /^\s*export\s+[^'"]*?from\s*['"]([^'"]+)['"]/gmu,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1])
  }
  return [...names].filter(specifier => !specifier.startsWith('.') && !specifier.startsWith('/'))
}

/** 构建宿主半侧：复制 + 校验（不改写内容，只加横幅）。 */
async function buildHost() {
  const files = await walk(SRC_HOST)
  if (files.length === 0) throw new Error('plugin-src/host/ 是空的');

  const entryRelative = 'index.mjs'
  if (!files.some(file => relative(SRC_HOST, file) === entryRelative)) {
    throw new Error(`plugin-src/host/${entryRelative} 不存在 —— 宿主入口缺失，发布物会是空的`)
  }

  const notices = []
  for (const file of files) {
    const relativePath = relative(SRC_HOST, file)
    const source = await readFile(file, 'utf8')

    // 宿主半侧不得 import 客户端专用模块（react / DOM API 都在浏览器侧）
    for (const specifier of bareImportsOf(source)) {
      if (BUILTIN_SPECIFIERS.has(specifier)) continue
      if (specifier === '@deepseek-ai/dsh-tools') continue      // 由 Host 运行时提供
      if (specifier.startsWith('@deepseek-ai/')) continue
      notices.push(`${relativePath} imports "${specifier}" —— 请确认该包在 dependencies 中声明`)
    }

    const target = join(STAGING, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, GENERATED_BANNER(`host/${relativePath}`) + source, 'utf8')
  }

  // 自证：入口必须真的落盘（verify 会先断这一条，与其事后被抓，不如构建时自己先说）
  const entryTarget = join(STAGING, entryRelative)
  const entryStat = await stat(entryTarget).catch(() => undefined)
  if (entryStat === undefined || !entryStat.isFile()) {
    throw new Error(`lib/${entryRelative} 写出后不存在（目标路径：${entryTarget}）`)
  }

  return { count: files.length, notices, entry: `lib/${entryRelative}` }
}
/** 构建客户端半侧：esbuild 打包 impl → IIFE，再套上手写 wrapper。 */
async function buildClient() {
  const wrapper = await readFile(join(SRC_CLIENT, 'index.mjs'), 'utf8')
  const entry = join(SRC_CLIENT, 'impl.mjs')

  // 前置断言：客户端实现只能引 react 系（其余依赖要显式加进 CLIENT_EXTERNAL 并确认平台表里有）
  for (const specifier of bareImportsOf(await readFile(entry, 'utf8'))) {
    if (!CLIENT_EXTERNAL.includes(specifier)) {
      throw new Error(
        `plugin-src/client/impl.mjs 引入了非白名单模块 "${specifier}"。\n`
        + `平台冻结模块表只保证 ${CLIENT_EXTERNAL.join(' / ')}。\n`
        + `若确需引入，请先确认平台表提供该模块，再加进 scripts/build.mjs 的 CLIENT_EXTERNAL。`,
      )
    }
  }

  let result
  try {
    result = await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'iife',
      globalName: CLIENT_GLOBAL,
      platform: 'browser',
      target: 'esnext',
      external: CLIENT_EXTERNAL,
      legalComments: 'none',
      write: false,
      logLevel: 'warning',
    })
  } catch (error) {
    // esbuild 把真正的诊断放在 error.errors（结构化）里，message 常常只有一句
    // "Build failed with 1 error:"。不展开的话使用者只能看到一个空壳报错。
    const details = Array.isArray(error?.errors) && error.errors.length > 0
      ? error.errors
        .map(item => `  · ${item.text}${item.location === undefined ? '' : ` (${item.location.file}:${item.location.line}:${item.location.column})`}`)
        .join('\n')
      : `  · ${error?.message ?? error}`
    const hint = error?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find package 'esbuild'/.test(String(error?.message))
      ? '\n提示：构建依赖 esbuild，请先在本目录跑 `npm install`。'
      : ''
    throw new Error(`esbuild 打包失败：\n${details}${hint}`)
  }

  const outputFiles = result?.outputFiles ?? []
  if (outputFiles.length === 0) {
    throw new Error('esbuild 没有产出任何文件（write:false 下 outputFiles 为空）—— 打包器输出契约变了')
  }
  const bundled = outputFiles[0].text.trimEnd()
  if (!bundled.includes(CLIENT_GLOBAL)) {
    throw new Error(`打包产物里没有出现全局名 ${CLIENT_GLOBAL} —— esbuild 输出形态可能变了`)
  }

  // 关键：bundle 必须插进 wrapper 的 factory 内部，不能放在外面。
  // impl.mjs 顶层就有 require("react")（esbuild 把 external 依赖提升到模块顶部），
  // 而 DSH 的 require 只作为 factory 的参数存在 —— 放在 factory 外层会在顶层执行到
  // require，被 esbuild 的 __require 垫片拒绝（Dynamic require of "react" is not supported），
  // 进而让整个 /plugins 拼接 bundle 全灭（表现为 @deepseek-ai/dsh-client-connection 未注册）。
  const BUNDLE_PLACEHOLDER = '// __DSH_CLIENT_BUNDLE__'
  if (!wrapper.includes(BUNDLE_PLACEHOLDER)) {
    throw new Error(
      `plugin-src/client/index.mjs 缺少占位符 ${BUNDLE_PLACEHOLDER} —— `
      + '客户端 wrapper 必须把 esbuild 产物放在 factory 内部（见该文件头注释）。',
    )
  }
  const output = wrapper.replace(BUNDLE_PLACEHOLDER, bundled)
  await mkdir(STAGING, { recursive: true })
  await writeFile(join(STAGING, 'client.js'), output, 'utf8')

  // 自证：回读三件事（存在 / 非空 / 契约串在）—— 构建自己的产物也要验，不靠"没报错"下结论。
  // ⚠️ 匹配必须容忍转义：esbuild 会把中文写成 \uXXXX，直接 includes() 会漏掉正确产物。
  const written = await readFile(join(STAGING, 'client.js'), 'utf8')
  if (written.trim() === '') throw new Error('lib/client.js 写出后为空 —— 写入环节异常')

  const required = [
    { label: 'esbuild 全局名', needle: CLIENT_GLOBAL },
    { label: '装载器 id', needle: '@yiyunet/dsh-dingtalk-connector' },
    { label: '面板契约', needle: 'settings.section' },
    { label: '面板 label', needle: '钉钉文档' },
    { label: 'RPC 端点名', needle: 'dsh-dingtalk-connector' },
  ]
  const { missing, escapedOnly } = auditMarkers(written, required)
  if (missing.length > 0) {
    throw new Error(
      `lib/client.js 写出后缺少关键标记：${missing.map(item => `${item.label}「${item.needle}」`).join('、')}\n`
      + `  → 跑 \`npm run inspect\` 看产物实况；若源码里也没有该串，那是契约漂移，改源码而非改构建。`,
    )
  }

  // 自证（装载层）：用最小 __ModuleLoader__ 桩把产物真跑一遍 ——
  // 只检查字符串是不够的：曾经出现过"产物形态看着对、但顶层执行就抛错"的情况，
  // 那样整个 /plugins 拼接 bundle 会全灭，症状却报在别的插件上（如 client-connection）。
  const registrations = []
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, TextEncoder, TextDecoder,
    navigator: { userAgent: 'node' },
    location: { href: 'http://localhost/' },
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => '' }),
    requestAnimationFrame: callback => setTimeout(callback, 0),
    document: {
      currentScript: null,
      querySelector: () => null,
      createElement: () => ({ dataset: {}, style: {}, setAttribute() {} }),
      head: { appendChild() {} },
    },
    window: { __ModuleLoader__: { mode: 'queue', load: registration => registrations.push(registration) } },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox

  try {
    // ① 脚本顶层必须能执行完：这里抛错 = esbuild 产物被放在了 factory 外面
    runInNewContext(written, sandbox, { filename: 'lib/client.js' })
  } catch (error) {
    throw new Error(
      `lib/client.js 顶层执行抛错：${error?.name}: ${error?.message}\n`
      + '  → 最常见原因：esbuild 产物没有插进 wrapper 的 factory 内部（见 buildClient 的装配注释）。'
      + '顶层执行到 require("react") 会被 __require 垫片拒绝。',
    )
  }

  if (!registrations.some(item => item?.id === '@yiyunet/dsh-dingtalk-connector')) {
    throw new Error('lib/client.js 执行后没有注册 @yiyunet/dsh-dingtalk-connector —— 装载器契约被破坏')
  }

  // ② factory 必须能物化出插件面（apply），顺带记录它 require 了哪些外部模块
  const requireCalls = []
  let face
  try {
    face = registrations[0].factory(specifier => {
      requireCalls.push(specifier)
      if (specifier === 'react') return { useState: () => [0, () => {}], createElement: () => null, Fragment: null }
      if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null }
      if (specifier === 'react-dom') return { createPortal: () => null }
      if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {} }) }
      return new Proxy({}, { get: () => () => undefined })
    })
  } catch (error) {
    throw new Error(`lib/client.js 的 factory 执行抛错：${error?.name}: ${error?.message}`)
  }
  if (typeof face?.apply !== 'function') {
    throw new Error('lib/client.js 的装载器面没有导出 apply()（客户端插件对象缺少 apply，插件不会生效）')
  }
  console.log(`  · 装载验证：顶层执行 OK，注册 OK，factory require(${requireCalls.join(', ') || 'none'})，导出 apply OK`)

  return { bytes: Buffer.byteLength(output, 'utf8'), escapedOnly }
}

const only = process.argv[2]

// ── 装配策略：先造到暂存区，成功后再原子替换 ──────────────────────────────
//
// ⚠️ 这里曾经是 `await rm(LIB)` 开头 —— 那是个**真实缺陷**：
//   删掉旧产物、新产物还没生成，中间任何失败都会让使用者**既没有新产物、也没有旧产物**。
//   对一个把 package.json 的 main 指向 lib/index.mjs 的插件来说，后果是"插件直接加载不了"，
//   而且症状出现在 DSH 启动日志里，离"构建失败"很远，极难归因。
//
// 现在：构建全程写 STAGING，只有全部通过才替换 LIB。失败时旧 lib/ 原样保留。
//
// 注：--host-only / --client-only 也走暂存区，但因为是**部分构建**，
//     替换时会以已存在的 lib/ 为基础叠加，避免把另一半产物误删。
//     （STAGING 在文件顶部与 LIB 一起声明，此处不重复声明。）
const isPartial = only === '--host-only' || only === '--client-only'

await rm(STAGING, { recursive: true, force: true })
await mkdir(STAGING, { recursive: true })
if (isPartial) await mkdir(LIB, { recursive: true })

try {
  if (only !== '--client-only') {
    const host = await buildHost()
    console.log(`✓ 宿主半侧：${host.count} 个文件 → lib/（入口 ${host.entry}）`)
    for (const notice of host.notices) console.log(`  · ${notice}`)
  }

  if (only !== '--host-only') {
    const client = await buildClient()
    console.log(`✓ 客户端半侧：lib/client.js（${(client.bytes / 1024).toFixed(1)} KB）`)
    if (client.escapedOnly.length > 0) {
      console.log(`  · 以下标记在产物里是 \\uXXXX 转义形式（esbuild 对非 ASCII 的正常处理，非故障）：`
        + client.escapedOnly.join('、'))
    }
  }

  // 只有全部构建通过才替换 —— 失败路径绝不会走到这里
  if (isPartial) {
    for (const file of await walk(STAGING)) {
      const target = join(LIB, relative(STAGING, file))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await readFile(file))
    }
    await rm(STAGING, { recursive: true, force: true })
    console.log('  · 产物已叠加写入 lib/（部分构建，另一半保留）')
  } else {
    // 原子替换 + 备份兜底：先把旧 lib/ 改名成 .lib-backup，再把暂存区改名成 lib/。
    // 这样"旧产物消失"与"新产物就位"之间只隔一次 rename（毫秒级），
    // 且任一步失败都能从 .lib-backup 还原 —— 不会出现"两份都没有"的窗口。
    const BACKUP = join(ROOT, '.lib-backup')
    await withTransientRetry(
      () => rm(BACKUP, { recursive: true, force: true }),
      '清理上一次留下的 .lib-backup',
    )
    const hadLib = await stat(LIB).then(s => s.isDirectory()).catch(() => false)
    if (hadLib) {
      await withTransientRetry(() => rename(LIB, BACKUP), '把旧 lib/ 挪成 .lib-backup')
    }
    try {
      await withTransientRetry(() => rename(STAGING, LIB), '把暂存区就位为 lib/')
    } catch (error) {
      // 回滚同样要抗瞬时锁：回滚失败会留下「没有 lib/」的最坏状态（插件加载不了），
      // 必须如实报出来 —— 不能像以前那样 `.catch(() => {})` 吞掉。
      let rollbackNote = ''
      if (hadLib) {
        try {
          await withTransientRetry(
            () => rename(BACKUP, LIB),
            '回滚 .lib-backup → lib/',
            { attempts: 3 },
          )
        } catch (rollbackError) {
          rollbackNote = `；⚠️ 且回滚也失败：${rollbackError.message}\n`
            + `  · 旧产物仍在 ${BACKUP}，可手动改名回 lib/ 恢复`
        }
      }
      throw new Error(`替换 lib/ 失败${rollbackNote}。原始错误：${error?.message ?? error}`)
    }
    await withTransientRetry(
      () => rm(BACKUP, { recursive: true, force: true }),
      '清理 .lib-backup',
    )
    console.log('  · 产物已原子替换 lib/')
  }
} catch (error) {
  await rm(STAGING, { recursive: true, force: true }).catch(() => {})
  console.error(`\n✗ 构建失败：\n${error?.message ?? error}\n`)

  const libExists = await stat(LIB).then(s => s.isDirectory()).catch(() => false)
  if (libExists) {
    console.error('✓ 旧的 lib/ 未被改动（构建现在先写暂存区，失败不动产物）—— 插件仍可用旧版本。')
  } else {
    console.error('! 当前没有 lib/，插件在 DSH 里无法加载。修好原因后重跑 `npm run build`。')
    console.error('  推荐先跑 `npm run doctor` 确认前置条件（Node / esbuild / 源文件）。')
  }
  process.exit(1)
}

// 收尾自证：把 lib/ 实际落盘的文件列出来 —— 构建自己说清产出了什么，不留给使用者猜。
const produced = (await walk(LIB)).map(file => `lib/${relative(LIB, file).split(sep).join('/')}`).sort()
console.log(`\nlib/ 实际落盘 ${produced.length} 个文件：`)
for (const file of produced) console.log(`  · ${file}`)
if (!produced.includes('lib/index.mjs')) {
  console.error('\n✗ 缺少 lib/index.mjs —— 宿主入口未落盘，verify 会失败。')
  process.exit(1)
}

console.log('\n构建完成。下一步：npm test && npm run verify')

