# Custom Gemini Gateway

Cortico Provider API 6 扩展。每次生成都携带完整的 Gemini 上下文，可连接自建或企业内部的会话式 RPC 网关，也可连接提供原生 Gemini 路由的 Web2API 实例。

## 端点配置

复制 [provider.example.json](resources/provider.example.json) 到部署目录的 `providers/<端点>/config.json`，填写 `baseUrl`、网关支持的 `spec.model` 和实际路由。

| 配置 | 默认行为 |
| --- | --- |
| `options.protocol` | `rpc` 发送单轮上下文剧本。`gemini` 发送原生 Gemini 请求。`robin` 发送 `RobinService` 的 `{ query: { text } }` 载荷。 |
| `options.generationEndpoint` | RPC 默认 `generate?$alt=json`。Gemini 默认 `v1beta/models/{model}:streamGenerateContent?alt=sse`。Robin 默认 `$rpc/assistant.mobile.robin.RobinService/StreamGenerate`。支持绝对 URL、相对路由和 `{model}` 占位符。 |
| `options.uploadEndpoint` | 配置后以 multipart POST 发送 `file` 与 `mimeType`，读取 `id`、`attachmentId`、`attachment_id` 或 `fileUri`。RPC / Robin 的 `inlineData` 需要这个端点或上传钩子。原生 Gemini 模式默认直接发送 `inlineData`。 |
| `options.deleteEndpoint` | 含 `{conversationId}` 时执行 `DELETE`；`robin` 协议下无占位符时向该端点 `POST { conversationId }`。会话 ID 可来自响应事件的 `conversationId` / `conversation_id` / `conversation.conversationId` 或 `options.conversationHeader` 指定的响应头，默认 `x-conversation-id`。 |
| `options.temporaryChat` | 默认 `true`，通过请求的 `temporary_chat` 传送。服务端实现决定是否遵循此标志。 |
| `options.headers` / `options.secretHeaders` | 自定义网关请求头。前者保存明文值，后者将请求头映射到部署端点 `.env` 的变量名。 |
| `secret` / `options.credentialHeader` / `options.credentialPrefix` | `secret` 为网关 API 密钥变量名。默认头为 `x-goog-api-key`，默认前缀为空。 |
| `options.authHeader` / `options.authPrefix` | 桌面 OAuth 默认使用 `Authorization` 和 `Bearer `。 |
| `options.modelsDevUrl` / `options.openRouterUrl` | 可覆盖公开模型目录的 URL。目录请求只带 JSON Accept 头。 |

`gemini-web2api-go` 使用 `protocol: "gemini"`。该项目的原生端点接受内联图片和视频。配置上传端点时，它要求 `fileData.fileUri` 是 HTTP(S) URL。音频、PDF、`temporary_chat` 以及会话删除取决于所接入的网关版本和路由。 [gemini-web2api-go 原生 Gemini 接口](https://github.com/zexadev/gemini-web2api-go/blob/main/internal/app/gemini_api.go)

## 桌面 OAuth 与多账号池

出于安全与分发合规考虑，扩展包内的 [desktop-oauth.example.json](resources/desktop-oauth.example.json) 仅保留结构模板，**不内置任何 `clientId` / `clientSecret`**。

- **在 WebUI 中配置（推荐）**：在连接配置页第二步「浏览器 OAuth 认证」中，未填写配置时会自动展开 **「OAuth 客户端配置 (desktop-oauth.json)」** 输入框；将自己准备的完整 JSON 粘贴进去点击「保存 OAuth 配置」后，即可点击「打开浏览器认证」登录。支持在单 Provider 内添加多个账号、切换主用号与调度策略（默认主备故障转移 / 平等轮询 / 按周剩余额度优先）、按账号追踪与一键同意 Robin 服务条款，所有账号名默认按 `5***3@gmail.com` 脱敏并可一键切换显示/隐藏。
- **使用官方 API Key（零 OAuth 授权）**：如不希望使用桌面 OAuth，可在第一步切换为 **「Web2API Gemini」**（认证模式 `api-key`）并填写自己的官方 API Key 或自建网关密钥。
- **CLI 方式配置**：将 [desktop-oauth.example.json](resources/desktop-oauth.example.json) 复制到端点目录并命名为 `desktop-oauth.json`，填入 `clientId`、可选 `clientSecret`、`scopes`、`authEndpoint` 和 `tokenEndpoint`。可通过 `authParams` 请求离线授权，通过 `tokenHeaders` 配置请求头，通过 `redirectHost` / `redirectPath` 覆盖回调 URI（默认 `http://127.0.0.1:<随机端口>/oauth/callback`，模板使用 `localhost` 与空路径 `""`）。

在扩展目录运行以下命令，并在浏览器中打开打印的授权链接（独立运行 CLI 会自动读取 `HTTPS_PROXY`/`HTTP_PROXY` 及 Windows 系统代理）：

```sh
pnpm login /path/to/deployment/providers/endpoint
```

多账号令牌保存在端点目录的 `oauth-accounts.json`（并同步主用号到 `oauth-tokens.json`），接近到期时自动续期。401 在流尚未对调用方输出分片时最多触发一次强制续期和重放；多账号模式下遇 429 / 403 / 刷新失败会自动冷却并无缝故障转移到下一个健康账号。

## 会话式 RPC

默认请求编码生成 `model`、`temporary_chat`、`stream` 和 `script`，其中 `script.system` 保存系统指令，`script.tools` 保存 JSON Schema，`script.turns` 按顺序携带文字、历史函数调用、函数结果和附件引用。响应支持 SSE、NDJSON、JSON 对象和流式 JSON 数组。默认映射接受 Gemini `candidates`、RPC `text` 或 `delta.text`，以及 `response` / `data` 对象封装。

可直接在 TypeScript 中实例化 `GatewayClient`，通过 `encodeRequest`、`decodeEvent`、`uploadAttachment(blob, mimeType)` 和 `deleteConversation(conversationId)` 接入不同的网关格式。完整的 `<tool_call>{"name":"lookup","args":{"q":"..."}}</tool_call>` 转成 Gemini `functionCall`，普通文字随流输出。提前结束迭代或发生流错误时，已收到的会话 ID 也会进入清理。

## 模型目录

模型目录优先使用 models.dev 的 Google 条目，失败时读取 OpenRouter，磁盘缓存有效期为 24 小时。目录未收录的 `gemini-*` 使用 1,048,576 上下文、65,536 输出和文本、图像、音频、PDF MIME 基线。远程价格以 USD/百万 token 作为参考价，部署的网关账单可有自己的价格。 [models.dev API](https://github.com/anomalyco/models.dev/blob/dev/README.md) [OpenRouter Models API](https://openrouter.ai/docs/api/api-reference/models/get-models)

在扩展目录运行 `pnpm install` 后可执行 `pnpm verify`（构建 WebUI、Node/Browser 双向类型检查与 Vitest 单元测试）。
