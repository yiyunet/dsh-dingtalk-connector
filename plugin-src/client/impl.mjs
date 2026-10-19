/**
 * 客户端半侧实现（浏览器）—— 唯一真源，由 esbuild 打包进 lib/client.js。
 *
 * ⚠️ 本文件不是发布产物；发布产物是 lib/client.js（由 `npm run build` 生成）。
 *    装载器 wrapper 见 ./index.mjs，它负责把本模块挂到 window.__ModuleLoader__。
 *
 * 包管理约定：
 *   - 只允许 `import ... from 'react'`（以及必要时的 react-dom）—— 这两者来自平台冻结模块表
 *   - **不得引入任何第三方依赖**：引入即需把它加进 esbuild 的 external 列表，
 *     并确认平台冻结表里真的有它。否则浏览器端会静默拿不到模块。
 *   - 不使用 JSX（保持无额外编译器依赖；如需 JSX 请另行接入并同步更新 build 脚本）
 *
 * 客户端 → 宿主：ctx.connection.rpc.call('/api', '<endpoint>', { method, payload }, signal)
 * 注意拆包：成功结果是 { ok:true, value:<载荷> }，失败是 { ok:false, error:{…} }
 *
 * 布局（方案 B：**仅视觉分组**）：
 *   全局区（账号绑定标题 + 说明 + 扫码绑定会话）
 *   每个已登录账号 = 一个外框，框内包含该账号行 + 子区「AI 表格清单」+ 子区「定时导出」
 *   ⚠️ 方案 B 下数据仍共用"当前 profile"，各账号框内显示的是同一份清单与任务；
 *      真正的按账号隔离（--profile）留待方案 A。
 */
import React from 'react'

/** RPC 端点名（不含 /api/ 前缀）。必须与宿主 src/rpc.mjs 的 RPC_ENDPOINT 一致。 */
const RPC_ENDPOINT = 'dsh-dingtalk-connector'

/** 面板默认关键词与默认导出目录（宿主可通过 status.defaultExportDir 覆盖）。 */
const DEFAULT_KEYWORDS = '报表,管理'
const FALLBACK_EXPORT_DIR = ''

const h = React.createElement

// ── 样式（内联，免去 CSS 注入与构建） ────────────────────────────────
const S = {
  wrap: { padding: '4px 2px', fontSize: 13, lineHeight: 1.7 },
  card: { border: '1px solid var(--dsh-border, #e3e5e8)', borderRadius: 8, padding: '12px 14px', marginBottom: 12 },
  h2: { fontSize: 13, fontWeight: 600, margin: '0 0 10px' },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  // 标题行专用：不换行、右侧操作靠右
  headRow: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'nowrap' },
  input: { flex: '1 1 240px', minWidth: 160, padding: '6px 8px', fontSize: 13, border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5 },
  inputNarrow: { width: 200, padding: '5px 8px', fontSize: 13, border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5 },
  btn: { padding: '5px 12px', fontSize: 13, border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 5, cursor: 'pointer' },
  btnPrimary: { padding: '5px 12px', fontSize: 13, border: '1px solid transparent', borderRadius: 5, cursor: 'pointer' },
  muted: { opacity: 0.65, fontSize: 12 },
  badgeOk: { padding: '1px 7px', borderRadius: 9, fontSize: 11, background: 'rgba(32,160,90,.14)' },
  badgeBad: { padding: '1px 7px', borderRadius: 9, fontSize: 11, background: 'rgba(200,60,60,.14)' },
  list: { maxHeight: 260, overflow: 'auto', border: '1px solid var(--dsh-border, #e3e5e8)', borderRadius: 6 },
  item: { padding: '6px 10px', borderBottom: '1px solid var(--dsh-border, #eef0f2)', display: 'flex', gap: 8, alignItems: 'center' },
  pre: { margin: '6px 0 0', padding: 8, background: 'rgba(127,127,127,.08)', borderRadius: 5, fontSize: 12, overflowX: 'auto' },
  cardHead: { display: 'flex', alignItems: 'center', gap: 8 },
  toggleBtn: {
    width: 20, height: 20, lineHeight: '18px', padding: 0, fontSize: 11, cursor: 'pointer',
    border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 4, background: 'transparent', color: 'inherit',
  },
  accountBox: { border: '1px solid var(--dsh-border, #dcdfe3)', borderRadius: 8, padding: '10px 12px', marginBottom: 10 },
  subSection: { borderTop: '1px solid var(--dsh-border, #eef0f2)', marginTop: 8, paddingTop: 8 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', padding: '5px 6px', borderBottom: '1px solid var(--dsh-border, #e3e5e8)', fontWeight: 600 },
  td: { padding: '5px 6px', borderBottom: '1px solid var(--dsh-border, #eef0f2)', verticalAlign: 'top' },
}

function Btn(props) {
  const style = props.primary ? Object.assign({}, S.btnPrimary, { background: 'var(--dsh-accent, #3b6cf0)', color: '#fff' }) : S.btn
  return h('button', { type: 'button', style: style, disabled: props.disabled, onClick: props.onClick }, props.label)
}

/** 折叠箭头按钮。 */
function Toggle(props) {
  return h('button', {
    type: 'button', style: S.toggleBtn,
    title: props.open ? '收起' : '展开',
    onClick: props.onToggle,
  }, props.open ? '▾' : '▸')
}

/** 可展开/收缩的区块（子区）：箭头 + 标题 + 弹性占位 + 右侧操作 + 可选内容。 */
function Section(props) {
  return h('div', { style: props.style || S.card },
    h('div', { style: S.headRow },
      h(Toggle, { open: props.open, onToggle: props.onToggle }),
      h('strong', null, props.title),
      props.badge || null,
      h('div', { style: { flex: 1 } }),
      props.actions || null,
    ),
    props.open ? props.children : null,
  )
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
    const area = document.createElement('textarea')
    area.value = text
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    document.body.removeChild(area)
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error)
  }
}

function fmt(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch (error) { return String(iso) }
}

// ── 主面板 ───────────────────────────────────────────────────────────
function Panel(props) {
  const rpc = props.rpc
  const useState = React.useState
  const useEffect = React.useEffect

  const s0 = useState(null);  const status = s0[0];   const setStatus = s0[1]
  const s1 = useState(DEFAULT_KEYWORDS); const keywords = s1[0]; const setKeywords = s1[1]
  const s2 = useState(null);  const scan = s2[0];     const setScan = s2[1]
  const s3 = useState(null);  const base = s3[0];     const setBase = s3[1]          // { baseId, baseName, tables }
  const s4 = useState(null);  const table = s4[0];    const setTable = s4[1]         // { tableId, tableName }
  const s5 = useState('');    const outPath = s5[0];  const setOutPath = s5[1]
  const s6 = useState('daily'); const freq = s6[0];   const setFreq = s6[1]
  const s7 = useState('09:00'); const time = s7[0];   const setTime = s7[1]
  const s8 = useState(1);     const weekday = s8[0];  const setWeekday = s8[1]
  const s9 = useState(null);  const jobs = s9[0];     const setJobs = s9[1]
  const s10 = useState('');   const busy = s10[0];    const setBusy = s10[1]
  const s11 = useState('');   const message = s11[0]; const setMessage = s11[1]
  const s12 = useState(null); const accounts = s12[0];      const setAccounts = s12[1]
  const s13 = useState(null); const loginSession = s13[0];  const setLoginSession = s13[1]
  const s14 = useState('');   const pendingUnbind = s14[0]; const setPendingUnbind = s14[1]
  const loginTimer = React.useRef(null)
  // 各区块展开状态：账号外框 / 其子区，键形如 'acct:<profile>'、'acct:<profile>|scan'
  const s15 = useState({})
  const openSections = s15[0]; const setOpenSections = s15[1]
  function toggleSection(key) {
    setOpenSections(function (previous) {
      const next = Object.assign({}, previous)
      next[key] = next[key] === false        // 未设过＝展开；点一下→收起
      return next
    })
  }
  function isOpen(key) { return openSections[key] !== false }

  function run(label, fn) {
    setBusy(label)
    setMessage('')
    return Promise.resolve()
      .then(fn)
      .catch(function (error) { setMessage('❌ ' + (error && error.message ? error.message : String(error))) })
      .then(function () { setBusy('') })
  }

  function loadStatus() {
    return run('status', function () {
      return rpc('status').then(function (result) { setStatus(result); if (!result.ok) throw new Error(result.error && result.error.message) })
    })
  }
  function loadJobs() {
    return run('jobs', function () {
      return rpc('jobsList').then(function (result) { setJobs(result); if (!result.ok) throw new Error(result.error && result.error.message) })
    })
  }
  function loadAccounts() {
    return run('accounts', function () {
      return rpc('accounts').then(function (result) { setAccounts(result); if (!result.ok) throw new Error(result.error && result.error.message) })
    })
  }
  // 移除接入：两步确认（不可逆 —— 需重新扫码才能恢复）
  function doUnbind(selector) {
    if (pendingUnbind !== selector) {
      setPendingUnbind(selector)
      setMessage('⚠️ 再点一次「确认移除」即移除该账号接入：' + selector)
      return Promise.resolve()
    }
    setPendingUnbind('')
    return run('unbind', function () {
      return rpc('unbind', { selector: selector, confirm: true }).then(function (result) {
        setAccounts(result)
        if (!result.ok) throw new Error(result.error && result.error.message)
        setMessage('已移除接入：' + selector)
      })
    })
  }
  function pollLogin() {
    if (loginTimer.current) clearInterval(loginTimer.current)
    loginTimer.current = setInterval(function () {
      rpc('loginStatus').then(function (result) {
        if (!result || !result.ok) return
        setLoginSession(result.session)
        if (result.session && result.session.active === false) {
          clearInterval(loginTimer.current)
          loginTimer.current = null
          loadAccounts()          // 登录会话结束后刷新账号列表
        }
      }).catch(function () { /* 面板卸载或网络抖动，忽略 */ })
    }, 2000)
  }
  // probeMs>0 = 探测模式：抓取若干毫秒后自动结束（注意：本机已登录时可能真的完成授权）
  function startLogin(probeMs) {
    return run('login', function () {
      return rpc('loginStart', { device: true, probeMs: probeMs || 0 }).then(function (result) {
        if (!result.ok) throw new Error(result.error && result.error.message)
        setLoginSession(result.session)
        pollLogin()
      })
    })
  }
  function cancelLogin() {
    return run('loginCancel', function () {
      return rpc('loginCancel').then(function (result) { setLoginSession(result.session) })
    })
  }
  function doScan() {
    const list = keywords.split(',').map(function (k) { return k.trim() }).filter(Boolean)
    return run('scan', function () {
      return rpc('scan', { keywords: list, withTables: false }).then(function (result) {
        setScan(result)
        if (!result.ok) throw new Error(result.error && result.error.message)
      })
    })
  }
  function openBase(candidate) {
    return run('tables', function () {
      return rpc('tables', { baseId: candidate.baseId }).then(function (result) {
        if (!result.ok) throw new Error(result.error && result.error.message)
        setBase(result)
        setTable(null)
      })
    })
  }
  function pickTable(row) {
    setTable(row)
    if (base && !outPath) {
      // 默认导出目录由宿主下发（status.defaultExportDir，取自 cordis.patch.yml 的 defaultExportDir）；
      // 宿主没配则只填文件名，让用户自己补目录 —— 不在客户端硬编码任何个人路径。
      const dir = (status && status.defaultExportDir) || FALLBACK_EXPORT_DIR
      const name = (base.baseName || 'dingtalk') + '-' + (row.tableName || row.tableId) + '.csv'
      setOutPath(dir ? (dir.replace(/[\\/]+$/, '') + '/' + name) : name)
    }
  }
  function createJob() {
    return run('create', function () {
      return rpc('jobCreate', {
        baseId: base ? base.baseId : undefined,
        tableId: table ? table.tableId : undefined,
        outputPath: outPath,
        frequency: freq,
        time: time,
        weekday: freq === 'weekly' ? Number(weekday) : undefined,
        label: (base ? base.baseName : '') + ' · ' + (table ? table.tableName : ''),
      }).then(function (result) { setJobs(result); if (!result.ok) throw new Error(result.error && result.error.message) })
    })
  }

  useEffect(function () { loadStatus(); loadJobs(); loadAccounts() }, [])
  useEffect(function () {
    return function () { if (loginTimer.current) clearInterval(loginTimer.current) }
  }, [])

  const auth = status && status.auth
  const authorized = !!(auth && auth.authenticated !== false)

  // ── 子区内容（每个账号外框内复用同一份；方案 B 下数据共用当前 profile）──

  const scanChildren = [
    h('div', { key: 'hint', style: S.muted },
      '钉钉侧没有「列出全部」接口（base list 只给最近访问，base search 每次约 4 条）——多渠道候选 + 可读性实测，多给关键词可扩大覆盖。'),
    scan && scan.candidates
      ? h('div', { key: 'cands', style: { marginTop: 8 } },
        h('div', { style: S.muted }, '发现 ', String(scan.stats && scan.stats.discovered), ' 个，可读 ', String(scan.stats && scan.stats.readable), ' 个'),
        h('div', { style: S.list },
          scan.candidates.map(function (c) {
            return h('div', { key: c.baseId, style: S.item },
              h('span', { style: c.readable ? S.badgeOk : S.badgeBad }, c.readable ? '可读' : '不可读'),
              h('span', { style: { flex: 1 } }, c.baseName || c.baseId),
              h('span', { style: S.muted }, String(c.tableCount == null ? '' : c.tableCount) + ' 表'),
              h(Btn, { label: '查看表', disabled: !!busy || !c.readable, onClick: function () { openBase(c) } }),
            )
          }),
        ),
      )
      : null,
    base
      ? h('div', { key: 'tables', style: { marginTop: 10 } },
        h('div', { style: S.headRow },
          h('strong', null, base.baseName || base.baseId),
          h('div', { style: { flex: 1 } }),
          h(Btn, { label: '复制 Base ID', onClick: function () { copyText(base.baseId).then(function () { setMessage('已复制 baseId') }) } }),
        ),
        h('div', { style: Object.assign({}, S.list, { marginTop: 6 }) },
          (base.tables || []).map(function (row) {
            const picked = table && table.tableId === row.tableId
            return h('div', { key: row.tableId, style: S.item },
              h('input', { type: 'radio', checked: !!picked, onChange: function () { pickTable(row) } }),
              h('span', { style: { flex: 1 } }, row.tableName || row.tableId),
              h('code', { style: S.muted }, row.tableId),
              h(Btn, { label: '复制 Table ID', onClick: function () { copyText(row.tableId).then(function () { setMessage('已复制 tableId') }) } }),
            )
          }),
        ),
      )
      : null,
  ]

  const jobsChildren = [
    table
      ? h('div', { key: 'form' },
        h('div', { style: S.muted }, '已选：', h('strong', null, (base && base.baseName) || ''), ' / ', h('strong', null, table.tableName || table.tableId)),
        h('div', { style: Object.assign({}, S.row, { marginTop: 8 }) },
          h('input', { style: S.input, value: outPath, placeholder: 'CSV 绝对路径（同名直接覆盖）', onChange: function (e) { setOutPath(e.target.value) } }),
        ),
        h('div', { style: Object.assign({}, S.row, { marginTop: 8 }) },
          h('select', { style: S.input, value: freq, onChange: function (e) { setFreq(e.target.value) } },
            h('option', { value: 'daily' }, '每天'),
            h('option', { value: 'weekly' }, '每周')),
          freq === 'weekly'
            ? h('select', { style: S.input, value: weekday, onChange: function (e) { setWeekday(e.target.value) } },
              [['1', '周一'], ['2', '周二'], ['3', '周三'], ['4', '周四'], ['5', '周五'], ['6', '周六'], ['7', '周日']]
                .map(function (pair) { return h('option', { key: pair[0], value: pair[0] }, pair[1]) }))
            : null,
          h('input', { style: S.input, value: time, placeholder: 'HH:MM', onChange: function (e) { setTime(e.target.value) } }),
          h(Btn, { label: busy === 'create' ? '创建中…' : '新建定时任务', primary: true, disabled: !!busy, onClick: createJob }),
        ),
        h('div', { style: S.muted }, '⚠️ 定时器跑在 DSH host 进程内：DSH 关着时不执行；重启后自动重算下次触发点。'),
      )
      : h('div', { key: 'noselect', style: S.muted }, '先在上方选一张数据表。'),
    jobs && jobs.jobs && jobs.jobs.length
      ? h('table', { key: 'jobs', style: Object.assign({}, S.table, { marginTop: 10 }) },
        h('thead', null, h('tr', null,
          h('th', { style: S.th }, '任务'), h('th', { style: S.th }, '频率'), h('th', { style: S.th }, '下次'),
          h('th', { style: S.th }, '上次'), h('th', { style: S.th }, '操作'))),
        h('tbody', null, jobs.jobs.map(function (job) {
          return h('tr', { key: job.id },
            h('td', { style: S.td }, job.label),
            h('td', { style: S.td }, job.frequency === 'weekly' ? ('每周 ' + job.time) : ('每天 ' + job.time),
              job.enabled ? null : h('span', { style: S.badgeBad }, '已停')),
            h('td', { style: S.td }, fmt(job.nextRun)),
            h('td', { style: S.td }, job.lastRun ? (job.lastRun.ok ? ('✅ ' + (job.lastRun.count || 0) + ' 条') : ('❌ ' + (job.lastRun.error || ''))) : '—'),
            h('td', { style: S.td },
              h(Btn, { label: '立即执行', disabled: !!busy, onClick: function () { run('run', function () { return rpc('jobRunNow', { id: job.id }).then(function (r) { setJobs(r); if (!r.ok) throw new Error(r.error && r.error.message) }) }) } }),
              ' ',
              h(Btn, { label: job.enabled ? '停用' : '启用', disabled: !!busy, onClick: function () { run('toggle', function () { return rpc('jobToggle', { id: job.id, enabled: !job.enabled }).then(function (r) { setJobs(r) }) }) } }),
              ' ',
              h(Btn, { label: '删除', disabled: !!busy, onClick: function () { run('remove', function () { return rpc('jobRemove', { id: job.id }).then(function (r) { setJobs(r) }) }) } }),
            ),
          )
        })),
        h('div', { style: S.muted }, '任务文件：', jobs.jobsFile),
      )
      : null,
  ]

  /** AI 表格清单子区（标题行：箭头 + 标题 + 弹性占位 + 输入框 + 按钮，同一行不换行）。 */
  function scanSection(key) {
    return h(Section, {
      style: S.subSection,
      title: 'AI 表格清单',
      open: isOpen(key + '|scan'),
      onToggle: function () { toggleSection(key + '|scan') },
      actions: h('div', { style: S.headRow },
        h('input', {
          style: S.inputNarrow,
          value: keywords,
          placeholder: '输入表格名关键词',
          onChange: function (e) { setKeywords(e.target.value) },
        }),
        h(Btn, { label: busy === 'scan' ? '扫描中…' : '开始扫描', primary: true, disabled: !!busy, onClick: doScan }),
      ),
    }, scanChildren)
  }

  /** 定时导出子区。 */
  function jobsSection(key) {
    return h(Section, {
      style: S.subSection,
      title: '定时导出（CSV · UTF-8 BOM · 覆盖同名）',
      open: isOpen(key + '|jobs'),
      onToggle: function () { toggleSection(key + '|jobs') },
      actions: h('div', { style: S.headRow },
        h(Btn, { label: busy === 'jobs' ? '读取中…' : '刷新任务', disabled: !!busy, onClick: loadJobs })),
    }, jobsChildren)
  }

  const list = (accounts && accounts.accounts) || []

  return h('div', { style: S.wrap },
    h('h2', { style: S.h2 }, '钉钉文档'),

    // ── 全局区：账号绑定标题 + 说明 + 扫码绑定会话（不属于任何账号）──
    h('div', { style: S.card },
      h('div', { style: S.headRow },
        h('strong', null, '账号绑定'),
        accounts && accounts.accounts
          ? h('span', { style: accounts.accounts.length ? S.badgeOk : S.badgeBad }, '已绑定 ' + accounts.accounts.length + ' 个账号')
          : h('span', { style: S.muted }, '读取中…'),
        h('div', { style: { flex: 1 } }),
        h(Btn, { label: busy === 'accounts' ? '读取中…' : '刷新账号', disabled: !!busy, onClick: loadAccounts }),
        h(Btn, {
          label: busy === 'login' ? '启动中…' : '扫码绑定',
          primary: true,
          disabled: !!busy || !!(loginSession && loginSession.active),
          onClick: function () { startLogin(0) },
        }),
      ),
      h('div', { style: S.muted },
        '一个账号一个 profile，可绑多个账号。⚠️ 若本机已处于钉钉登录态，点「扫码绑定」可能无需扫码 —— '
        + '设备流会直接使用本机当前选定的钉钉账号与企业组织完成授权（更省事，但不是让你重新挑一个账号）。'),

      // 登录会话：二维码 / 深链 / 原始输出 / 组织拦阻
      loginSession && (loginSession.active || loginSession.output)
        ? h('div', { style: { marginTop: 10 } },
          h('div', { style: S.headRow },
            h('strong', null, '扫码绑定进行中'),
            h('span', { style: loginSession.active ? S.badgeOk : S.muted }, loginSession.active ? '等待扫码…' : '已结束'),
            h('div', { style: { flex: 1 } }),
            h(Btn, { label: '取消', disabled: !loginSession.active, onClick: cancelLogin }),
            h(Btn, {
              label: '探测输出 8 秒',
              disabled: !!busy || !!loginSession.active,
              onClick: function () { startLogin(8000) },
            }),
          ),
          loginSession.note ? h('div', { style: S.muted }, loginSession.note) : null,

          loginSession.blocked
            ? h('div', { style: { marginTop: 8, padding: '8px 10px', border: '1px solid #d9534f', borderRadius: 6 } },
              h('strong', null, '⛔ 组织策略拦阻：'),
              loginSession.blocked.reason,
              loginSession.blocked.admins ? h('div', { style: S.muted }, '组织主管理员：', loginSession.blocked.admins) : null,
              loginSession.blocked.hint ? h('div', { style: S.muted }, loginSession.blocked.hint) : null,
              loginSession.blocked.action
                ? h('div', null, h('a', { href: loginSession.blocked.action, target: '_blank', rel: 'noreferrer' }, '钉钉开放平台 → 开发者设置'))
                : null,
            )
            : null,

          loginSession.qrDataUrl
            ? h('div', { style: { marginTop: 8 } },
              h('img', {
                src: loginSession.qrDataUrl, alt: '钉钉登录二维码', width: 260, height: 260,
                style: { background: '#fff', padding: 6, borderRadius: 6 },
              }),
              h('div', { style: S.muted }, '用钉钉 App 扫这个码完成授权。'))
            : (loginSession.active
              ? h('div', { style: S.muted }, '（二维码生成中…若一直不出，说明 qrcode 包没解析到 —— 用下面的链接与授权码同样能授权）')
              : null),

          loginSession.qrPayload
            ? h('div', { style: S.headRow },
              h('code', { style: S.muted }, loginSession.qrPayload),
              h(Btn, { label: '复制深链', onClick: function () { copyText(loginSession.qrPayload).then(function () { setMessage('已复制深链') }) } }))
            : null,

          (loginSession.urls && loginSession.urls.length)
            ? h('div', { style: { marginTop: 6 } },
              loginSession.urls.map(function (url, index) {
                return h('div', { key: index, style: S.row },
                  h('a', { href: url, target: '_blank', rel: 'noreferrer' }, url),
                  h(Btn, { label: '复制链接', onClick: function () { copyText(url).then(function () { setMessage('已复制链接') }) } }),
                )
              }))
            : null,

          h('div', { style: S.muted }, '下面是 dws 的原始输出（含 authorization code）。'),
          h('pre', { style: S.pre }, loginSession.output || '(等待输出…)'),
        )
        : null,

      // CLI 版本 / 凭证来源 / 写门禁 按维护者要求不显示（需要时用 dingtalk_aitable_diagnose 查看）
      status && status.authError
        ? h('div', { style: { marginTop: 8 } },
          h('span', { style: S.badgeBad }, '当前 profile 未授权'),
          h('pre', { style: S.pre }, status.authError))
        : null,
    ),

    // ── 账号外框 × N：每个账号一个框，框内含该账号的「AI 表格清单」与「定时导出」──
    list.length
      ? list.map(function (acct) {
        const boxKey = 'acct:' + acct.profile
        const open = isOpen(boxKey)
        return h('div', { key: acct.profile || 'acct', style: S.accountBox },
          h('div', { style: S.headRow },
            h(Toggle, { open: open, onToggle: function () { toggleSection(boxKey) } }),
            acct.isCurrent ? h('span', { style: S.badgeOk }, '当前') : h('span', { style: S.muted }, '账号'),
            h('strong', null, (acct.corpName || acct.corpId || '—') + ' · ' + (acct.userName || acct.userId || '—')),
            h('div', { style: { flex: 1 } }),
            h(Btn, {
              label: pendingUnbind === acct.profile ? '确认移除' : '移除接入',
              disabled: !!busy,
              onClick: function () { doUnbind(acct.profile) },
            }),
          ),
          open
            ? h('div', { style: { marginTop: 6, opacity: 0.6, fontSize: 11, wordBreak: 'break-all', lineHeight: 1.5 } },
              h('code', null, acct.profile))
            : null,
          open ? scanSection(boxKey) : null,
          open ? jobsSection(boxKey) : null,
        )
      })
      : h('div', { style: Object.assign({}, S.card, S.muted) },
        '暂无已绑定账号。点上方「扫码绑定」用钉钉 App 绑定；一个账号一个 profile，可绑多个。'),

    busy ? h('div', { style: S.muted }, '⏳ ' + busy + '…') : null,
    message ? h('div', { style: { marginTop: 6 } }, message) : null,
  )
}

// ── 模块契约：{ name, inject, apply } ────────────────────────────────
export const name = 'dingtalk-connector-settings'

/**
 * ⚠️ 这里的 `connection` 是**面板必需的**（面板要调 RPC）。
 *    但注意：`connection` 服务只存在于 web 平面，把它声明在**宿主侧**的顶层 inject 里
 *    会让插件在 headless/tui profile 永远停在 inactive（见 src/index.mjs 的说明）。
 *    客户端这一层只跑在 web 面板，所以这里写死 'connection' 是安全的、也是必需的。
 */
export const inject = ['slots', 'connection']

export function apply(ctx) {
  ctx.slots.inject('settings.section', function () {
    return ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-dingtalk-connector',
      order: 22,
      label: function () { return '钉钉文档' },
      inject: function () {
        return {
          // 注意拆包：成功结果是 { ok:true, value:<载荷> }，失败是 { ok:false, error:{…} }
          rpc: function (method, payload, signal) {
            return ctx.connection.rpc.call('/api', RPC_ENDPOINT, { method: method, payload: payload || {} }, signal)
              .then(function (result) {
                return result && result.ok === true ? result.value : result
              })
          },
        }
      },
    }, Panel)
  })
}
