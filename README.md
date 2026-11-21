<p align="center">
  <img src="assets/icon.png" width="120" alt="Gemini 多合一粮仓" />
</p>

### 📦**Gemini 多合一粮仓（Robin / Web2API / 自定义 RPC）**
给自家桌宠搭的三合一 Gemini 喂食通道，WebUI 面板随切随用：
- **🐦 知更鸟模式（Robin）**：支持绑多个号轮着喂（主备切号 / 雨露均沾 / 谁额度多先吃谁），自带 5h & 周剩余额度小看板、原生多模态附件上传（图/音/视/PDF）和账号打码防社死。
- **🔑 Web2API 模式**：切过去直接填官方 Gemini API Key 或自建反代 Key，零门槛开箱即用。
- **🛠️ 自定义 RPC**：给喜欢自己搭网关的折腾党留的后门。

---

## 🚀 怎么塞进 Coopanion（30 秒装好）

1. 打开 Coopanion 的 **扩展 → 模型供应商（Provider）** 页面。
2. 展开 **「手动安装」→「从 npm 安装」**，填包名（不要粘贴网页链接）：
   ```text
   cortico-provider-gemini-gateway
   ```
   > 小提示：刚发新版未满 24 小时想抢鲜体验，记得把版本号带上，比如 `cortico-provider-gemini-gateway@0.1.8`。
3. 点 **「安装」**，装完 **重启 Coopanion**，去 **模型供应商 → 新建** 选它就能开喂啦！

**装不上？先看这两条避坑小纸条：**
- **提示找不到包 / 404**：多半是国内 npm 镜像还在同步中，去扩展页把 **「npm 源」留空保存**（切回官方源），或者等几分钟再试。
- **本机连不上 npm**：直接去 [Releases](https://github.com/Unnori/cortico-provider-gemini-gateway/releases) 下压缩包解压，在手动安装里切到 **「从本机目录安装」** 选文件夹照样能装。

---

## 🍱 三种喂食姿势，随切随用

不用死记一堆 JSON 字段——在连接配置页 **第一步** 选好模式，**第二步** 和 **第三步** 的面板会自动跟着变身，用到啥才给你看啥。

### 1. 🐦 知更鸟模式（Robin 桌面 OAuth）

专门为想用消费级账号喂桌宠准备的省心模式：

- **先说安全底线**：出于公开分发规范，包里的 [desktop-oauth.example.json](resources/desktop-oauth.example.json) 默认把 `clientId` 和 `clientSecret` 留空，**绝不在安装包里夹带任何密钥**。打开第二步如果还没填过配置，输入框会自动展开，把你自己准备好的 OAuth 客户端 JSON 粘进去点 **「保存 OAuth 配置」**，就可以点 **「打开浏览器认证」** 登录啦（自己换设备或备份时，也能点 **「复制当前配置」** 一键带走）。
- **多号轮着喂，三种调度随你切**：往同一个供应商里想绑几个 Google 账号就绑几个，面板会按策略自动变样：
  - **主备切号（故障转移）**：平时盯着主号吃，主号撞 429 限流、报异常或刷新失败，立刻自动冷却并无缝切给备用号顶上。
  - **雨露均沾（轮询）**：取消主从高低，每个号平起平坐轮流上阵，卡片直接亮出大家的周额度条。
  - **谁额度多先吃谁（额度优先）**：实时按 **每周剩余额度** 从多到少排队，粮最足的号自动顶到前面，尽量不把单号周额度吃穿。
- **几个超顺手的小功能**：
  - **账号打码防社死**：所有邮箱全局默认打成 `5***3@gmail.com`，截图、录屏、发教程都安心；想核对原名时点一下 **「显示账号名」** 就能一键显隐。
  - **条款状态小助手**：新绑进来的号，或者上游提示还没同意服务条款时，对应卡片会亮出 **「同意条款」** 按钮，点一下搞定，通过后按钮自动消失。
  - **原生多模态上传不串号**：支持通过 Robin 默认通道上传图片（含 GIF/HEIC）、音频（MP3/WAV/OGG/M4A/FLAC 等）、视频（MP4/WebM/MOV 等）与 PDF/文本，按账号单独缓存和上传，并在「模型输入与计价」中按类别开关控制。
  - **内置省粮瘦身三件套**：专门针对桌宠长对话 + 多步调工具的耗粮痛点做了底层减负——① **历史附件只带最新一轮**，旧轮次截图或媒体附件自动换成轻量占位，不再反复重读；② **自动剥离旧轮次思考链**，不把上几轮的草稿文本滚雪球喂回去（当前轮思考照常输出）；③ **工具 Schema 无损去噪**，只剔除 `$schema`、`additionalProperties`、空数组等纯格式样板，完整保留全部工具说明与参数定义，省额度同时尽量保持工具调用准确。
  - **独立代理小通道（可选）**：第一步「测试连接」上方新增了 **独立代理地址** 输入框（留空默认跟系统代理，支持填 `7890` 或 `http://127.0.0.1:7890` 的 HTTP/混合代理端口）。日常系统代理继续挂香港逛网页打游戏，给桌宠单独分一条美/日/新端口，全平台（Windows / macOS / Linux）都能轻松分流，OAuth 登录、查额度、传附件和对话全链路生效。
  - **额度小看板（默认剩余显示 + 一键切换）**：第三步自带 **5 小时窗口 + 每周上限** 双进度条，默认按**剩余额度**展示（满格代表余量充足），也可在工具栏点击「显示：剩余额度 / 显示：已用用量」随时切换并同步到第二步卡片；小科普一下，Robin 是按算力权重扣的（上下文越长、开深度思考、用 Pro/Neon 档掉得越快；Fast/Hydrogen 档日常最划算；Flash-Lite 最轻，主额度吃空后通常也会自动回落到它兜底）。

---

### 2. 🔑 Web2API 模式（官方 API Key / 自建反代）

不想折腾 OAuth，只想拿个 Key 直接开聊？选它准没错：

1. 第一步切到 **「Web2API Gemini」**，Base URL 填官方 `https://generativelanguage.googleapis.com` 或者你自己的反代地址（比如 [`gemini-web2api-go`](https://github.com/zexadev/gemini-web2api-go)）。
2. 第二步会自动变成 **「API 密钥配置」**，直接粘进官方 API Key 或反代 Key，按网关习惯选一下 `x-goog-api-key` / `Authorization: Bearer` / 自定义请求头预设，保存就能聊。
3. 密钥单独保存在端点数据目录里（仅当前用户可读），既不进代码仓库，也不会写死进配置模板。

---

### 3. 🛠️ 自定义 RPC 模式（给折腾党留的后门）

如果你自己手搓了会话式转发网关，第一步切到 **「自定义 RPC」**：
- 第二步管鉴权（API Key 或自定义 OAuth 都行）。
- 第三步直接变成 **「自定义路由与端点」**，生成、上传附件、删临时会话、查额度四条路由随便改。

顺手附一张进阶玩家用的字段速查表（WebUI 改完会自动写入 `config.json`，想手写也能参考 [provider.example.json](resources/provider.example.json)）：

| 你想调啥 | 对应字段 | 怎么玩 |
| --- | --- | --- |
| 走哪种协议 | `options.protocol` | `robin`（知更鸟）/ `gemini`（原生 REST）/ `rpc`（自定义会话剧本） |
| 生成接口路由 | `options.generationEndpoint` | 支持相对路由、绝对 URL 和 `{model}` 占位符；不填会按协议自动套默认值 |
| 附件上传路由 | `options.uploadEndpoint` | 给自建 RPC / 反代用：multipart POST 发 `file` 和 `mimeType`，自动识别返回的 `id` / `attachmentId` / `fileUri` |
| 聊完自动清会话 | `options.deleteEndpoint` / `options.temporaryChat` | 默认开启无痕（`temporaryChat: true`）；填了删除路由后，哪怕对话中途打断也会帮你把临时会话清干净 |
| 会话 ID 响应头 | `options.conversationHeader` | 网关把会话 ID 塞在响应头里时改这里，默认读 `x-conversation-id` |
| 自定义请求头 | `options.headers` / `options.secretHeaders` | 明文头放前者，不想明文暴露的头用后者映射到 `.env` 变量名 |
| 鉴权头格式 | `options.credentialHeader` / `options.authHeader` | API Key 默认走 `x-goog-api-key`，OAuth 默认走 `Authorization: Bearer `，随时可改 |
| 模型目录源 | `options.modelsDevUrl` / `options.openRouterUrl` | 默认自动拉 `models.dev`（失败兜底 `OpenRouter`，缓存 24h）；未收录的 `gemini-*` 自动按 1M 上下文 / 64K 输出基线兜底 |

> 协议实现细节都整理在 [docs/DESKTOP_OAUTH.md](docs/DESKTOP_OAUTH.md) 和 [docs/GEMINI_REST.md](docs/GEMINI_REST.md) 里，折腾魔改时可以当字典翻；另外还支持直接 `import { GatewayClient }` 自己写 `encodeRequest` / `decodeEvent` 接奇奇怪怪的网关格式。

---

## 💻 命令行 & 开发者小工具

- **纯命令行登录 OAuth**（跑独立脚本时会自动读 `HTTPS_PROXY` / `HTTP_PROXY` 和 Windows 系统代理，记得让代理放行 `localhost` 回环回调）：
  ```sh
  pnpm login /path/to/deployment/providers/<端点目录>
  ```
  令牌会自动存在端点目录的 `oauth-accounts.json`（并同步主号到 `oauth-tokens.json`），快过期自动续期，401 自动抢救重放一次。

- **本地改代码 & 跑体检**：
  ```sh
  pnpm install
  pnpm verify   # 一键打 WebUI 包 + 双向 TS 类型检查 + 跑全套单元测试
  ```

---

## ⚠️ 温馨小提醒

- **知更鸟（Robin）模式**走的是非官方消费级接口，请合理控制频率、善用多账号分摊，别把心爱的账号累到吃红牌；要绝对稳妥直接切 **Web2API 模式** 上官方 API Key 就好。
- 本扩展采用 **MIT** 协议开源，欢迎提 Issue 或一起来玩。

---

<p align="center">
  Made with ❤️ by <strong>云纪&云洄</strong>
</p>
