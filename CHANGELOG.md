# Changelog

## 0.1.1

将扩展包的顶层简介（`description`）改为纯中文描述，便于在 npm 与扩展市场列表直接展示中文说明，并保留 `unofficial-api` 与 `experimental` 标签声明。

## 0.1.0

首个公开发布版本：提供面向 Cortico Provider API 6 的 Gemini 多协议网关扩展，支持 Google Robin 桌面 OAuth（含账号服务条款状态追踪与一键同意、按账号隔离的多模态附件上传与会话清理）、Web2API 原生 Gemini REST 及自定义会话式 RPC 三种接入模式，并在 WebUI 中随模式自动切换配置面板；内置多账号 OAuth 凭证池，支持主备故障转移、平等轮询与按周剩余额度优先三种调度策略及策略自适应额度看板，账号标识全局默认采用 `5***3@gmail.com` 脱敏并可一键显隐，同时支持公开模型目录自动拉取、自动计价与零内置密钥的安全分发模板。
