# Claymore Piko Privacy Policy / 隐私政策

Last updated / 最后更新: 2026-10-21

## English

Claymore Piko is a browser extension that lets the user's own AI assistant (the Claymore Piko app, or another MCP-compatible agent the user runs on the same computer) operate the user's Chrome with the user's logins.

**What the extension accesses.** When the user's agent asks it to, the extension reads the content of the tabs that agent controls (page text, interactive elements, screenshots, network responses of those tabs) and performs clicks, typing, navigation, downloads and uploads there.

**Where that data goes.**
- The extension sends it only to a bridge process on the same computer, over `127.0.0.1` (the local loopback address). It does not send it to any server run by us.
- The local agent decides what to do with it. The Claymore Piko app sends what its Bot needs to the AI model the user chose, through the user's Claymore account, to complete the user's task. The Claymore Piko app's own privacy terms cover that processing.
- The bridge keeps an operation log on the user's own disk, with passwords, tokens and recovery codes redacted.

**What we do not do.** No analytics, no telemetry, no advertising, no tracking, and no sale or transfer of data to third parties. The extension does not read the user's other tabs unless the user's agent is asked to work in them.

**Control.** The user can disconnect, disable or remove the extension at any time. Removing the extension and deleting `~/.claymore-piko-browser` removes all local data. Payment buttons always require the user's confirmation, and the agent cannot skip that check.


## 中文

Claymore Piko 是一个浏览器扩展：让用户自己的 AI 助手（Claymore Piko 应用，或用户在本机运行的其他支持 MCP 的 agent）带着用户的登录态操作用户自己的 Chrome。

**扩展访问什么。** 在用户的 agent 要求时，扩展读取该 agent 正在操作的标签页的内容（页面文字、可交互元素、截图、这些标签页的网络响应），并在这些标签页里点击、输入、跳转、下载和上传。

**数据去哪里。**
- 扩展只把这些数据发给同一台电脑上的桥进程，走 `127.0.0.1`（本机回环地址），不发往我们的任何服务器。
- 本机 agent 决定如何使用这些数据。Claymore Piko 应用会把它的 Bot 完成任务所需的内容，通过用户的 Claymore 账号发给用户选择的 AI 模型。这部分处理适用 Claymore Piko 应用自己的隐私条款。
- 桥在用户自己的磁盘上记录操作日志，日志中的密码、token、恢复码会被隐去。

**我们不做什么。** 没有统计分析、没有遥测、没有广告、没有跟踪，不出售或转让数据给第三方。除非用户的 agent 被要求在其中工作，扩展不读取用户的其他标签页。

**用户的控制。** 用户随时可以断开、停用或移除扩展。移除扩展并删除 `~/.claymore-piko-browser` 即删除全部本地数据。付款类按钮一律需要用户确认，agent 无法跳过。
