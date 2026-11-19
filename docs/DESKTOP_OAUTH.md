# 桌面 OAuth 协议参考

- 桌面应用使用部署授权服务中注册的客户端，通过系统浏览器发送授权请求。扩展默认采用 `127.0.0.1`、运行时端口和 `/oauth/callback` 接收授权码，也可通过 `redirectHost` 和 `redirectPath` 覆盖（例如 `localhost` 与空路径 `""`）。 [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3)
- 扩展以 PKCE 的 `S256` 方式生成 challenge，并在 token 交换时发送对应 verifier。授权服务应支持 Authorization Code 与 PKCE。 [RFC 7636 §4](https://www.rfc-editor.org/rfc/rfc7636.html#section-4)
- Token 地址、Scope、客户端参数和离线授权要求由授权服务决定。扩展首次登录需要收到 `refresh_token`，随后使用同一 token 地址刷新。
