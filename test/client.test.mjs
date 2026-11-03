/**
 * 客户端半侧：ANB 工具壳契约与标签注册。
 *
 * ⚠️ 跑的是**构建产物** `lib/client.js`，不是源码 —— 这是刻意的：
 *    "装任一 ANB 插件，壳就自带"这条性质，只有把产物塞进最小 `__ModuleLoader__`
 *    桩里、真跑一遍 `apply()` 才能证明。源码层字符串断言（verify-package.mjs）
 *    只能证明"字符串在里面"，证明不了"行为对"。
 *
 * 前置：先跑 `npm run build`（`lib/` 是产物，不在版本库里）。
 *       `npm run check` 的顺序本来就是 build → test → verify。
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const ROOT = resolve(import.meta.dirname, '..')
const BUNDLE = resolve(ROOT, 'lib', 'client.js')

const LOADER_ID = '@yiyunet/dsh-dingtalk-connector'
const SHELL_SECTION = 'settings.section'
const SHELL_SLOT = 'anb.tool.tab'
const SHELL_ID = 'anb-toolbox'
const SHELL_TITLE = 'ANB 工具'
const SHELL_ORDER = 16
const PANEL_ID = 'dsh-dingtalk-connector'
const PANEL_LABEL = '钉钉文档'
const PANEL_ORDER = 10

/** 与 scripts/build.mjs 的自证桩同形：只要顶层能执行、factory 能物化出 apply 即可。 */
function loadBundle(source) {
  const registrations = []
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    URL,
    TextEncoder,
    TextDecoder,
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
    window: {
      __ModuleLoader__: { mode: 'queue', load: registration => registrations.push(registration) },
    },
  }
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  return registrations
}

/**
 * React 桩：`apply()` 期**不渲染**任何组件（只做登记），因此这里只需满足
 * 模块顶层对 `React.createElement` 的取用，以及 hooks 的存在性。
 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: value => ({ current: value }),
    useCallback: fn => fn,
    useMemo: fn => fn(),
    createContext: value => ({ Provider: 'Provider', Consumer: 'Consumer', _value: value }),
  }
}

/**
 * slots 的极简账本：每个 slot 名下一个 Map（id → 登记项），
 * 与真实渲染器的 `entriesOfSlot` 口径一致 —— 同 id 注册是**替换**语义。
 */
function createCtx({ presetSection = [] } = {}) {
  const ledger = new Map()
  const listeners = new Map()
  let version = 0

  if (presetSection.length > 0) {
    ledger.set(SHELL_SECTION, new Map(presetSection.map(entry => [entry.options.id, entry])))
  }

  const emit = (name) => {
    version += 1
    for (const listener of [...(listeners.get(name) ?? [])]) listener()
  }
  const winners = name => [...(ledger.get(name)?.values() ?? [])]

  const slots = {
    /** 登记一个 slot：真实实现返回 disposer，guardShell 会调用它。 */
    inject(name, factory) {
      const entry = factory()
      if (!ledger.has(name)) ledger.set(name, new Map())
      ledger.get(name).set(entry.options.id, entry)
      emit(name)
      return () => {}
    },
    register(options, component) {
      return { options, component }
    },
    entries: winners,
    entriesOfSlot: winners,
    getVersion: () => version,
    subscribe(name, listener) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(listener)
      return () => { listeners.get(name)?.delete(listener) }
    },
  }

  return {
    ctx: {
      slots,
      effect(fn) {
        const dispose = fn()
        return () => { if (typeof dispose === 'function') dispose() }
      },
    },
    read: winners,
  }
}

/** 把产物装好、拿到插件面（`{ name, inject, apply }`）。 */
async function loadFace() {
  const source = await readFile(BUNDLE, 'utf8').catch((error) => {
    throw new Error(`读不到 ${BUNDLE}（${error?.code ?? error}）—— 先跑 \`npm run build\``)
  })
  const registration = loadBundle(source).find(item => item?.id === LOADER_ID)
  assert.ok(registration, `产物没有注册装载器 id ${LOADER_ID}`)

  return registration.factory((specifier) => {
    if (specifier === 'react') return reactStub()
    if (specifier === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: null }
    if (specifier === 'react-dom') return { createPortal: () => null }
    if (specifier === 'react-dom/client') return { createRoot: () => ({ render() {} }) }
    throw new Error(`客户端产物 require 了未预期的模块「${specifier}」—— 平台冻结表只保证 react 系`)
  })
}

/** 跑一次 apply，返回两个 slot 里的登记结果。 */
async function applyOnce(options) {
  const face = await loadFace()
  assert.equal(typeof face.apply, 'function', '客户端面缺少 apply()')
  const box = createCtx(options)
  face.apply(box.ctx)
  return { face, box, section: box.read(SHELL_SECTION), tabs: box.read(SHELL_SLOT) }
}

test('客户端：apply 自带「ANB 工具」壳，并把面板注册进 anb.tool.tab', async () => {
  const { section, tabs } = await applyOnce()

  const shell = section.filter(entry => entry.options.id === SHELL_ID)
  assert.equal(shell.length, 1, '必须恰好登记一个 ANB 工具壳')
  assert.equal(shell[0].options.name, SHELL_SECTION, '壳必须占据设置左栏的位置（settings.section）')
  assert.equal(shell[0].options.order, SHELL_ORDER, '壳的 order 应为 16（紧跟官方「内置插件」15）')
  assert.equal(typeof shell[0].options.label, 'function', 'label 必须是函数（会随语言/版本变化）')
  assert.equal(shell[0].options.label(), SHELL_TITLE)
  assert.equal(typeof shell[0].component, 'function', '壳必须带组件（否则左栏点进去是空白）')

  const panel = tabs.filter(entry => entry.options.id === PANEL_ID)
  assert.equal(panel.length, 1, '面板必须挂到壳的标签账本里')
  assert.equal(panel[0].options.name, SHELL_SLOT)
  assert.equal(panel[0].options.order, PANEL_ORDER, '面板在壳内的 order 应为 10（10 → 20 → 30 → 40）')
  assert.equal(panel[0].options.label(), PANEL_LABEL)
  assert.equal(typeof panel[0].component, 'function', '面板必须带组件')

  // 面板不得再自己去占设置左栏 —— 那会让侧栏多出一项、壳失去意义
  assert.equal(section.filter(entry => entry.options.id === PANEL_ID).length, 0,
    '面板不得注册成 settings.section（会在侧栏多出一项）')
})

test('客户端：壳声明 anb.tool.tab 为自己的子 slot（list / root）', async () => {
  const { section } = await applyOnce()
  const shell = section.find(entry => entry.options.id === SHELL_ID)
  assert.ok(shell.options.children, '壳必须声明 children，否则标签渲染不出来')
  const child = shell.options.children[SHELL_SLOT]
  assert.ok(child, `children 里必须有 ${SHELL_SLOT}`)
  assert.equal(child.kind, 'list')
  assert.equal(child.scope, 'root')
})

test('客户端：已有别人的壳时让位 —— 不重复登记，也不抢别人的位置', async () => {
  const foreign = {
    options: { name: SHELL_SECTION, id: SHELL_ID, order: SHELL_ORDER, label: () => SHELL_TITLE },
    component: function ForeignShell() { return null },
  }
  const { section, tabs } = await applyOnce({ presetSection: [foreign] })

  assert.equal(section.length, 1, '不得出现两个同 id 的壳（重复装载 = 两个侧栏项）')
  assert.equal(section[0].component, foreign.component, '必须保留先登记者，本包应让位')

  assert.equal(tabs.filter(entry => entry.options.id === PANEL_ID).length, 1,
    '让位之后面板仍要注册进壳的账本（否则用户在壳里看不到它）')
})

test('客户端：面板靠 slots.inject() 拿 rpc（拿不到就是一片空白）', async () => {
  const { tabs } = await applyOnce()
  const panel = tabs.find(entry => entry.options.id === PANEL_ID)
  assert.equal(typeof panel.options.inject, 'function', '面板必须声明 inject()')
  const provided = panel.options.inject()
  assert.equal(typeof provided.rpc, 'function', 'inject() 必须给出 rpc 函数')
})

// ── 形状自证：产物一旦被改坏（比如有人直接改 lib/），这些断言先红 ──────────
test('客户端：产物不含 ESM 顶层语法（它是 esbuild 的输出，不是源码）', async () => {
  const source = await readFile(BUNDLE, 'utf8')
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/mu)
})
