# docs/images/

存放 README 与文档引用的**截图与示意图**。

---

## ⚠️ 待补：真实面板截图

本目录目前**只有结构示意图，没有真实截图**。

原因：截取设置面板需要已通过 `dsh web` 鉴权的浏览器会话，自动化环境拿不到该会话，
**不敢用伪造图冒充真实截图**——那会让使用者按错误预期排故障。

**请按下表补图**（都是设置 → 「钉钉文档」面板内的区域，order 22，排在「IM机器人」之后）：

| 文件名 | 内容 | 建议尺寸 | 引用位置 |
|---|---|---|---|
| `screenshot-account.png` | **账号绑定区**：CLI 版本 / 企业名 / 用户名 / token 到期 / 凭证来源 / 写门禁状态 | 1600 宽 | README「界面」 |
| `screenshot-scan.png` | **AI 表格清单区**：关键词扫描结果 + 每个 Base 的「可读/不可读」标记 + 展开后的数据表 | 1600 宽 | README「界面」 |
| `screenshot-jobs.png` | **定时导出区**：任务表（下次/上次结果）+ 新建任务表单 | 1600 宽 | README「界面」 |
| `screenshot-qrcode.png` | **扫码绑定会话**：二维码 + 深链 + 授权码 | 800 宽 | README「多账号」 |
| `screenshot-menu.png` | 设置侧栏中「钉钉文档」这一项的**位置**（证明 order 22 的排位） | 800 宽 | 本文件 |

**截图要求**：

- 用**真实数据**，但**必须打码** —— 企业名、用户名、`corpId`、`userId`、Base 名、`baseId`/`tableId` 均属敏感信息
- 不要出现 Client Secret、token 明文
- 建议在**演示组织 / 测试 Base** 下截图，避免打码工作量

> 截图属**视觉呈现**，最终挑选与裁剪由设计定稿；本清单只负责技术规格与打码要求。

---

## 已有文件

| 文件 | 说明 |
|---|---|
| `panel-schematic.svg` | 面板结构示意（**非截图**）—— 在真实截图到位前，README 用它能完整表达面板能力 |

---

## 引用方式

```markdown
![AI 表格清单区](docs/images/screenshot-scan.png)
```

多图并排（README 首屏常用）：

```html
<img src="docs/images/screenshot-account.png" alt="账号绑定" width="49%">
<img src="docs/images/screenshot-scan.png" alt="AI 表格清单" width="49%">
```
