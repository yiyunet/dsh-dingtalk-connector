# 变更记录

本文件记录对外可见的行为变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- **Windows 构建瞬时 `EPERM` 根治**：`scripts/build.mjs` 的原子替换块此前**没有重试**——
  一次瞬时文件锁就让整个构建失败，并进而使 `prepublishOnly` **中止整个发布流程**。
  实测（2026-09-14，Windows）同一条命令连续 4 次里 **2 次 `EPERM`、2 次成功**，失败后立刻重跑即通过。
  - **根因**：Windows 上 `rename()` 底层走 `MoveFileEx`，只要**源目录内任一文件**（或目标路径）
    被其它进程持有句柄，就返回 `ACCESS_DENIED` → Node 报 `EPERM`。杀软实时扫描、Windows 搜索索引器、
    宿主进程的文件监听，都会在「刚写入的目录」上制造**毫秒到秒级**的瞬时占用。
    **POSIX 允许重命名已被打开的目录，故 Linux CI 从不触发本问题** —— 这是 Windows 开发机特有现象。
  - **修法**：新增 `withTransientRetry()`，**仅**对 `EPERM` / `EACCES` / `EBUSY` 三种瞬时码做线性退避重试
    （200 → 1000ms，最多 5 次，累计约 3s）；**其余错误立即抛出**，不被退避拖慢。
    覆盖替换块的 5 个调用点（含回滚）。
  - **顺带修掉一个更隐蔽的缺陷**：回滚原为 `rename(BACKUP, LIB).catch(() => {})` —— **静默吞掉失败**。
    回滚一旦失败会留下「没有 `lib/`」的最坏状态（插件加载不了），而报错却写着"已回滚到旧产物"，
    **报的和实际相反**。现改为回滚同样重试；真失败则明确报出备份所在路径，可手动改名恢复。
  - **可观测**：每次重试都会打印 `· 瞬时文件锁（EPERM）：… → 400ms 后重试`，
    使该修复**可被事后验证**，而不是"悄悄生效"。
  - **影响面**：仅 `scripts/build.mjs` 的替换块；**不触及** `plugin-src/`、产物结构、RPC 端点、写门禁。
    该修复随包发布（`scripts/` 在 `files` 白名单内），对下游 `postinstall` 同样有效。

---

## [1.0.0] - 2026-09-14

> 本节记录 1.0.0 从开发到**首次公开发布**的全部变更。以下内容原以 `[Unreleased]` 形式累积，
> 因 1.0.0 已于 2026-09-14 发布到 npm（registry 的 `dist.integrity` 与本仓库提交 `84671d0e` 一致），
> 故正式归入本版本。

### 新增

- **`docs/` 文档体系**（对照 dsh-im 的文档形态补齐）：
  - `docs/安装与前置条件.md` —— **三层依赖全解**：本机运行时 / `dws` CLI / 钉钉侧授权与权限。
    含 dws 支持的**平台矩阵**（Windows / macOS / Linux × x64 / arm64）、postinstall 下载原生二进制的行为、
    解压工具依赖、组织级拦阻的处理路径、以及**一键核验清单**。
  - `docs/adr/0001-从手搓REST改为包装dws.md` —— 架构决策记录（ADR）。把 v0.1 → v0.2 的架构反转、
    被否决的替代方案、以及代价（新增外部依赖、子进程调用面）完整留痕。
  - `docs/实测/2026-09-14-钉钉AI表格实测记录.md` —— 逐次真机验证留痕。含环境基线、自检工具返回、
    踩到的 7 个坑、以及 4 项遗留问题。
  - `docs/README.md` —— 文档总索引（按问题找文档）。
  - `docs/images/panel-schematic.svg` —— 设置面板结构示意（**非截图**，真实截图待补）。
  - `docs/发布与版本管理.md` —— 上传 GitHub 与版本升级发布的完整 runbook：环境体检、
    **嵌套仓库处理**、首次发布六步、版本号判定（含本项目特有的"破坏性变更"清单）、
    发布策略三案、发布前检查清单。
- **`assets/` 品牌资产**：`logo.svg` / `logo-readme.svg` / `logo-wordmark.svg`（技术占位，待视觉定稿）。
- **README 门面化**：顶部主视觉 + 徽章组 + 语种切换、`## 简介`、`## 界面`、`## 能力一览`、
  `## 检查与安装更新`、`## 联系方式`、`## 贡献者`、`## 许可与非官方声明`。
- **`.all-contributorsrc`**：接入 All Contributors 规范。

### 修复

- **🔴 发布阻断级：`package.json` 的 `files` 白名单漏了 `scripts/`**，
  却声明了 `postinstall: node scripts/postinstall.mjs`。
  由于开发机走 `link:` 软链装载、`files` 字段**完全不生效**，这个缺陷在本地**永远不会显形**；
  一旦 `npm publish`，安装方的 postinstall 找不到文件，**`npm install` 直接失败**。
  已修：`files` 补入 `scripts`（同时补入 `assets` / `plugin-src`，与 dsh-im 的白名单形态对齐）。
- **`verify-package.mjs` 断言盲区**：原「必需文件」断言只检查磁盘文件是否存在，
  **不检查 `files` 白名单的自洽性**——所以上面那条漏件它一声不吭。
  已新增**第八类断言「发布白名单自洽」**：
  ① 白名单每条在磁盘上存在；② 生命周期脚本引用的文件其目录已入包；③ `package.json` 声明的入口（`main` / `exports` / `bin`）已入包。
- `author` 由字符串改为对象形式（附 `url`），并新增 `contributors` 数组。

### 变更

- **新增 `prepublishOnly: npm run check` 钩子** —— `npm publish` 前强制跑通 build + test + 八类断言。
  防的是"改了源码没重新构建就发布"与"契约漂移的包被发出去"这两类事故。
- `keywords` 扩充：补 `dingtalk-workspace-cli` / `dws` / `scheduled-export` / `rpa` / `mcp` / `agent-tools`。
- `README.en.md` 与中文版对齐（补顶部视觉、Overview、Screenshots、文档索引与许可声明）。

### 安全

- **公开仓库脱敏**：清除文档中的内部信息（组织名、人名、内部工作区路径与代号），一律改为通用表述或占位符。
- **新增可选私有词表扫描（`⑦-2`）**：`DSH_PRIVATE_TERMS` 环境变量指向一份**仓库外的**词表，
  `npm run verify` 会扫全仓文本文件，命中任一词条即失败。
  词表刻意不入仓——`scripts/` 在 `files` 白名单里，放进去会被打进发布包，
  那就成了「防泄漏的机制自己泄漏」。未设置环境变量时该项自动跳过。

### 已知未完成（截至 2026-09-14）

- **GitHub About 区 `topics` 仍为空**：`description` 已填、`license` 已由 GitHub 自动识别为 MIT；
  `topics` 仍为 `[]`（该输入框需**每输一个按一次回车**才会成为标签）。
- **面板真实截图待补**：清单与打码要求见 `docs/images/README.md`。
- **联系方式二维码待补**：README「联系方式」一节留有占位。
- **README 中指向 `docs/…` 的相对链接在 npm 包页是否可点** —— `docs/` 不在 `files` 白名单内，
  社区有大量同类报告（WordPress/gutenberg#36426 等），**待人工点一次确认**。

---

### 首发内容与架构反转留痕

**v0.1 → v0.2 → v1.0.0 之间发生过一次架构级反转**，在此完整留痕，便于使用者理解取舍。

### 架构（重要）

- **从「手搓 REST」改为「包装 dws」**。v0.1 自己实现 AI 表格 REST 调用（端点靠推断、自己管 token 与分页）；
  v0.2 起改为包装钉钉官方 `dws`（`dingtalk-workspace-cli`）执行 `dws aitable ...`。
  事实依据：钉钉官方 OpenClaw connector（`DingTalk-Real-AI/dingtalk-openclaw-connector`）自己也不直连 REST，
  而是注入 `DWS_CLIENT_ID/SECRET` 后调用 dws（2026-09-14 直读其仓库确认，非推测）。
  **收益**：消除了 v0.1 全部端点不确定性；鉴权、分页、错误码交由官方 CLI 维护。

- **纠正 v0.1 的三处硬错误**（钉钉官方文档明确点名）：
  1. `sheetId` → 正确是 `tableId`（数据模型是 base / table / field / record）；
  2. 记录写入 `cells` 的 key 必须是 **`fieldId`（fldXXX）**，不是字段名；
  3. 更新记录必须带 **`recordId`**。

- **发布形态对齐生态惯例**：源码在 `plugin-src/`，`lib/` 为 `npm run build` 产物；
  引入 esbuild 构建客户端产物；新增 `scripts/verify-package.mjs` 把打包契约变成 CI 断言。

### 新增

- **10 个工具**：`dingtalk_aitable_diagnose`（自检）、`dingtalk_aitable_base`、`dingtalk_aitable_table`、
  `dingtalk_aitable_field`、`dingtalk_aitable_record_query`、`dingtalk_aitable_record_write`、
  `dingtalk_aitable_raw`（受控直通）、`dingtalk_aitable_scan`、`dingtalk_aitable_export_csv`、
  `dingtalk_sync_job`（定时导出）。
- **设置面板「钉钉文档」**（`settings.section`，order 22）：账号绑定 / AI 表格清单 / 定时导出三区。
- **多账号支持**：扫码绑定、列出全部 profile、移除单个接入（二次确认）。
- **定时导出**：每天/每周固定时间导出 CSV 并覆盖同名文件；支持立即执行、启停、删除。
- **导出安全开关**：`exportRoot` 可把落盘限制在指定目录内。
- **CLI 引导**：`npx @yiyunet/dsh-dingtalk-connector install|doctor`。

### 安全

- 写与删除门禁**默认全关**（`allowWrite` / `allowDelete`），删除另需逐次 `confirm: true`。
- 凭证**只走环境变量**注入子进程，**不进命令行参数**（避免出现在进程列表里）。
- 参数**逐元素**传给 `dws`，不经字符串拼接；Windows 上可配置 `dwsEntry` 指向 JS 入口以完全绕开 shell
  （否则含引号 / `&` / `|` 的记录文本会被硬拒绝，防注入）。
- `connection` 服务采用 **scoped 注入**（`ctx.inject`），避免在无 web 平面的 profile 里整个插件失效。
- 二维码由宿主用 `qrcode` 本地生成，**不调用任何第三方二维码服务**（认证链接不外发）。

### 已知限制（明示，不掩饰）

- **定时器跑在 DSH host 进程内**：DSH 关着时不执行；重启后重算下次触发点。这是登记在案的接受语义。
- **"枚举全部 Base"在钉钉侧做不到**：`base list` 只给最近访问，`base search` 每次约 4 条且游标翻页无效
  （实测 `hasMore` 是误报）。扫描产出为"候选 ∪ 人工补录"，不保证穷尽。
- **`table get` 必须传 `tableIds`** 才返回字段目录。
- **新登录可能被组织策略拦阻**：需组织主管理员开启「允许成员通过 CLI 访问个人数据」。
  这是组织管理动作，不是技术配置。
- **Windows shell 模式下含 shell 元字符的参数会被拒绝**（`ARG_UNSAFE`）：请配置 `dwsEntry`。
- **`qrcode` 为可选依赖**：解析不到时面板明确降级为"只显示深链 + 授权码"，不影响授权流程。

### 前置条件

- `dws`（`dingtalk-workspace-cli`）**>= 1.0.6**，需另行安装：`npm i -g dingtalk-workspace-cli`。
- 钉钉开发者后台需开通 **AI 表格（多维表）记录读写**权限，并把应用加为目标 Base 的协作者（可编辑）。
  **这两件事缺一不可**，漏了必然 403。
