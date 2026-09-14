/**
 * `prepare` 钩子 —— 在**开发安装 / git 依赖安装 / 发布前**自动构建产物 `lib/`。
 *
 * ── ⚠️ 为什么钩子是 `prepare` 而不是 `postinstall`（2026-09-14 变更）────────
 * pnpm 10+ 默认**阻止依赖的安装期脚本**（`preinstall` / `install` / `postinstall`），
 * 作为供应链防护。一旦本包以依赖身份被安装，pnpm 会因这条 `postinstall` 直接报
 * `ERR_PNPM_IGNORED_BUILDS` 并中断安装 —— **即使本脚本对消费者本来是个空操作**。
 * （实测：macOS + pnpm 11.24.0 上，`dsh plugin add` 因此失败。）
 *
 * `prepare` 的语义恰好就是我们要的：
 *   · 在包自己的目录 `npm install`（开发）    → **执行**
 *   · 从 git 安装为依赖                       → **执行**
 *   · `npm publish` 之前                      → **执行**
 *   · 从 registry 安装为依赖                   → **不执行**（pnpm 也不将其列为待批准的构建脚本）
 * 于是消费者侧彻底摆脱这道门禁，开发体验完整保留。
 *
 * ── 为什么需要这个钩子（背景）────────────────────────────────────────────
 * `lib/` **不在版本库里**（`.gitignore` 排除），而 `package.json` 的 `main` 指向 `lib/index.mjs`。
 * 于是"克隆下来但没构建"会让插件**加载不了**，且症状是一句晦涩的模块找不到，
 * 而不是"你还没构建"。这个钩子把这个状态自动化掉。
 *
 * ⚠️ 务必区分下面两件事（早期注释曾把它们写反，已订正）：
 *   · `lib/` **在**发布包里 —— `package.json` 的 `files` 白名单包含它 ⇒ **消费者不需要构建**。
 *   · `lib/` **不在**版本库里 —— `.gitignore` 排除它 ⇒ **克隆下来必须构建**。
 *
 * 设计原则（三条，都很重要）：
 *   ① **永不失败**：钩子报错会让 `npm install` 整体失败，那更糟。
 *      所以全程 try/catch，失败只打印指引，退出码始终 0。
 *   ② **下游安装不构建**：别人把它当依赖装（或没装 esbuild）时静默跳过 ——
 *      发布包里已经带 `lib/`，不需要也不应该在消费者机器上跑打包器。
 *   ③ **只提示不代劳**：缺 esbuild 时只告诉用户跑什么，不偷偷 npm install 别的东西。
 *
 * 📌 文件名 `postinstall.mjs` 是**历史遗留** —— 钩子改名时未重命名文件，
 *    以免破坏既有引用与 `verify-package.mjs` 的必需文件断言。它现在由 `prepare` 调用。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

// ② 下游安装：优先用 npm 提供的标志判断，再兜底看 esbuild 在不在
const asDependency = process.env.npm_config_global === 'true'
  || !existsSync(join(ROOT, 'node_modules', 'esbuild'))

if (asDependency) {
  console.log('[dsh-dingtalk-connector] prepare：非开发安装，跳过构建（发布包已自带 lib/）')
  process.exit(0)
}

console.log('[dsh-dingtalk-connector] prepare：构建发布产物（lib/）…')

try {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (result.status === 0) {
    console.log('[dsh-dingtalk-connector] prepare：构建完成')
  } else {
    console.log(`[dsh-dingtalk-connector] prepare：构建未成功（退出码 ${result.status}）—— 手动跑 \`npm run build\` 看详情`)
  }
} catch (error) {
  // ① 永不失败
  console.log(`[dsh-dingtalk-connector] prepare：构建异常（${error?.message ?? error}）—— 手动跑 \`npm run build\` 看详情`)
}

process.exit(0)
