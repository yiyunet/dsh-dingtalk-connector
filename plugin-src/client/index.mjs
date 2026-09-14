/**
 * 客户端装载器 wrapper —— 真源。
 *
 * 构建时 scripts/build.mjs 会把 esbuild 产物**插入** __DSH_CLIENT_BUNDLE__ 处，
 * 也就是插进 factory 函数体内部。
 *
 * 为什么必须在 factory 内部：impl.mjs 顶层就 `import ... from 'react'`，
 * esbuild 会把它提升成顶层的 `require("react")`；而 DSH 的 require 只是 factory
 * 的**参数**。若把产物放在 factory 外面，它会在脚本顶层执行 → esbuild 的
 * __require 垫片抛 "Dynamic require of \"react\" is not supported"，
 * 整个 /plugins 拼接 bundle 全灭。
 *
 * 平台冻结模块表只提供 react / react-dom / react/jsx-runtime / react-dom/client，
 * 由 factory 的 require 在运行时解析。
 */
window.__ModuleLoader__.load({
  id: '@yiyunet/dsh-dingtalk-connector',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // __DSH_CLIENT_BUNDLE__

    Object.assign(module.exports, __DshDingtalkConnector)
    return module.exports
  },
})