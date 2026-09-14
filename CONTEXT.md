# DeepSeek Harness · 钉钉 AI 表格连接器

本上下文描述 `@yiyunet/dsh-dingtalk-connector` 如何把钉钉 AI 表格的数据搬进 Harness，
以及过程中**哪些词是精确的、哪些词不能用**。

> 为什么要有这份文件：本插件有几个概念用一个词就会被误解（例如"定时任务"其实**不是**云端定时），
> 结果会让使用者按错误的预期排故障。术语表的 `_Avoid_` 段落写的是**禁止使用的说法**。

---

## 语言

**基准真相（Ground Truth）**：
被实测或官方文档直接确认、可复现的事实，并标注取得日期。
_Avoid_: 一般来说、应该是、我记得

**实测 / 官方原文 / 推测（三档标注）**：
每条技术结论必须标明属于哪一档。推测可以存在，但必须显式标注。
_Avoid_: 结论、事实（不加限定词时）

---

## 钉钉侧概念

**Base（AI 表格文件）**：
一个 AI 表格文件的顶层容器，标识符 `baseId`。一个 Base 内含若干数据表。
_Avoid_: 表格、文件、文档

**Table（数据表）**：
Base 内的一张表，标识符 `tableId`。
_Avoid_: sheet、工作表、sheetId（**这是 v0.1 的硬错误，已纠正**）

**Field（字段 / 列）**：
表的一列，标识符 `fieldId`（形如 `fldXXX`）。
_Avoid_: 列名、字段名（当指标识符时）

**Record（记录 / 行）**：
表的一行，标识符 `recordId`（形如 `recXXX`）。
_Avoid_: item、条目

**cells 的 key 是 fieldId**：
读写记录时，`cells` 对象的键**必须是 `fieldId`（fldXXX）**，不是字段中文名。
_Avoid_: 用字段名当 key、字段名为准

**Profile（账号身份）**：
一个 profile = 一个 `corpId + userId` 组合；**可以同时登录多个账号**。
_Avoid_: 用户、登录、账号（当指 profile 选择器时）

---

## 本插件的机制

**dws 包装（而非直连 REST）**：
本插件不直接调用钉钉 AI 表格 REST API，而是包装钉钉官方 `dws`（`dingtalk-workspace-cli`）执行 `dws aitable ...`。
这与钉钉官方 OpenClaw connector 同构。
_Avoid_: 原生接口、直连 API、独立实现

**写门禁（双锁）**：
写与删除**默认全关**；`allowWrite` 控制 create/update，`allowDelete` 单独控制 delete，
且删除**每次**还需 `confirm: true`。
_Avoid_: 权限、开关（不加限定词时）

**会话期定时（Host-resident schedule）**：
定时器跑在 DSH host 进程内。**DSH 关着时不执行**，重启后重算下次触发点。
这是登记在案的接受语义，不是缺陷。
_Avoid_: 云端定时、后台任务、服务端调度、不依赖 DSH

**候选清单（而非全量枚举）**：
钉钉侧**没有**"列出我全部 Base"的接口。`base list` 只返回最近访问，`base search` 每次约 4 条，
且其 `hasMore: true` 是**误报**（游标翻页无效）。因此扫描产出的是「多渠道候选 ∪ 人工补录」，**不保证穷尽**。
_Avoid_: 全量扫描、完整清单、全部表格

**可读性实测**：
权限判定方式是"跑一次 `base get`，成功即可读、失败记录原因"，而不是解析角色权限模型。
_Avoid_: 权限查询、角色判定

**带 BOM 的 UTF-8 CSV**：
文件以 `\uFEFF`（EF BB BF）开头——这是 Excel 正确识别中文的**唯一**条件。
插件落盘后会**回读首 3 字节**自证，因为编辑器看不见 BOM、ripgrep 还会主动剥掉它。
_Avoid_: UTF-8 CSV、CSV（不加 BOM 限定时）

**固定列集**：
CSV 的列以**字段目录**为准（全量字段、固定顺序），而不是"本批数据里出现过的字段"。
否则空列被省略、列集会随数据漂移，下游按列位解析会错位。
_Avoid_: 动态列、按数据出列

**设备流（device flow）**：
`dws auth login --device` 的授权方式。**dws 不输出二维码**，只给一条带 `user_code` 的深链；
二维码由本插件自己画（宿主侧 `qrcode` 包），**绝不调用第三方二维码服务**——认证链接不外发。
_Avoid_: 扫码授权（当作 dws 提供二维码时）、第三方二维码接口

**本机登录态旁路（易被误读为"自动批准"）**：
本机已处于钉钉登录态时，设备流可直接选定对应账号与企业组织、**无需扫码**即完成授权。
这是本机登录态导致，**不是**系统自动批准。
_Avoid_: 自动批准、免授权、跳过认证

**探针模式的副作用（非零）**：
`probeMs > 0` 的"探测输出"动作会在若干毫秒后杀掉会话。若组织已开启 CLI 访问，
**探测即可能真的新增账号**——它不是一个纯观察动作。
_Avoid_: 零副作用、只读探测

**组织级拦阻（管理动作，非技术配置）**：
新登录可能被 `CLI data access is not enabled for this organization` 拦下，
需**组织主管理员**在钉钉开放平台开启「允许成员通过 CLI 访问个人数据」。
_Avoid_: 权限配置、应用设置

---

## 工程形态

**宿主半侧 / 客户端半侧**：
宿主半侧（Node）注册工具与 RPC 端点，`inject = ['tools']`；
客户端半侧（浏览器）注册设置面板，跑在 web 平面。
_Avoid_: 前端 / 后端（会误导为网络服务）

**scoped 注入（可选依赖）**：
`connection` 服务只存在于 web 平面。本插件**绝不**把它写进顶层 `inject`，
而是用 `ctx.inject(['connection'], cb)` 开子 fiber——否则在 headless/tui profile 里
整个插件会永远停在 `inactive`，**工具会一起消失**。
_Avoid_: 依赖声明、可选插件

**唯一真源（single source of truth）**：
`plugin-src/` 是源码，`lib/` 是 `npm run build` 的产物，**直接改 `lib/` 会在下次构建被覆盖**。
_Avoid_: 源码（当指 lib/ 时）、产物（当指 plugin-src/ 时）

**发布契约校验**：
`npm run verify` 的七类断言（必需文件 / 依赖禁则 / 装载器 id / 面板契约 / 产物无 ESM / RPC 端点一致 / 敏感信息）。
它不是形式主义——每条都对应一个真实失败模式。
_Avoid_: lint、代码检查

**依赖禁则**：
`@deepseek-ai/dsh-*` **不得**出现在任何依赖节或 lock 文件里。DSH 运行时包用**模块局部 Symbol** 做 key，
装第二份物理副本会破坏 Host 查找。
_Avoid_: 依赖清洗、peer 修正
