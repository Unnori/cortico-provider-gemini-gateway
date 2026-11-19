# Custom Gemini Gateway 待填配置清单

路径以扩展根目录为基准。将 `resources/provider.example.json` 复制为部署端点目录的 `config.json`。使用桌面 OAuth 时，再将 `resources/desktop-oauth.example.json` 复制为同一目录的 `desktop-oauth.json`。API 密钥与保密请求头的变量值由端点的 `.env` 提供。

| 文件路径 | 字段名 | 用途说明 | 当前示例 / 默认值 |
| --- | --- | --- | --- |
| [resources/desktop-oauth.example.json](resources/desktop-oauth.example.json#L2) | `clientId` | 已注册的桌面 OAuth 客户端 ID。启用 OAuth 时必填。 | 示例桌面客户端 ID |
| [resources/desktop-oauth.example.json](resources/desktop-oauth.example.json#L3) | `clientSecret` | 授权服务要求时填写客户端密钥。 | 示例密钥，空值不发送 |
| [resources/desktop-oauth.example.json](resources/desktop-oauth.example.json#L4-L9) | `scopes` | 授权服务允许的 Scope 字符串数组。 | `["openid","email","profile","https://www.googleapis.com/auth/gemini"]` |
| [resources/desktop-oauth.example.json](resources/desktop-oauth.example.json#L10) | `authEndpoint` | 浏览器授权页的绝对 URL。启用 OAuth 时必填。 | `https://accounts.google.com/o/oauth2/auth` |
| [resources/desktop-oauth.example.json](resources/desktop-oauth.example.json#L11) | `tokenEndpoint` | 交换授权码和刷新令牌的绝对 URL。启用 OAuth 时必填。 | `https://www.googleapis.com/oauth2/v4/token` |
| [resources/desktop-oauth.example.json](resources/desktop-oauth.example.json#L12) · [src/oauth.ts](src/oauth.ts#L126-L128) | `redirectHost` / `redirectPath` | 回环回调主机与路径。只允许 `127.0.0.1`、`localhost` 或 `[::1]`。 | 示例 `"localhost"` / `""`；省略时默认 `"127.0.0.1"` / `"/oauth/callback"` |
| [resources/desktop-oauth.example.json](resources/desktop-oauth.example.json#L13) | `authParams` | 附加授权查询参数，如授权服务器认可的离线授权参数。 | `{}` |
| [resources/desktop-oauth.example.json](resources/desktop-oauth.example.json#L14-L16) | `tokenHeaders` | 令牌请求的自定义请求头。可覆盖表单 Content-Type 和 JSON Accept。 | 示例桌面 `User-Agent` |
| [resources/provider.example.json](resources/provider.example.json#L3) | `baseUrl` | 网关基础 URL。具体查询参数填入路由。 | 示例 `https://robinfrontend-pa.googleapis.com`（通用默认 `http://127.0.0.1:8080`） |
| [resources/provider.example.json](resources/provider.example.json#L6) | `spec.model` | 网关实际接受的 Gemini 模型 ID，用于 RPC 请求体或原生 URL 中的 `{model}`。 | `"gemini-2.5-pro"` |
| [resources/provider.example.json](resources/provider.example.json#L7) | `spec.thinking` | 设置 Gemini 请求的 `thinkingConfig.includeThoughts`。 | `true` |
| [resources/provider.example.json](resources/provider.example.json#L4) | `multimodal` | Cortico 端点的图片输入开关。模型 MIME 能力另由目录判断。 | `true` |
| [resources/provider.example.json](resources/provider.example.json#L10) | `options.protocol` | `rpc` 发送会话式剧本，`gemini` 发送原生 Gemini JSON，`robin` 发送 `RobinService` Connect-JSON 查询。 | 示例 `"robin"`；省略默认 `"rpc"` |
| [resources/provider.example.json](resources/provider.example.json#L11) · [src/client.ts](src/client.ts#L130-L135) | `options.generationEndpoint` | 聊天和流式生成共用的 POST 路由。支持绝对 URL、相对路由及 `{model}`。 | 示例 `/$rpc/assistant.mobile.robin.RobinService/StreamGenerate`；省略时 `rpc` 用 `generate?$alt=json`，`gemini` 用 `v1beta/models/{model}:streamGenerateContent?alt=sse`，`robin` 用 `$rpc/assistant.mobile.robin.RobinService/StreamGenerate` |
| [src/client.ts](src/client.ts#L77-L95) | `options.uploadEndpoint` | 多模态附件上传的 multipart POST 路由。 | 省略则不走独立上传端点；表单键 `file`、`mimeType`，返回键按 `id`、`attachmentId`、`attachment_id`、`fileUri` 查找 |
| [resources/provider.example.json](resources/provider.example.json#L13) · [src/shim.ts](src/shim.ts#L91) | `options.temporaryChat` / `temporary_chat` | 控制生成请求里的无痕会话标志。 | `true` |
| [resources/provider.example.json](resources/provider.example.json#L12) · [src/client.ts](src/client.ts#L101-L120) | `options.deleteEndpoint` | 会话清理端点。含 `{conversationId}` 时执行 `DELETE`；`robin` 协议下无占位符时向该路由 `POST { conversationId }`。 | 示例 `/$rpc/assistant.mobile.robin.RobinService/DeleteConversation` |
| [src/index.ts](src/index.ts#L53) · [src/client.ts](src/client.ts#L166) | `options.conversationHeader` | 网关用响应头返回会话 ID 时，设置该响应头名称。 | `x-conversation-id` |
| [src/shim.ts](src/shim.ts#L300-L301) | `conversationId` / `conversation_id` | 默认解码器识别的会话 ID JSON 字段，支持顶层或 `response` / `data` / `conversation` 对象。 | 固定识别这些字段名 |
| [resources/provider.example.json](resources/provider.example.json#L14-L17) | `options.headers` | 明文网关请求头映射。JSON 生成的默认 Content-Type 与 Accept 可以在这里覆盖。 | 示例包含桌面 `User-Agent` 与 `X-Goog-Api-Format-Version: 2` |
| [resources/provider.example.json](resources/provider.example.json#L18) · [src/index.ts](src/index.ts#L86) | `options.secretHeaders` | 将网关请求头名称映射到端点的密钥变量名。 | `{}` |
| [src/index.ts](src/index.ts#L81-L85) | `secret` | Cortico 端点配置中的 API 密钥变量名。 | 省略，无 API 密钥 |
| [src/index.ts](src/index.ts#L84) | `options.credentialHeader` / `options.credentialPrefix` | 设置 API 密钥的请求头名及值前缀。 | `x-goog-api-key` / `""` |
| [src/index.ts](src/index.ts#L53) · [src/client.ts](src/client.ts#L72) | `options.authHeader` / `options.authPrefix` | 设置 OAuth access token 的请求头名及值前缀。 | `Authorization` / `"Bearer "` |
| [src/index.ts](src/index.ts#L95) · [src/catalog.ts](src/catalog.ts#L6-L7) | `options.modelsDevUrl` / `options.openRouterUrl` | 公开模型目录主源与备用源，可按部署需求覆盖。 | `https://models.dev/api.json` / `https://openrouter.ai/api/v1/models` |
| [src/http.ts](src/http.ts) | 代理传输 (`proxyFetch`) | 独立运行 CLI/脚本未带 `--use-env-proxy` 时，自动读取 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`（遵循 `NO_PROXY`）与 Windows 系统代理。 | 在 Coopanion Core 内运行则直接透传给宿主的全局 `fetch` |
