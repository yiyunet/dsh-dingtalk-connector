/**
 * `postinstall` 钩子 —— `npm install` 之后自动尝试构建发布产物。
 *
 * 为什么需要它：`lib/` 不在 npm 包里（它在 `.gitignore` 里、也从版本库排除），
 * 而 `package.json` 的 `main` 指向 `lib/index.mjs`。于是"
 * 装完依赖但没构建"会让插件**加载不了**，且症状是晦涩的模块找不到，
 * 而不是一句"你还没构建"。这个钩子的作用就是把这个状态自动化掉。
 *
 * 设计原则（三条，都很重要）：
 *   ① **永不失败**：postinstall 报错会让 `npm install` 整体失败，那更糟。
 *      所以全程 try/catch，失败只打印指引，退出码始终 0。
 *   ② **下游安装不构建**：别人把它当依赖装（不是 devDependency 存在、或没装 esbuild）时静默跳过——
 *      发布包里已经带 `lib/`，不需要也不应该在消费者机器上跑打包器。
 *   ③ **只提示不代劳**：缺 esbuild 时只告诉用户跑什么，不偷偷 npm install 别的东西。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

// ② 下游安装：优先用 npm 提供的标志判断，再兜底看 esbuild 在不在
const asDependency = process.env.npm_config_global === 'true'
  || !existsSync(join(ROOT, 'node_modules', 'esbuild'))

if (asDependency) {
  console.log('[dsh-dingtalk-connector] postinstall：非开发安装，跳过构建（发布包已自带 lib/）')
  process.exit(0)
}

console.log('[dsh-dingtalk-connector] postinstall：构建发布产物（lib/）…')

try {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  if (result.status === 0) {
    console.log('[dsh-dingtalk-connector] postinstall：构建完成')
  } else {
    console.log(`[dsh-dingtalk-connector] postinstall：构建未成功（退出码 ${result.status}）—— 手动跑 \`npm run build\` 看详情`)
  }
} catch (error) {
  // ① 永不失败
  console.log(`[dsh-dingtalk-connector] postinstall：构建异常（${error?.message ?? error}）—— 手动跑 \`npm run build\` 看详情`)
}

process.exit(0)
