// ============================================================================
//  @yuanchilin/dsh-mailbox — 宿主 `/mailbox` 命令
//
//  在聊天输入框直接使用 (服务端命令注册表, 每个会话独立执行):
//    /mailbox                      → 会话目录 (发现对方)
//    /mailbox <target|alias|all> <message>   → 定向/别名/广播发送
//    /mailbox recv                 → 收取发给我的新消息
//    /mailbox list                 → 会话目录
//
//  执行时带会话上下文 (invocation.agent.session): 身份自动派生 + 心跳登记,
//  与 mailbox_send 等工具完全同协议。
// ============================================================================

import * as core from "./core.js";

/** 解析命令输入 (首 token 为目标, 其余为消息)。 */
export function parseMailboxCommand(rawInput) {
  const input = String(rawInput ?? "").trim();
  if (input.length === 0) return { kind: "usage" };
  const lower = input.toLowerCase();
  if (lower === "list" || lower === "help" || lower === "?") return { kind: "list" };
  if (lower === "recv") return { kind: "recv" };
  const sp = input.search(/\s/);
  if (sp === -1) return { kind: "no-message", to: input };
  const to = input.slice(0, sp).trim();
  const message = input.slice(sp + 1).trim();
  if (!message) return { kind: "no-message", to };
  return { kind: "send", to, message };
}

/** 渲染会话目录 (身份/别名/在线/工作区/标题/未读)。 */
export function renderDirectory(eff) {
  const sessions = core.listSessions(eff);
  if (sessions.length === 0) return "(暂无注册会话: 各会话调用一次 mailbox 工具/命令即自动登记)";
  return sessions
    .map((s) => {
      const on = core.isOnline(s, eff.presenceWindowSec) ? "●在线" : "○离线";
      const alias = s.alias ? ` (${s.alias})` : "";
      const title = s.title ? `  «${s.title}»` : "";
      const unread = core.unreadFrom(eff, s.identity) ? `  未读${core.unreadFrom(eff, s.identity)}` : "";
      return `  ${on} ${s.identity}${alias}  ${s.workspace || "?"}${title}${unread}`;
    })
    .join("\n");
}

/** 执行一次解析后的 /mailbox 命令, 返回 CommandResult ({ kind, text })。 */
export function executeMailboxCommand(ctx, cfg, invocation) {
  const session = invocation.agent?.session;
  const eff = core.effectiveConfig(cfg, session);
  core.touchRegistry(cfg, session);
  const parsed = parseMailboxCommand(invocation.rawInput);
  switch (parsed.kind) {
    case "usage":
      // 不再打印 "Usage: ..." 帮助行：用法提示已在弹窗补全与命令 hint 中提供，
      // 裸 /mailbox 只承担"发现会话目录"职责，避免每次都先冒出一条 Usage 噪音。
      return { kind: "success", text: `会话目录:\n${renderDirectory(eff)}` };
    case "list":
      return { kind: "success", text: `会话目录:\n${renderDirectory(eff)}` };
    case "recv": {
      const msgs = core.recvNew(eff, true);
      if (msgs.length === 0) return { kind: "success", text: "(无新消息)" };
      let acked = 0;
      for (const m of msgs) {
        if (m.type === "request" && core.sendAck(eff, m, "delivered")) acked++;
      }
      const lines = msgs.map((m) => {
        const p = m.payload && Object.keys(m.payload).length ? ` payload=${JSON.stringify(m.payload)}` : "";
        return `[${m.from} -> ${m.to}] ${m.type} topic=${m.topic} id=${m.id}${m.reply_to ? ` reply_to=${m.reply_to}` : ""}${p}`;
      });
      const hint = acked > 0
        ? `\n已自动回执 delivered 给 ${acked} 条 request ✓ (处理完请用 mailbox_send type=reply replyTo=<消息id> 回 done/error)`
        : "";
      return { kind: "success", text: `新消息 ${msgs.length} 条:\n${lines.join("\n")}${hint}` };
    }
    case "no-message":
      return { kind: "error", text: `/mailbox ${parsed.to}: 缺少消息内容（用法：/mailbox <目标|别名|all> <消息>）` };
    case "send": {
      const target = core.resolveTarget(eff, parsed.to);
      const id = core.sendMessage(eff, {
        to: parsed.to,
        type: "notify",
        topic: "message",
        payload: { text: parsed.message },
      });
      const rec = core.listSessions(eff).find((s) => s.identity === target);
      const status = rec
        ? core.isOnline(rec, eff.presenceWindowSec) ? "目标在线" : "目标离线"
        : parsed.to === "all" ? "" : core.unknownTargetHint(eff, target);
      return {
        kind: "success",
        text: `已发送 ${id}  (${eff.identity} → ${target})  ${status}\n内容: ${parsed.message}`,
      };
    }
  }
}

/** 向宿主命令注册表注册 /mailbox。 */
export function registerMailboxCommand(ctx, cfg) {
  ctx.commands.register({
    name: "mailbox",
    description: "跨会话发消息: /mailbox <目标|别名|all> <消息>; 单独 /mailbox 查看会话目录; /mailbox recv 收消息",
    input: { hint: "<target|alias|all> <message>" },
    handler: (invocation) => executeMailboxCommand(ctx, cfg, invocation),
  });
}
