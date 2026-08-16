// ============================================================================
//  @yuanchilin/dsh-mailbox — DeepSeek Harness cordis 插件
//
//  注册 6 个模型面向工具 + 1 个宿主命令:
//    mailbox_send     发送消息 (to=identity / 别名 / sessionId / all)
//    mailbox_recv     读取新消息 (自动 seen 去重)
//    mailbox_status   身份/目录/消息数 + 会话目录与在线状态
//    mailbox_sessions 会话目录: 找"要对话的会话" (身份/别名/在线/未读)
//    mailbox_alias    给本会话设置唯一别名 (便于他人定向发送)
//    mailbox_clean    按 TTL 清理自己发过的旧消息
//    /mailbox         宿主命令: /mailbox <目标|别名|all> <消息> (聊天框直发)
//
//  身份模型 (v1.1):
//    - 默认按 <工作区名>-<会话短id> 自动派生, 同一工作区多个会话互不冲突,
//      工具执行时从 exec.agent.session 取 id / header.cwd / 标题。
//    - 显式 config.identity 仍是最高优先级 (固定身份 / 旧配置兼容)。
//    - 每次工具调用写注册表心跳 (<root>/_sessions/<sessionId>.json),
//      供 mailbox_sessions / status 展示在线状态与未读数。
//
//  配置 (cordis.patch.yml 的 mailbox 行 config, 或 profile patch 覆盖):
//    identity(可选,留空自动), root(必填,共享目录), layout(root|dirs),
//    dirs, participants, intervalSec, timeoutSec, seenFile, patchRoot,
//    presenceWindowSec(在线判定窗口,默认 300)
//
//  长驻场景 (mailbox_wait 事件唤醒 / mailbox_poll 常驻轮询) 不适合做成工具,
//  请用包内 CLI: npx mailbox wait|poll (或 pwsh 版 mailbox.ps1), CLI 会写心跳。
// ============================================================================

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import * as core from "./core.js";
import { registerMailboxCommand } from "./command.js";
import { startMailboxWatcher } from "./watcher.js";

const name = "mailbox";
const inject = ["tools", "commands"];

/** schemastery 配置模式 (全部带默认值, 激活零配置; 收发前需配置 root) */
const Config = z.object({
  identity: z.string().default(""),
  layout: z.string().default("root"),
  root: z.string().default(""),
  dirs: z.dict(z.string()).default({}),
  participants: z.array(z.string()).default([]),
  intervalSec: z.number().default(2),
  timeoutSec: z.number().default(0),
  seenFile: z.string().default(""),
  patchRoot: z.string().default(""),
  presenceWindowSec: z.number().default(300),
  watcher: z.boolean().default(true),
});

const text = (s) => [{ type: "text", text: s }];

/** 会话上下文: 每个工具调用都先解析身份 + 写心跳, 然后带着有效身份执行。 */
function withSession(cfg, exec, fn) {
  const session = exec?.agent?.session;
  const eff = core.effectiveConfig(cfg, session);
  core.touchRegistry(cfg, session);
  return fn(eff, session);
}

function apply(ctx, config) {
  const cfg = core.resolveConfig(config ?? {});

  // 宿主命令: /mailbox <目标|别名|all> <消息> (聊天输入框直接使用)
  registerMailboxCommand(ctx, cfg);

  // 内建 watcher: 新消息 → 为对应会话 agent 创建完成 job → DSH 唤醒。
  // 随插件启动, dsh 重启自动复活 (根治 CLI wait job 重启即死的痛点)。
  startMailboxWatcher(ctx, cfg);

  ctx.tools.register(defineTool({
    name: "mailbox_send",
    description: "通过共享文件系统信箱向其他会话/agent 发送一条异步消息。to=参与者 identity / 别名 / 完整 sessionId 定向发送，或 all 广播；消息类型 request/response/notify/reply；对方不在线也不丢消息（对方之后 recv 或 CLI wait/poll 即可收到）。可用 mailbox_sessions 查看有哪些会话及其身份/别名。",
    parameters: {
      to: { type: "string", required: true, description: "接收方：identity（如 dsh-mailbox-17cbcfa0）/ 别名（如 rp）/ 完整 sessionId / all 广播" },
      type: { type: "string", enum: ["request", "response", "notify", "reply"], description: "消息类型，默认 notify" },
      topic: { type: "string", description: "消息主题，用于路由/归类（如 hello、patch_xxx）" },
      payload: { type: "object", additionalProperties: true, description: "任意 JSON 负载" },
      replyTo: { type: "string", description: "应答目标消息 id（请求-响应模式）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          id: { type: "string", required: true },
          from: { type: "string", required: true },
          to: { type: "string", required: true },
          toAlias: { type: "string" },
          targetOnline: { oneOf: [{ type: "boolean" }, { type: "null" }] },
          sessionsHint: { type: "string" },
        },
      },
      render: (_args, value) => {
        const alias = value.toAlias ? ` (alias=${value.toAlias})` : "";
        const online = value.targetOnline === null ? "" : value.targetOnline ? " 目标在线" : " 目标离线";
        const hint = value.sessionsHint ? `\n\n${value.sessionsHint}` : "";
        return text(`已发送 ${value.id}  (${value.from} → ${value.to}${alias})${online}${hint}`);
      },
    },
    execute: async (args, exec) => withSession(cfg, exec, (eff) => {
      const target = core.resolveTarget(eff, args.to);
      const id = core.sendMessage(eff, {
        to: args.to,
        type: args.type ?? "notify",
        topic: args.topic ?? "",
        payload: args.payload ?? {},
        replyTo: args.replyTo ?? "",
      });
      const rec = core.listSessions(eff).find((s) => s.identity === target);
      const known = core.isKnownTarget(eff, target);
      return {
        ok: true,
        id,
        from: eff.identity,
        to: target,
        toAlias: args.to !== target ? args.to : "",
        targetOnline: rec ? core.isOnline(rec, eff.presenceWindowSec) : null,
        sessionsHint: known ? "" : core.unknownTargetHint(eff, target),
      };
    }),
    presentCall: (args) => ({
      card: "generic",
      title: `mailbox → ${args.to}`,
      kind: "other",
      rawInput: args,
    }),
  }));

  ctx.tools.register(defineTool({
    name: "mailbox_recv",
    description: "读取信箱中发给本会话的新消息（自动记录 seen，重复调用不会重复返回）。返回消息列表：from/to/type/topic/payload/reply_to。无新消息时返回空列表。长驻等待请用 CLI：npx mailbox wait。",
    parameters: {
      format: { type: "string", enum: ["table", "json"], description: "输出格式，默认 table" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "integer", required: true },
          messages: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                from: { type: "string" },
                to: { type: "string" },
                type: { type: "string" },
                topic: { type: "string" },
                ts: { type: "integer" },
                reply_to: { type: "string" },
                payload: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) return text("(无新消息)");
        const lines = value.messages.map((m) => {
          const p = m.payload && Object.keys(m.payload).length ? ` payload=${JSON.stringify(m.payload)}` : "";
          return `[${m.from} -> ${m.to}] ${m.type} topic=${m.topic} id=${m.id}${m.reply_to ? ` reply_to=${m.reply_to}` : ""}${p}`;
        });
        return text(`新消息 ${value.count} 条:\n${lines.join("\n")}`);
      },
    },
    execute: async (args, exec) => withSession(cfg, exec, (eff) => {
      const messages = core.recvNew(eff, true);
      return { count: messages.length, messages };
    }),
    presentCall: () => ({ card: "generic", title: "mailbox recv", kind: "other" }),
  }));

  ctx.tools.register(defineTool({
    name: "mailbox_status",
    description: "查看信箱配置与状态：本会话身份、写入目录、已发送消息数、seen 记录数、各对方信箱的消息数与未读，以及会话目录（各已注册会话的身份/别名/在线状态）。用于确认信箱是否配置好、对方是否在线。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          identity: { type: "string" },
          layout: { type: "string" },
          outDir: { type: "string" },
          outCount: { type: "integer" },
          seen: { type: "integer" },
          inboxes: { type: "array", items: { type: "object", additionalProperties: true } },
          sessions: { type: "array", items: { type: "object", additionalProperties: true } },
        },
      },
      render: (_args, value) => {
        const lines = [
          `身份: ${value.identity}  layout=${value.layout}`,
          `写:   ${value.outDir}  (消息 ${value.outCount})`,
          `seen: ${value.seen} 条`,
          ...value.inboxes.map((i) => `读:   ${i.name || i.dir}  (消息 ${i.msgCount}, 未读 ${i.unread ?? 0})`),
        ];
        const sessions = value.sessions || [];
        if (sessions.length > 0) {
          lines.push("会话目录:");
          for (const s of sessions) {
            const on = s.online ? "●在线" : "○离线";
            lines.push(`  ${on} ${s.identity}${s.alias ? ` (${s.alias})` : ""}  ${s.workspace || "?"}${s.title ? `  «${s.title}»` : ""}${s.unread ? `  未读${s.unread}` : ""}`);
          }
        } else {
          lines.push("会话目录: (暂无注册会话, 各会话调用一次 mailbox 工具即登记)");
        }
        return text(lines.join("\n"));
      },
    },
    execute: async (_args, exec) => withSession(cfg, exec, (eff) => core.statusOf(eff)),
    presentCall: () => ({ card: "generic", title: "mailbox status", kind: "other" }),
  }));

  ctx.tools.register(defineTool({
    name: "mailbox_sessions",
    description: "会话目录：列出所有已注册会话（identity/别名/工作区/标题/在线状态/发给我未读条数），按最近活跃排序。用于快速找到要对话的会话：先看目录确定对方的 identity 或别名，再 mailbox_send 定向发送。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          count: { type: "integer", required: true },
          sessions: {
            type: "array",
            required: true,
            items: { type: "object", additionalProperties: true },
          },
        },
      },
      render: (_args, value) => {
        if (value.count === 0) return text("(暂无注册会话: 各会话调用一次 mailbox 工具即自动登记)");
        const lines = value.sessions.map((s) => {
          const on = s.online ? "●在线" : "○离线";
          return `${on} ${s.identity}${s.alias ? ` (alias=${s.alias})` : ""}  ${s.workspace || "?"}${s.title ? `  «${s.title}»` : ""}${s.unread ? `  发给我的未读:${s.unread}` : ""}`;
        });
        return text(`会话 ${value.count} 个:\n${lines.join("\n")}`);
      },
    },
    execute: async (_args, exec) => withSession(cfg, exec, (eff) => {
      const sessions = core.listSessions(eff).map((s) => ({
        ...s,
        online: core.isOnline(s, eff.presenceWindowSec),
        unread: core.unreadFrom(eff, s.identity),
      }));
      return { count: sessions.length, sessions };
    }),
    presentCall: () => ({ card: "generic", title: "mailbox sessions", kind: "other" }),
  }));

  ctx.tools.register(defineTool({
    name: "mailbox_alias",
    description: "给本会话设置一个简短唯一别名（全库检查，已被其他会话占用会拒绝），便于其他会话用 alias 定向发消息，而不是记长 identity。alias 仅允许字母数字 . _ -（≤32 字符）。",
    parameters: {
      alias: { type: "string", required: true, description: "别名，例如 rp / mcp / builder（全库唯一）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          alias: { type: "string", required: true },
          identity: { type: "string", required: true },
        },
      },
      render: (_args, value) => text(`别名已设置: ${value.identity} → "${value.alias}"`),
    },
    execute: async (args, exec) => withSession(cfg, exec, (eff, session) => {
      const rec = core.setAlias(eff, session, args.alias);
      return { alias: rec.alias, identity: rec.identity };
    }),
    presentCall: (args) => ({
      card: "generic",
      title: `mailbox alias → ${args.alias}`,
      kind: "other",
      rawInput: args,
    }),
  }));

  ctx.tools.register(defineTool({
    name: "mailbox_clean",
    description: "按 TTL 清理本会话自己发过的旧消息（对方应已读过）。dryRun 只统计不删除。",
    parameters: {
      ttlHours: { type: "integer", description: "保留时长（小时），默认 24" },
      dryRun: { type: "boolean", description: "只统计不删除，默认 false" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          removed: { type: "integer", required: true },
          dryRun: { type: "boolean", required: true },
        },
      },
      render: (_args, value) =>
        text(`clean: ${value.dryRun ? "dry-run" : "已删除"} ${value.removed} 条过期消息`),
    },
    execute: async (args, exec) => withSession(cfg, exec, (eff) => {
      const removed = core.cleanTTL(eff, {
        ttlHours: args.ttlHours ?? 24,
        dryRun: args.dryRun ?? false,
      });
      return { removed, dryRun: args.dryRun ?? false };
    }),
    presentCall: () => ({ card: "generic", title: "mailbox clean", kind: "other" }),
  }));
}

export { Config, apply, inject, name };
