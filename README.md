# dsh-dingtalk-connector

**让钉钉 AI 表格的数据，流进 DeepSeek Harness。**

MIT · 独立社区插件 · **与钉钉（DingTalk）、DeepSeek 无隶属或背书关系**
[安全与边界](#安全与边界) · [卸载与残留](#更新与卸载)

中文 | [English](README.en.md)

---

## 这是什么，适不适合你

一个 DSH 插件，把**钉钉 AI 表格**（多维表 / aitable）接到 DeepSeek Harness 上。装完即得 **10 个 `dingtalk_aitable_*` 工具**和一个 **「ANB 工具 → 钉钉文档」面板**——在 Harness 里直接发现 Base、读数据表、按条件查记录、批量写回、导出带 BOM 的中文 CSV，并支持**定时导出**。

**架构**：包装钉钉官方 `dws`（`dingtalk-workspace-cli`）执行 `dws aitable ...`，**不直连 REST**。这与钉钉官方 OpenClaw connector **同构**——它自己也不直连 REST，而是注入 `DWS_CLIENT_ID/SECRET` 后调 `dws`（**实测**，2026-09-14 直读其仓库确认）。

**设计取向**：**只读优先 + 写门禁**。写与删除默认全关，删除还需每次逐条确认。宁可多一步确认，也不给"模型幻觉 + 权限过大"留组合空间。

> **这不是一个自包含插件**——它依赖外部 CLI `dws`。**三层依赖（Node / dws / 钉钉侧授权）缺一不可。**

## 首屏必读三条

> 这三条最容易被误解，先看这里再看细节。

1. **定时器跑在 DSH host 进程内**——DSH 关着时不执行，重启后重算下次触发点。**不是**云端定时。
2. **钉钉侧没有"列出全部 Base"的接口**——扫描产出是「候选 ∪ 人工补录」，**不保证穷尽**；且 `base search` 的 `hasMore: true` 是**误报**（游标翻页无效）。
3. **写与删除门禁默认全关**——删除还需每次 `confirm=true`。

> 本文每条技术结论均标明来源档位：**实测** / **官方原文** / **推测**，并附取得日期。

## 能保证什么，不能保证什么

| | 内容 |
|---|---|
| **保证** | 工具跑的是官方 CLI 的命令面（端点、鉴权、分页由 `dws` 负责）；写与删除默认不可用；CSV 带 BOM 并回读首 3 字节自证；面板可用性可用 `diagnose` 的 `rpcEndpoint.registered` 自证 |
| **不保证** | 扫描能穷尽你组织下的全部 Base（钉钉侧无此接口）；模型不会误操作（写门禁只降低暴露面，不消灭风险）；钉钉 API 变更后的行为（跟随 `dws` 版本） |
| **官方自身提醒** | 官方 connector 明确：模型幻觉、执行不可控、提示词注入是固有风险，建议**避免在企业生产环境直接部署** |

## 前置条件（三层依赖，缺一不可）

| 层 | 要求 |
|---|---|
| ① 本机运行时 | **Node ≥ 22.19**；DSH `0.1.2-alpha.4` ~ `0.1.5-alpha.1` |
| ② dws CLI | `npm i -g dingtalk-workspace-cli`，**版本 ≥ 1.0.6**（实测基线 `v1.0.61`） |
| ③ 钉钉侧 | 授权 ＋ 开通「AI 表格记录读写」权限 ＋ **把应用加为 Base 协作者（可编辑）★最易漏** |

### 1 安装 dws

```sh
npm i -g dingtalk-workspace-cli
dws --version          # 必须 >= 1.0.6
npm root -g            # 记下前缀，Windows 上要用它填 dwsEntry
```

> ⚠️ `dws` **不是纯 JS 包**——它带 `postinstall`，安装时**下载并解压一个平台原生二进制**（约 25 MB）。支持 Windows / macOS / Linux 的 x64 与 arm64 六个平台。解压依赖：Windows 用系统自带 `powershell.exe`，macOS / Linux 需要 `tar` 或 `unzip`。完整矩阵见 [docs/安装与前置条件.md](docs/安装与前置条件.md)。

### 2 授权（二选一）

**方式 A — 扫码登录（交互式）**

```sh
dws auth login         # 钉钉 App 扫码授权；token 自动刷新（access 2h / refresh 30d）
dws auth status        # 确认已登录
```

**方式 B — 复用钉钉应用凭证（headless / 推荐给服务器）**

```sh
# Windows
set DWS_CLIENT_ID=<你的 Client ID>
set DWS_CLIENT_SECRET=<你的 Client Secret>
# macOS / Linux
export DWS_CLIENT_ID=<你的 Client ID>
export DWS_CLIENT_SECRET=<你的 Client Secret>

dws auth login
```

> 凭证优先级：`--token` > `DWS_CLIENT_ID/SECRET` > OAuth 加密存储。凭证**只走环境变量**注入子进程，不进命令行参数（避免出现在进程列表里）。

### 3 开通权限（**极易漏，漏了必 403**）

1. **钉钉开发者后台** → 该应用 → 权限管理 → 开通 **AI 表格（多维表）记录读写**权限 → **发布生效**
2. **目标 Base** → 右上角「协作/分享」→ 把该应用加为协作者，权限给到**可编辑**

> 这两件事缺一不可。`dws` 报 `permission denied` / 403 时，九成是这里没做完。

## 安装

```sh
# 从 npm 安装
dsh plugin --profile web add dsh-dingtalk-connector

# 或从本地路径安装（开发时）
dsh plugin --profile web add "<本仓库绝对路径>"

dsh --profile web --dump-config          # 期望看到 dingtalk-connector 这一层
```

然后重启 `dsh web`。

自带一个引导 CLI：

```sh
npx dsh-dingtalk-connector install [--profile web]   # 安装 + 核对配置层
npx dsh-dingtalk-connector doctor                    # 体检：dsh / dws / Node / 授权状态
```

**想撤掉它**：见[更新与卸载](#更新与卸载)。

## 快速开始：把一张表导成可用的 CSV

装好不等于能用。四步的落点是**一份能在 Excel 里正常打开的中文 CSV**。

1. **给什么输入** —— 一个关键词（用于发现 Base）或一个已知的 `baseId`，以及一个绝对路径的输出文件。
2. **做什么操作** —— 先跑 `dingtalk_aitable_diagnose` 自检；再 `dingtalk_aitable_scan(keywords="关键词", withTables=true)` 找到 `baseId` 与 `tableId`；然后 `dingtalk_aitable_export_csv(baseId, tableId, outputPath="<绝对路径>.csv")`。
3. **结果出现在哪** —— 文件落在 `outputPath`；表头用字段中文名；文件以 `\uFEFF` 开头。
4. **怎样判断符合预期** —— **用 Excel 打开，中文不乱码**（这是 BOM 生效的唯一可视证据）；表头与你在钉钉里看到的字段名一致；条数与钉钉里的一致。**任一不符就先用 `dingtalk_aitable_record_query(all=true)` 对账，别急着上定时任务。**

## 日常使用

**主线，端到端。** 扫到表 → 导一份验证 → 建定时任务 → 每天自动覆盖同名文件。

```
① dingtalk_aitable_scan(keywords="关键词A,关键词B", withTables=true)
      → 候选 Base 清单 + 每个的「可读性实测」（readable / 失败原因）
      → 记下要关注的表：baseId + tableId

② dingtalk_aitable_export_csv(baseId, tableId, outputPath="<绝对路径>.csv")
      → 立即导一份，验证表头/编码/条数对不对

③ dingtalk_sync_job(action="create", baseId, tableId,
                    outputPath="<绝对路径>.csv",
                    frequency="daily", time="09:00", label="订单销售日更")
      → 每天 09:00 自动导出并覆盖同名文件

④ dingtalk_sync_job(action="list")                    # 看下次触发时间与上次结果
   dingtalk_sync_job(action="run-now", id="<id>")     # 立即跑一次验证
```

**第二次及以后的最短路径。** 表没变就什么都不用做；只想确认任务活着，跑 `dingtalk_sync_job(action="list")`。

**⚠️ 三条必须知道的语义**

1. **定时器跑在 DSH host 进程内**：DSH 关着时**不会执行**（已确认接受的语义）；重启后自动重算下次触发点。
2. **"枚举全部 Base"在钉钉侧做不到**：`base list` 只给最近访问，`base search` 每次约 4 条且**游标翻页无效**。所以扫描是"多渠道候选 ∪ 人工补录"，**不保证穷尽**——多给关键词，或直接给 baseId 补录。
3. **CSV 必须带 BOM**：插件的 CSV 以 `\uFEFF` 开头，这是 Excel 正确识别 UTF-8 中文的唯一条件。插件落盘后会**回读首 3 字节**自证（编辑器看不见 BOM，ripgrep 还会主动剥掉它）。

## 设置面板

**入口**：**设置 → ANB 工具 → 「钉钉文档」**（壳 order 16，本标签在壳内 order 10）。

> 「ANB 工具」壳由本包**内置**，不是一个需要额外安装的包：装任一 ANB 系列插件，壳就自带。多个 ANB 插件同时装时**只有一个壳**（运行时单例）——谁先起来谁登记，其余让位；登记者被禁用后由下一个 ANB 插件接管，标签栏依次列出各面板。

| 区 | 内容 |
|---|---|
| **账号绑定** | CLI 版本、企业名 / 用户名、access token 到期、凭证来源、写门禁状态；含扫码绑定会话（二维码 / 深链 / 原始输出 / 组织拦阻提示） |
| **AI 表格清单** | 输入关键词 → 扫描（候选发现 + **可读性实测**）→ 每个 Base 标「可读/不可读」→ 展开看数据表 → 单选一张表 → **复制 Base ID / Table ID** |
| **定时导出** | 选中的表 + 输出路径 + 每天/每周 + 时间 → 新建任务；任务表显示下次/上次结果，支持**立即执行 / 启停 / 删除** |

面板可用性自证：`dingtalk_aitable_diagnose` 返回里带 `rpcEndpoint` 字段，`registered: true` 才说明 RPC 端点挂上了。

### 配置（`cordis.patch.yml`）

| 配置项 | 默认 | 说明 |
|---|---|---|
| `dwsCommand` | `dws` | PATH 上的命令名 |
| `dwsEntry` | 无 | **Windows 建议设**：dws 的 JS 入口绝对路径。设了就用 node 直接 spawn，**完全不走 shell** |
| `timeoutMs` | 60000 | 单条命令超时 |
| `clientIdEnv` / `clientSecretEnv` | `DWS_CLIENT_ID` / `DWS_CLIENT_SECRET` | 凭证环境变量名 |
| `allowWrite` | **false** | create / update 开关 |
| `allowDelete` | **false** | delete 开关（独立，且每次还要 `confirm=true`） |
| `maxBatch` | 30 | 单次批量上限（官方 connector 规定 ≤30） |
| `exportRoot` | 无 | 可选：把导出落盘**限制**在指定目录内 |
| `defaultExportDir` | 无 | 可选：面板「选表后自动填充」的目录 |
| `scanConcurrency` | 4 | 扫描可读性实测的并发数（防限流） |

**关于 `dwsEntry`（Windows 上的安全要点）**：Windows 上 `.cmd` 必须经 shell 启动，而 shell 会解释参数里的元字符——记录文本含引号或 `&`/`|` 时可能被注入。插件对此**硬拒绝**（返回 `ARG_UNSAFE` 并给出指引）。彻底解决：把 `dwsEntry` 指向 dws 的 JS 入口。

```yaml
dwsEntry: '<npm root -g>/dingtalk-workspace-cli/bin/dws.js'
```

## 十个工具

| 工具 | 作用 | 门禁 |
|---|---|---|
| `dingtalk_aitable_diagnose` | **自检**：dws 版本 / 授权状态 / 已注册命令 / RPC 端点 | 无 |
| `dingtalk_aitable_base` | Base 文件：list / search / get / create / update / delete | delete 需双锁 |
| `dingtalk_aitable_table` | 数据表：get（**必传 `tableIds` 才返回字段**）/ create / update / delete | delete 需双锁 |
| `dingtalk_aitable_field` | 字段：get / create / update / delete | delete 需双锁 |
| `dingtalk_aitable_record_query` | **读记录**（按 ID 或条件查；`all=true` 可全量拉） | 无 |
| `dingtalk_aitable_record_write` | 写记录：create / update / delete | write / delete 门禁 |
| `dingtalk_aitable_raw` | 受控直通：注册表内任意子命令 | 危险命令需双锁 |
| `dingtalk_aitable_scan` | 候选 Base 发现 + **可读性实测** | 无 |
| `dingtalk_aitable_export_csv` | 全量导出 CSV（**带 BOM**，表头用字段中文名，**覆盖同名**） | 无（受 `exportRoot` 可选约束） |
| `dingtalk_sync_job` | 定时导出任务 create / list / remove / enable / disable / run-now | 无 |

**双锁** = `allowDelete: true`（配置层）+ `confirm: true`（逐次，表示已获同意）。

### 标准调用顺序（官方文档规定）

```
1. dws aitable base search --query "关键词"          → 提 baseId
2. dws aitable base get --base-id <B>                → 提 tableId
3. dws aitable table get --base-id <B> --table-id <T> → 提 fieldId  ★写记录前必须
4. dws aitable record query --base-id <B> --table-id <T>
5. dws aitable record create --records '[{"cells":{"fldXXX":"值"}}]'
```

插件调用等价：`base(action=search)` → `base(action=get)` → `table(action=get)` → `record_query` → `record_write`。

拿不到 baseId 时注意：`base list` **只返回最近访问过的** Base，用前端打开一次该表，或改用 `base search`。

### cells 读写格式速查（官方）

| 字段类型 | 写入 | 读取返回 |
|---|---|---|
| text | `"字符串"` | `"字符串"` |
| number | `123` | `"123"` |
| singleSelect | `"选项名"` 或 `{"id":"xxx"}` | `{"id":"x","name":"选项名"}` |
| multipleSelect | `["选项A","选项B"]` | `[{"id":"x","name":"选项A"}]` |
| date | `"2026-03-13"` | ISO 字符串 |
| checkbox | `true`/`false` | `true`/`false` |
| user | `[{"userId":"xxx"}]` | `[{"corpId":"x","userId":"x"}]` |
| url | `{"text":"显示文本","link":"https://..."}` | 同写入 |
| richText | `{"markdown":"**加粗**"}` | 同写入 |

> 过滤（filters）里 singleSelect 建议用 **option id**（从 `field get` 取）更可靠；写入时可直接用选项名。

### 多账号：扫码绑定 / 移除接入

| 能力 | 命令 | 说明 |
|---|---|---|
| 列出已绑定账号 | `dws profile list --format json` | 一个 profile = 一个 `corpId + userId`；**可同时绑多个账号** |
| 移除接入 | `dws auth logout --profile <corpId:userId>` | 精确选择器**只退一个账号**（不传则退全部）；面板做**二次确认** |
| 扫码绑定 | `dws auth login --device --recommend --format json` | 面板「扫码绑定」按钮；输出实时回显，成功后自动刷新账号列表 |

#### 两点必须知道的事实（实测，避免误判）

**① dws 的设备流不输出二维码。** 它只给 `link:`、`authorization code:` 和带 `user_code` 的深链。因此**二维码由本插件自己生成**：宿主侧用 `qrcode` 包把深链画成 SVG data URL，前端只渲染 `<img>`。**绝不调用第三方二维码服务**——认证链接不外发。解析失败时降级为"只显示深链 + 授权码"。

**② 本机已登录钉钉时，设备流可能「无需扫码」即完成。** 这不是"系统自动批准"，而是本机当前已处于钉钉登录态，设备流可直接选定对应的钉钉账号与组织。推论：点「扫码绑定」在已登录机器上**可能不弹码直接完成**（用的是本机当前选定的账号/组织，不是让你重新挑）；「探测输出 8 秒」这个按钮**不是零副作用**——若组织已开启 CLI 访问，探测即可能真的新增账号。

#### ⛔ 已知阻塞：组织未开启 CLI 个人数据访问

新登录会走到 Step 4 被拦下：`CLI data access is not enabled for this organization`。**需组织主管理员**在钉钉开放平台 → 开发者设置 开启该开关后重新扫码。**这是组织管理动作，不是技术配置**；未解决前，"多账号"实际只能绑到 1 个账号。

> 注：现有登录在此开关未开的情况下**仍可用**（`auth status` 有效、数据可读）。新登录被拦而旧会话可用的原因尚未查明，建议由管理员核对该开关的真实状态。

## 出问题时怎么办

| 信号 | 含义 | 处理 |
|---|---|---|
| `command not found: dws` | CLI 未安装 | `npm i -g dingtalk-workspace-cli` |
| `请先执行 dws login` | 未授权 | `dws auth login` |
| `AUTH_TOKEN_EXPIRED` / `USER_TOKEN_ILLEGAL` | token 过期 | 重新 `dws auth login` |
| `permission denied` / 403 | 权限不足 | 开发者后台开 AI 表格权限 + 把应用加为 Base 协作者 |
| `RECOVERY_EVENT_ID=<id>` | 已持久化失败快照 | 按 `dws recovery plan/execute/finalize` 闭环 |
| `ARG_UNSAFE` | 参数含 shell 元字符 | 配置 `dwsEntry` 走无 shell 模式 |
| `PAGING_TRUNCATED` | 达到翻页上限 | 用返回的 cursor 续拉，或调大 `pageLimit` |
| 面板一片空白/「空壳」 | RPC 信封形状或端点名不一致 | 跑 `npm run verify`（会校验端点一致性） |
| 插件加载不了、日志说入口缺失 | `lib/` 没构建 | `npm run doctor` 确认 → `npm run build` |

## 安全与边界

- **写门禁默认全关**；删除另需逐次 `confirm=true`（双锁）。
- **凭证只走环境变量**注入子进程，不进命令行参数。
- **参数逐元素传递**，绝不拼成 shell 字符串；设了 `dwsEntry` 即完全无 shell，否则有硬校验。
- **客户端不硬编码导出路径**：默认目录由宿主下发（`defaultExportDir`）。
- **工具可见性**：宿主侧 bundle 挂 host plane，该 profile 下所有会话都能看到这 10 个工具。
- 官方 connector 自身的安全提醒同样适用：**模型幻觉 / 执行不可控 / 提示词注入**是固有风险；官方建议"避免在企业生产环境直接部署"。本插件用**只读优先 + 写门禁**降低暴露面。
- 本插件为**非官方**社区集成，与钉钉、DeepSeek 无隶属或背书关系。

## 数据、权限与隐私

- **读什么** —— 钉钉 AI 表格里你有权访问的 Base / 表 / 字段 / 记录；本机 `dws` 的授权状态与版本。
- **是否外发及目标域名** —— 只经 `dws` 调钉钉官方接口（凭证由 `dws` 管理）；**本插件自身不向第三方发送任何数据**，无遥测端点。
- **是否落盘及位置** —— 导出的 CSV 落在你指定的 `outputPath`（可用 `exportRoot` 限制目录）；定时任务定义由 DSH 存储；本插件不额外落盘。
- **谁可读写** —— 只有运行 DSH 的操作系统账户；凭证在 `dws` 的 OAuth 加密存储或你提供的环境变量里。
- **关键默认开关** —— `allowWrite: false`、`allowDelete: false`、`confirm` 每次单独给。
- **凭据存哪、是否进日志** —— 凭证只以环境变量注入子进程；工具回传不含凭证；面板显示的账号信息仅企业名/用户名与到期时间。

## 兼容性：要求、已验证、仍未确认

- **要求** —— Node ≥ 22.19；`dws` ≥ 1.0.6；DSH `0.1.2-alpha.4` ~ `0.1.5-alpha.1`；钉钉侧开通记录读写权限并把应用加为 Base 协作者。
- **已验证** —— 十个工具在该 DSH 版本区间可用；CSV 带 BOM 并回读自证；扫码绑定 / 多账号 / 移除接入已实现并实测；面板 RPC 端点可用 `diagnose` 自证。
- **仍未确认** —— 组织未开 CLI 个人数据访问时的新登录行为（已知阻塞，见上）；`dws` 升级带来的命令面变化（插件版本不变也可能异常，**先查 `dws --version`**）。

## 开发

```sh
npm install          # 装 esbuild（构建期）与可选的 qrcode；装完会自动构建（prepare）
npm run build        # plugin-src/ → lib/
npm test             # node --test 纯函数测试（调度 / CSV / 任务存储 / 命令注册表）
npm run verify       # 八类发布契约断言
npm run doctor       # 环境自检（只读）
npm run inspect      # 诊断：lib/client.js 的体量/行数/关键标记实况
npm run check        # build && test && verify   ← CI 跑的就是这一条
```

**绝不要直接改 `lib/`** —— 它是构建产物，会被下次构建覆盖。**唯一真源是 `plugin-src/`。**

### `lib/` 不在版本库里——删了、重置了、重装后都要重建

`lib/` 与 `node_modules/` 都在 `.gitignore` 里，但包清单的 `main` 指向 `lib/index.mjs`。后果是：**`lib/` 缺失时插件加载不了**，而症状只是一句晦涩的模块找不到，不会告诉你"你还没构建"。两道防护：

| 防护 | 行为 |
|---|---|
| `prepare` 钩子 | `npm install` 装完自动跑一次构建。**它永不失败**（构建失败也只打印指引）；别人把它当依赖安装时静默跳过（发布包自带 `lib/`）。⚠️ **为什么是 `prepare` 而不是 `postinstall`**：pnpm 10+ 默认**拦截依赖的安装期脚本**（供应链防护），`postinstall` 会让**消费者侧直接安装失败**（`ERR_PNPM_IGNORED_BUILDS`）；而 `prepare` 对 registry 依赖根本不执行，恰好不在拦截范围内 |
| `npm run doctor` | 只读自检，逐项报告「Node / esbuild / 宿主源文件 / `lib/` 产物 / qrcode」是否就位 |

**症状对照**：DSH 起不来、日志说模块找不到或入口缺失 → 九成是 `lib/` 不在 → `npm run doctor` 确认 → `npm run build`。

### 为什么匹配产物时要"解转义"

**esbuild 默认把非 ASCII 字符（如中文）输出成 `\uXXXX` 转义。** 所以"源码里写着「钉钉文档」"和"产物里能 `includes('钉钉文档')`"是两回事——直接匹配会把一个**完全正确**的产物判成"契约漂移"。`scripts/bundle-markers.mjs` 提供 `containsMarker()`：**原样或解转义后命中都算通过**。

### 发布契约断言（`npm run verify` 八类）

1. 必需文件齐全 2. **任何依赖节与 lock 文件都不得出现 `@deepseek-ai/dsh-*`**（DSH 运行时包用模块局部 Symbol 做 key，装第二份物理副本会破坏 Host 查找）3. 客户端产物注册了正确的装载器 id（**与包名一致**）4. 客户端产物**自带 ANB 工具壳**并注册面板（`SHELL_ID='anb-toolbox'` order 16 / `anb.tool.tab` order 10）5. 客户端产物不含 ESM 顶层语法 6. **RPC 端点名在宿主源、客户端源、客户端产物三处一致** 7. 全仓不含个人绝对路径与凭证赋值 8. **`files` 白名单自洽**（白名单每条存在；生命周期脚本引用的文件目录已入包；声明的入口已入包）

> 为什么必须有第 8 条：本地 `link:` 装载时 `files` 字段**完全不生效**，漏件在开发机上永远看不见，只有发布之后才会在安装方那里炸成 `npm install` 失败。

### 构建/校验报错时的排查顺序

```
npm run inspect      # ① 产物实况：体量、行数、BOM、含不含转义、关键标记逐条命中
                     # ② 若真缺某项：去 plugin-src/client/impl.mjs 里搜该串
                     #    · 源码有、产物无 → 产物过期，重跑 npm run build
                     #    · 源码也无     → 契约漂移，改源码而不是改校验脚本
```

## 更新与卸载

```sh
# 升级插件
dsh plugin --profile web add dsh-dingtalk-connector

# 卸载
dsh plugin --profile web remove dsh-dingtalk-connector

# 顺带升级外部依赖 dws（它是独立包，不会随插件一起升）
npm i -g dingtalk-workspace-cli@latest
dws --version
```

> **`dws` 是本插件的外部前置依赖，不由插件管理。** 插件版本没变但行为异常时，**先查 `dws --version`**——很可能是 dws 升级带来了命令面变化。

**卸载与残留**：卸载移除插件代码；**导出的 CSV 与定时任务定义不会被删**，需要就手工清理。`dws` 与其授权状态属外部工具，卸载本插件不影响它。

升级后跑一次 `dingtalk_aitable_diagnose` 确认。

## 文档索引

根目录的 README 讲**怎么用**；`docs/` 讲**为什么这样做、当时验证了什么**。

| 文档 | 内容 |
|---|---|
| [docs/安装与前置条件.md](docs/安装与前置条件.md) | ★ **最先读这篇**：三层依赖全解，含平台矩阵与核验清单 |
| [docs/发布与版本管理.md](docs/发布与版本管理.md) | 上传 GitHub、升版本与发布、发布前检查清单 |
| [docs/README.md](docs/README.md) | 文档总索引（按问题找文档） |
| [docs/adr/0001-从手搓REST改为包装dws.md](docs/adr/0001-从手搓REST改为包装dws.md) | 架构决策记录：为什么废弃手搓 REST 改包装 `dws` |
| [docs/实测/](docs/实测/) | 逐次真机验证留痕（踩到的坑与确认的行为） |
| [CONTEXT.md](./CONTEXT.md) | 术语表与**禁用说法**——措辞精度在这里是功能，不是文风 |
| [CHANGELOG.md](./CHANGELOG.md) | 变更记录 |
| [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) | 第三方组件与商标声明 |

## 反馈

- **问题反馈 / 功能建议**：[提一个 issue](https://github.com/yiyunet/dsh-dingtalk-connector/issues/new/choose)。报问题时写上 **DSH 版本**和**插件版本**（版本看包清单或 `CHANGELOG.md`，本文不重复记录）。
- **安全相关**：请勿公开提 issue——本插件涉及钉钉凭证与组织数据访问。

> 模板会问版本号与系统；日志与截图**贴之前请先删掉钉钉凭证、手机号、组织名**。

## 贡献者

本项目采用 [All Contributors](https://allcontributors.org/en/reference/specification/) 规范，认可代码、文档、测试、问题反馈、想法和其他形式的贡献。名单由 [`.all-contributorsrc`](./.all-contributorsrc) 管理。

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

## 许可与非官方声明

- **许可**：[MIT](./LICENSE) © 2026 yiyunet
- **非官方**：本插件是**非官方社区集成**，与钉钉（DingTalk）、DeepSeek **无隶属或背书关系**。
- **外部依赖**：`dws`（`dingtalk-workspace-cli`）为钉钉官方发布，采用 **Apache-2.0**，版权归其作者所有。详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
