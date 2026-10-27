# 让 Claude Code 和 Codex 用上 Claymore Piko 浏览器扩展

装好之后，Claude Code 和 Codex 里的 agent 就能操作你自己的 Chrome，用的是你已经登录的账号：查资料、填表、发帖、拉数据都行。
它和 Piko 里的 Bot 用的是同一套 22 个工具、同一个扩展。

整条链路是：agent → MCP server（`piko-browser mcp`）→ 本机的桥（127.0.0.1:8898）→ Chrome 扩展。
桥由 MCP server 在第一次调用时自动拉起，不需要手动启动。

## 准备

- **Chrome**：日常用的那个就行，不用改启动参数。
- **Node 20 或更高版本**：终端里 `node -v` 查。

## 第一步：装扩展

打开商店页，点「添加至 Chrome」：

https://chromewebstore.google.com/detail/afnglaiimnjpcdnnihploelgnoalaogm

这个商店项是「不公开」的，在商店里搜不到，只能通过这个链接安装。
装好后，建议在工具栏的拼图图标里把 Claymore Piko 固定出来，方便看连接状态和点「重连」。
用过 Piko 桌面 App 的，扩展多半已经装好了，可以跳过这一步。

## 第二步：一条命令配好 agent

```bash
npx -y claymore-piko-browser@latest install
```

它会：

- 找到这台机器上装着的 agent，包括 Claude Code、Codex、Cursor、Gemini CLI、Claude Desktop 等。没列在表里的 agent，只要配置放在 `~/.<名字>/` 下，也会被自动发现。
- 把 `piko-browser` 写进每个 agent 的 MCP 配置。写之前，每个文件都先备份成 `<文件名>.bak-<时间戳>`。已经配过的 agent 会跳过。
- 打开一份引导页，告诉你扩展装好之后是什么样子。

只想看会改哪些文件、不实际写入，加 `--dry-run`。只配某一个 agent，加 `--only claude-code` 或 `--only codex`。

配好之后，**重启 agent**：Claude Code 和 Codex 都只在启动时加载 MCP server。

## 第三步：检查连接

```bash
npx claymore-piko-browser doctor
```

看到下面这一行就说明连上了：

```
✅ 握手正常 · Chrome 扩展在线
```

在 agent 里也可以查。Claude Code 输入 `/mcp`，应该看到 `piko-browser · connected`。Codex 输入 `/mcp`，应该看到 `piko-browser` 和它的工具列表。

## 第四步：试一下

对 agent 说：

```
用 piko-browser 打开 https://example.com，告诉我页面标题
```

Chrome 里会出现一个以 agent 命名的标签组（比如 Claude Code 或 Codex）。agent 只操作这个组里的标签页，不会碰你自己开着的页面。
点工具栏上的扩展图标，侧栏里能看到是哪个会话在控制哪一页。

工具的使用顺序（先找接口拿数据，再看快照，截图放在最后）由 MCP server 在握手时通过 `instructions` 自动告诉 agent，不用另外写提示词。
如果 Claude Code 里同时装了 Claude in Chrome，agent 可能会去用那一套工具；想让它用这个扩展，在提示里点名「用 piko-browser」就行。

## 手动配置

`install` 没认出你的 agent，或者你想自己控制配置文件时，手动加一条就行。

**Claude Code**，加到用户级配置，所有项目都能用：

```bash
claude mcp add -s user piko-browser -- npx -y claymore-piko-browser mcp --client claude-code
```

**Codex**，在 `~/.codex/config.toml` 里加（Codex CLI 和 Codex 桌面 App 共用这个文件）：

```toml
[mcp_servers.piko-browser]
command = "npx"
args = ["-y", "claymore-piko-browser", "mcp", "--client", "codex"]
startup_timeout_sec = 60
```

`startup_timeout_sec` 一定要加。Codex 默认只等 MCP server 10 秒，而 npx 缓存没命中时要先下载，会超过这个时间。超时的结果是工具静默地没有加载上，也不报错。

**其他 agent**，用通用的 `mcpServers` 格式：

```json
{ "mcpServers": { "piko-browser": { "command": "npx", "args": ["-y", "claymore-piko-browser", "mcp"] } } }
```

`--client` 不写也可以：侧栏和审计日志里显示的是 agent 在 MCP 握手里自报的名字，这个参数只在 agent 没报名字时兜底。

## 常用设置

在 MCP 配置里加 `env`。Claude Code 是在 JSON 里加 `"env": {…}`，Codex 是在 TOML 里加 `env = { … }`。

| 变量 | 用途 |
|---|---|
| `HUASHU_CHROME_LABEL` | 标签组和侧栏里显示的名字，比如 `"写稿助手"`。不设时用 agent 的名字 |
| `HUASHU_CHROME_ASK=off` | 无人值守。遇到验证码、扫码这类步骤，`ask` 不再弹出浮条等人处理 |

Codex 的例子：

```toml
[mcp_servers.piko-browser]
command = "npx"
args = ["-y", "claymore-piko-browser", "mcp", "--client", "codex"]
startup_timeout_sec = 60
env = { HUASHU_CHROME_LABEL = "Codex 调研" }
```

## 和 Piko 桌面 App 一起用

可以一起用。Piko 桌面 App、Claude Code、Codex 共用同一个桥（端口 8898）和同一个扩展。每个会话有自己的标签页槽，互不抢页。
桥由最先启动的那一方拉起，后启动的直接连上去。

## 升级

扩展由 Chrome 商店自动更新。本地端的升级方式：

```bash
npx -y claymore-piko-browser@latest install   # 拉最新版，已配好的 agent 会跳过
```

然后重启 agent。npx 会缓存下载过的版本，所以只写 `npx -y claymore-piko-browser`、不带 `@latest` 时，可能一直跑旧版。
扩展和本地端只差补丁号时互相兼容；差得多时，`doctor` 和扩展侧栏都会提示该更新哪一边。

## 排错

| 现象 | 处理 |
|---|---|
| `/mcp` 里 `piko-browser` 显示失败或超时 | 先在终端单独跑 `npx claymore-piko-browser doctor`，看它报什么错。Codex 还要检查是否加了 `startup_timeout_sec` |
| 工具返回 `NO_EXTENSION` | 扩展没连上桥。点扩展图标 → 「重连」；还不行，就到 `chrome://extensions` 确认 Claymore Piko 已经启用 |
| 工具返回 `NEEDS_L2` | 这一步需要真实的输入事件。点扩展图标 → 「启用高保真模式」 |
| 命令全部卡住 | 页面上有 alert 或 confirm 弹窗挡着，手动关掉 |
| `install` 说没找到 agent | 按上面的「手动配置」加 |

更多症状见 README 的[排错](../README.md#排错)。想看 agent 到底点了什么：

```bash
npx claymore-piko-browser audit -n 50
```

## 开发者：从源码运行

要改这个扩展的代码时：

1. 克隆本仓库，执行 `npm ci`。
2. 把上面配置里的 `npx -y claymore-piko-browser` 换成 `node <克隆的绝对路径>/src/cli.js`，其余参数不变。在克隆里直接跑 `node src/cli.js install`，写进配置的就是这条源码路径。
3. 扩展在 `chrome://extensions` 里打开「开发者模式」，点「加载已解压的扩展程序」，选择 `extension/` 文件夹。

手动加载的扩展和商店版 ID 相同，只启用其中一个。
