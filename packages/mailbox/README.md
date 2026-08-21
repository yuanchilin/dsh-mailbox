# @yuanchilin/dsh-mailbox

DeepSeek Harness 跨会话文件信箱插件：让多个 DSH 会话 / agent 通过共享文件系统异步通信——**发消息即投递，收消息自动唤醒**，对方离线也不丢信。

## 能力一览

| 面 | 内容 |
|---|---|
| **工具** | `mailbox_send` / `mailbox_recv` / `mailbox_status` / `mailbox_sessions` / `mailbox_alias` / `mailbox_clean` |
| **命令** | `/mailbox <目标|别名|all> <消息>`（输入框直发）；`/mailbox` 空回车列会话目录；`/mailbox recv` 收信；输入 `/mailbox` 弹出**补全选择器** |
| **内建 watcher** | 新消息 → 为目标会话 agent 创建完成 job → DSH 自动唤醒；随插件启动，**重启自动复活**，无需挂 CLI job |
| **CLI** | 零依赖 node CLI（`bin/mailbox.mjs`）+ pwsh 双实现（`skill/mailbox.ps1/.psm1`），同协议互通 |
| **Skill** | `skill/SKILL.md`，复制到 `~/.dsh/skills/mailbox/` 供所有会话加载 |

## 核心机制

- **文件协议**：每人一个目录 `<root>/<identity>/`，各写各的、互读对方的；消息即 `msg_<id>.json`，定向/广播路由，seen 去重，TTL 清理。
- **身份自动派生**：默认 `<工作区名>-<会话短id>`（如 `dsh-mailbox-17cbcfa0`），同一工作区多会话互不冲突；配置显式 `identity` 优先。
- **发现**：`mailbox_sessions` 会话目录（在线/别名/工作区/标题）；发送目标未登记时**错误即地址簿**（附完整目录）；`to` 支持 identity / 别名 / 完整 sessionId / 工作区路径 / `all`。
- **默认信箱位置**：`$DSH_HOME/mailbox`（通常 `~/.dsh/mailbox`），无 DSH_HOME 回退 `~/.dsh/mailbox`——可移植，不写死盘符。

### 回执 / 确认协议（request → delivered → done|error）

`request` 型消息的接收方在收取时**自动回执 `delivered`**（收到确认，幂等防重），处理完再回 `done` / `error`——让"确认"成为协议一等公民，发送方不再是"发了就以为对方办了"：

```
发送方 A                信箱文件              接收方 B
request ───────────────► 收到 ──► 自动回执 delivered ──► A 读到"已收到"
                                                  B 干活/确认方案
B 处理完回 done/error ◄─── reply (reply_to=原id) ◄───┘  A 读到"已完成/出错"
```

- 自动回执：`mailbox_recv` 工具、`/mailbox recv` 命令、CLI `recv/wait`、skill 双实现，收取 request 时自动回 `delivered`（CLI/pwsh 可 `--no-ack` / `-NoAck` 关闭）。
- 完成回执：处理完用 `mailbox_send to=<发送方> type=reply replyTo=<消息id> payload={status:"done"|"error", detail?}`。
- 查询：`latestReplyStatus(cfg, requestId)` 返回最近回执（含 error 的 detail），发送方据此判断生命周期。
- 行为策略：涉及执行/计划类任务时，接收 agent 应先向发送方回复确认方案、**等待确认后再动手**（唤醒通知与 recv 输出均带有此提示）。

## 安装（DSH 插件）

```sh
# 本地源码（开发, 符号链接: 已装包=源码, 改完重启即生效）
dsh plugin --profile web add link:<本仓库>/packages/mailbox

# 或 npm 发布版
dsh plugin --profile web add @yuanchilin/dsh-mailbox

# 然后重启 dsh web
```

配置（可选, 均有默认值）：profile 的 `cordis.patch.yml` 覆盖 `root`/`identity` 等：

```yaml
- id: mailbox
  config:
    root: D:/somewhere/shared-mailbox   # 默认 ~/.dsh/mailbox
    # identity 留空 → 自动按会话派生; watcher: false 可关闭内建唤醒
```

## 使用

```
mailbox_send     { to: "hub" | "dsh-mailbox-17cbcfa0" | "<sessionId>" | "all",
                   type: "notify|request|response|reply", topic: "hello",
                   payload: {...}, replyTo: "<msg-id>" }
mailbox_recv     {}        → 新消息列表 (自动 seen 去重)
mailbox_status   {}        → 身份/目录/会话目录/在线
mailbox_sessions {}        → 会话目录: 找"要对话的会话"
mailbox_alias    { alias: "hub" }  → 给本会话设唯一别名
mailbox_clean    { ttlHours: 24, dryRun: false }
```

CLI：

```sh
node packages/mailbox/bin/mailbox.mjs send --identity me --to hub --topic hello --payload '{"text":"hi"}'
node packages/mailbox/bin/mailbox.mjs recv --identity me
node packages/mailbox/bin/mailbox.mjs sessions --identity me
```

## 开发

```sh
npm install        # 仓库根 (npm workspace)
npm test           # node:test, 30 用例
npm run build      # 重建浏览器 bundle lib/client.js (提交入库)
npm run watch:client  # bundle 监视重建
```

结构：

```
lib/           核心逻辑 (纯 JS): core/command/watcher/directory-parse + index(插件) + types
src/client/    浏览器插件源码 → lib/client.js (/mailbox 补全弹窗)
bin/           node CLI
skill/         SKILL.md + pwsh 双实现 + 示例
test/          node:test 用例
```

## CI

`.github/workflows/ci.yml`：Node 22/24，`npm ci` → 测试 → 构建 → 校验 `lib/client.js` 与源码同步。

## License

MIT
