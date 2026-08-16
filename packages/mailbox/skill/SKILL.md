---
name: mailbox
description: 跨会话异步通信的文件信箱。通过共享文件系统在任意会话/agent 之间收发消息，支持 N 参与者、定向/广播、seen 去重、TTL 清理、事件唤醒。当需要与其他会话、后台 agent 或未来会话交换消息、任务结果或指示（而对方不一定在线）时使用。提供 pwsh 与 node 双实现的 CLI（send/recv/wait/poll/clean/status/init）。
whenToUse: 需要跨会话/跨进程异步传递消息时，例如向另一个会话发起请求、等待对方响应、投递任务结果、广播通知；或需要把当前会话状态交接给后续会话。
---

# mailbox — 跨会话文件信箱

基于文件系统的异步消息机制：**每个参与者各写各的信箱目录，互读对方的**。消息是文件，所以只要双方共享同一文件系统（同机或网络盘），就能在任意会话/进程/时间点通信，对方不在线也不丢消息。

## 脚本位置

- **本技能目录**（随技能打包，任何项目可用）：`$env:USERPROFILE\.dsh\skills\mailbox\`
- **项目内开发副本**（如存在，优先用项目内的）：`<workspace>/tools/mailbox/`
- 两个实现完全同协议，可互换混用：
  - pwsh：`mailbox.ps1`（模块 `mailbox.psm1`）
  - node：`mailbox.mjs`（零依赖）

## 快速开始

```powershell
$mb = "$env:USERPROFILE\.dsh\skills\mailbox"   # 或项目内 tools/mailbox

# 1. 初始化身份（同一 root 下每个参与者各初始化一次；root 需双方共享）
& "$mb\mailbox.ps1" init -Id agent-a -Root D:/Downloads/Agent/.mailbox

# 2. 发消息（to=all 广播 / to=<id> 定向）
& "$mb\mailbox.ps1" send -To agent-b -Topic hello -Payload '{"x":1}'

# 3. 收消息（一次性，自动更新 seen）
& "$mb\mailbox.ps1" recv -Format table

# 4. 事件唤醒：新消息到达即打印并 exit 0（后台 job 完成 → agent 被唤醒）
& "$mb\mailbox.ps1" wait -Timeout 600
```

node 版命令一致：`node "$mb\mailbox.mjs" send --to agent-b --topic hello --payload '{"x":1}'`

## 命令

| 命令 | pwsh | node | 说明 |
|---|---|---|---|
| init | `init -Id <id> -Root <dir>` | `init --id <id> --root <dir>` | 生成配置 |
| send | `send -To <id\|alias\|all> [-Type request\|response\|notify\|reply] [-Topic <t>] [-Payload <json>] [-ReplyTo <id>]` | `--to/--type/--topic/--payload/--reply-to` | 发消息（to 支持身份/别名/all） |
| recv | `recv [-Format table\|json]` | `recv [--format ...]` | 读新消息（更新 seen） |
| wait | `wait [-Timeout <sec>]` | `wait [--timeout <sec>]` | 新消息即 exit 0（唤醒） |
| poll | `poll [-Interval <sec>] [-Handlers <ps1>]` | `poll [--interval <sec>] [--handlers <mjs>]` | 常驻轮询（request 自动回 response） |
| clean | `clean [-TtlHours <n>] [-DryRun]` | `clean [--ttl-hours <n>] [--dry-run]` | TTL 清理自己发过的旧消息 |
| status | `status` | `status` | 身份/目录/消息数 + 会话目录 |
| sessions | `sessions` | `sessions` | 会话目录（注册表：身份/别名/在线/工作区） |

## 配置

默认读取工具同目录 `mailbox.config.json`，可用 `-Config` / `--config` 或环境变量 `MAILBOX_CONFIG` 指定。优先级：**CLI 参数 > 环境变量（`MAILBOX_ID`/`MAILBOX_ROOT`/`MAILBOX_CONFIG`/`MAILBOX_INTERVAL`/`MAILBOX_TIMEOUT`）> 配置文件 > 默认**。

```json
{ "identity": "agent-a", "layout": "root", "root": "D:/Downloads/Agent/.mailbox",
  "participants": [], "intervalSec": 2, "timeoutSec": 0, "seenFile": "", "patchRoot": "" }
```

- `layout=root`（标准）：`<root>/<id>/` 每人一子目录；`participants` 留空自动扫描
- `layout=dirs`（旧双目录兼容）：`dirs: { "<id>": "<目录>" }` 显式映射
- `seenFile` 留空默认 `<outDir>/.seen.json`（每参与者独立去重）

## 会话身份与发现（插件工具，v1.1）

**一个工作区下可以开多个会话**，所以不能按工作区区分身份。DSH 插件工具（`mailbox_send` 等）在每次调用时：

- **身份自动派生**：`<工作区名>-<会话短id>`（如 `dsh-mailbox-17cbcfa0`），每会话唯一、稳定；配置里显式 `identity` 仍是最高优先级（固定身份/旧配置兼容）。
- **写注册表心跳**：`<root>/_sessions/<sessionId>.json`（每次工具调用更新 `lastSeen`，CLI 以 `cli-<identity>` 登记）。`mailbox_sessions` / `status` / `sessions` 据此展示会话目录：身份/别名/工作区/标题/在线/未读。
- **发现流程**：先 `mailbox_sessions` 看目录确定对方的 identity 或别名 → `mailbox_send` 定向发送（to 支持 identity / 别名 / 完整 sessionId / all）。
- **别名**：`mailbox_alias` 给本会话设唯一别名（如 `rp`、`mcp`），全库查重，占用即拒绝。

CLI 侧（无会话上下文）继续用显式 `--identity`；`send` 的 `--to` 同样支持别名（经注册表解析）。

## 协议

- 消息文件：`msg_<id>.json`，内容 `{ id, from, to, type, topic, payload, ts, reply_to }`
- 路由：`to=<id>` 定向（支持别名/完整 sessionId）/ `to=all` 广播（写一份，各人自取）
- 注册表：`<root>/_sessions/`（参与者扫描自动跳过 `_` 前缀目录）
- 消息类型：`request` / `response` / `notify` / `reply`
- **请求-响应模式**：发 `request` 带 `reply_to`，对方处理完回 `response` 指向原 id；`wait`/`recv` 可按 `reply_to` 关联
- 已处理消息建议删除（`Remove-MailboxMsg` / 由 poll 自动清理），seen 文件兜底去重

## 典型用法

1. **跨会话交接**：完成任务后 `send -To <对方> -Type notify -Topic handoff_ready -Payload @{...}`，把上下文文件路径放进 payload
2. **请求-响应**：`send -To rp -Type request -Topic patch_bug2 -Payload @{edits=...}` → 对方 poll 自动处理并回 `patch_result`
3. **等待对方**：`wait -Timeout 600` 挂后台 job，新消息到达 job 完成即被唤醒（DSH 机制）
4. **补丁自动应用**（示例）：`poll -Handlers examples/handlers.patch.ps1`（需配置 `patchRoot`），收到 `topic=patch_*` 消息自动备份→替换→node --check→回滚→回 response

## 注意事项

- 双方必须共享同一文件系统（同机目录或网络盘）；广域网需二期 HTTP relay（未实现）
- `wait` 与 `poll` 共用 seen 文件，同一身份不要同时跑两个
- 消息明文存储；需要保密时不要写入敏感 payload（二期支持加密）
