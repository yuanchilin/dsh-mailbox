# mailbox — 通用跨会话文件信箱 v1

文件信箱，用于 **N 个会话/agent 之间的异步通信**。泛化自 mcp/RP 联调工具，零依赖、配置驱动、双实现（pwsh + Node）可互换混用。

## 核心模型

- 每个参与者有唯一身份 `id`，各写各的信箱目录，互读对方的
- **layout=root（标准）**：共享根目录 `<root>/<id>/` 每人一个子目录
- **layout=dirs（兼容旧双目录）**：`dirs: { id -> 目录 }` 显式映射，旧 mcp/RP 信箱免迁移接入
- 消息格式：`{ id, from, to, type, topic, payload, ts, reply_to }`，文件 `msg_<id>.json`
- 路由：`to=<id>` 定向 / `to=all` 广播（只写一份，各人自取）
- seen 去重：每参与者独立 seen 文件（默认 `<outDir>/.seen.json`），重启不重复处理

## 快速开始

```powershell
# 1. 初始化（每个参与者同一 root 下各一个目录）
.\mailbox.ps1 init -Id agent-a -Root D:/Downloads/Agent/.mailbox
.\mailbox.ps1 init -Id agent-b -Root D:/Downloads/Agent/.mailbox

# 2. A 发消息
.\mailbox.ps1 send -To agent-b -Topic hello -Payload '{"x":1}'

# 3. B 收消息（一次性）
.\mailbox.ps1 recv -Format table

# 4. B 事件监听（新消息 → 打印 → exit 0，DSH 后台 job 完成即唤醒 agent）
.\mailbox.ps1 wait -Timeout 600

# 5. B 常驻轮询（request 自动回 response，可挂 handlers）
.\mailbox.ps1 poll -Interval 2 -Handlers .\examples\handlers.patch.ps1
```

Node 版命令完全一致：

```bash
node mailbox.mjs send --to agent-b --topic hello --payload '{"x":1}'
node mailbox.mjs recv --format table
node mailbox.mjs wait --timeout 600
```

## 命令

| 命令 | pwsh | node | 说明 |
|---|---|---|---|
| init | `init -Id x -Root y` | `init --id x --root y` | 生成配置文件 |
| send | `send -To <id\|all> -Type <t> -Topic <t> -Payload <json> -ReplyTo <id>` | 同左 `--to/--type/--topic/--payload/--reply-to` | 发消息 |
| recv | `recv [-Format table\|json]` | `recv [--format table\|json]` | 读新消息（更新 seen） |
| wait | `wait [-Timeout sec] [-Interval sec]` | `wait [--timeout sec]` | 新消息即 exit 0（唤醒） |
| poll | `poll [-Interval sec] [-Handlers <ps1>]` | `poll [--interval sec] [--handlers <mjs>]` | 常驻轮询 |
| clean | `clean [-TtlHours n] [-DryRun]` | `clean [--ttl-hours n] [--dry-run]` | TTL 清理自己的已发送消息 |
| status | `status` | `status` | 身份/目录/消息数 |

## 配置

配置文件默认 `mailbox.config.json`（与工具同目录），可用 `-Config` / `--config` 或环境变量 `MAILBOX_CONFIG` 指定。

```json
{
  "identity": "agent-a",
  "layout": "root",
  "root": "D:/Downloads/Agent/.mailbox",
  "dirs": {},
  "participants": [],
  "intervalSec": 2,
  "timeoutSec": 0,
  "seenFile": "",
  "patchRoot": ""
}
```

优先级：**CLI 参数 > 环境变量（`MAILBOX_CONFIG`/`MAILBOX_ID`/`MAILBOX_ROOT`/`MAILBOX_INTERVAL`/`MAILBOX_TIMEOUT`）> 配置文件 > 默认**。

- `participants` 留空时自动扫描 `<root>/` 下的子目录作为参与者
- `seenFile` 留空默认 `<outDir>/.seen.json`
- `patchRoot` 供示例补丁 handler 使用

## 消息类型与默认处理

| type | 默认处理（poll） |
|---|---|
| request | 自动回 `response`（echo payload） |
| response / notify / reply | 打印 |

**可插拔 handler**：
- pwsh：`-Handlers <ps1>`，dot-source 后定义 `function Handle-Message($Msg, $Ctx)`，返回 `$false` 回退默认逻辑
- node：`--handlers <mjs>`，导出 `export async function handle(msg, ctx)`，返回 `false` 回退默认逻辑

示例：`examples/handlers.patch.ps1` 补丁自动应用（备份→替换→`node --check`→失败回滚→写 `patches/history.jsonl`→回 response），协议：

```json
{ "type": "request", "topic": "patch_<任意>", "payload": {
    "patch_id": "p1", "note": "说明",
    "edits": [ { "file": "build/x.js", "old": "...", "new": "..." },
               { "file": "build/y.js", "whole": "完整内容" },
               { "file": "build/z.js", "old": "...", "new": "...", "replace_all": true } ] } }
```

## 旧布局兼容（mcp/RP）

`legacy-mcp.config.json` 用 `layout:"dirs"` 映射原 mcp/RP 双目录，原轮询/监听脚本改为薄封装：

```powershell
.\mailbox_poll_mcp.ps1   # → mailbox.ps1 poll -Config legacy-mcp.config.json -Handlers examples/handlers.patch.ps1
.\mailbox_wait_mcp.ps1   # → mailbox.ps1 wait -Config legacy-mcp.config.json
```

## 自测

```powershell
.\self-test.ps1   # 覆盖: 往返/广播/wait 唤醒/TTL/双实现互通/旧布局/去重
```

## 二期路线（未实现）

- HTTP relay（跨机器，CLI 加 `transport` 开关）+ X25519 加密 / Ed25519 签名
- 独立 npm/pwsh 包发布
