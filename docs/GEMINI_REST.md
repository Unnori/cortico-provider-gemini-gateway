# gemini-web2api-go 客户端 REST 协议

依据项目公开的原生 Gemini 路由和实现整理，供自建或企业内部兼容网关配置核对。 [项目的原生 Gemini 接口说明](https://github.com/zexadev/gemini-web2api-go/blob/main/README_EN.md#gemini-native-api) [路由实现](https://github.com/zexadev/gemini-web2api-go/blob/main/internal/app/gemini_api.go)

| 方法与路径 | 客户端行为 |
| --- | --- |
| `POST /v1beta/models/{model}:generateContent` | 返回一个 Gemini JSON 对象。 |
| `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` | 返回 SSE，数据帧包含 Gemini JSON。 |
| `POST /v1beta/models/{model}:streamGenerateContent` | 返回逐元素输出的 JSON 数组。 |
| `GET /v1beta/models` | 列出当前网关公开的模型。 |

- 请求可包括 `systemInstruction`、`contents`、`tools[].functionDeclarations` 和 `toolConfig`。历史调用及结果使用 `functionCall` 和 `functionResponse`。
- 已为此网关签发的 API 密钥可通过 `x-goog-api-key` 传入。服务也接受 Bearer 请求头。
- 原生实现接受图片和视频 `inlineData`。使用 `fileData` 时，`fileUri` 需要是网关可访问的 HTTP(S) URL。
- 返回文本和工具调用位于 `candidates[].content.parts`。流尾通过 `finishReason` 报告结束原因，`usageMetadata` 提供本次调用的用量。
- 配置本扩展时选择 `options.protocol = "gemini"`。自建实现提供单独上传或清理路由时，可按本地配置清单填写。
