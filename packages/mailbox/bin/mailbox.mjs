#!/usr/bin/env node
// ============================================================================
//  @yuanchilin/dsh-mailbox — node CLI (薄封装, 复用 lib/core.js)
//
//  node bin/mailbox.mjs send --to agent-b --topic hello --payload '{"x":1}'
//  node bin/mailbox.mjs recv --format json
//  node bin/mailbox.mjs wait --timeout 600          # 新消息即 exit 0 (唤醒)
//  node bin/mailbox.mjs poll --interval 2           # 常驻 (request→echo)
//  node bin/mailbox.mjs clean --ttl-hours 24 --dry-run
//  node bin/mailbox.mjs status
//  node bin/mailbox.mjs sessions                    # 会话目录 (注册表: 在线/别名/工作区)
//  node bin/mailbox.mjs init --id agent-a --root D:/Downloads/Agent/.mailbox
//
//  配置优先级: 参数 > 环境变量 (MAILBOX_CONFIG/ID/ROOT/INTERVAL/TIMEOUT) > 配置文件 > 默认
// ============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../lib/core.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(__dirname, "..", "mailbox.config.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function getConfig(args) {
  let fileCfg = {};
  const configPath = args.config || process.env.MAILBOX_CONFIG || DEFAULT_CONFIG;
  if (existsSync(configPath)) {
    try {
      fileCfg = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (e) {
      console.warn(`[mailbox] 读取配置失败: ${configPath} (${e.message})`);
    }
  }
  const cfg = core.resolveConfig({ ...fileCfg }, process.env);
  if (args.identity) cfg.identity = args.identity;
  if (args.root) { cfg.root = args.root; cfg.layout = "root"; }
  if (args.interval !== undefined) cfg.intervalSec = Number(args.interval);
  if (args.timeout !== undefined) cfg.timeoutSec = Number(args.timeout);
  // 配置文件里 root 为空串时回退到源码默认 (DSH_HOME/mailbox 或 ~/.dsh/mailbox)
  if (!cfg.root && cfg.layout === "root") cfg.root = core.defaultMailboxRoot();
  return { cfg, configPath };
}

/** 心跳是 best-effort: 共享根不可写(沙箱)时静默跳过, 不影响主流程 (尤其 wait 监听循环)。 */
function safeTouchCli(cfg) {
  try {
    safeTouchCli(cfg);
  } catch {
    // 忽略: 心跳失败不应让 send/recv/wait/poll/status 崩溃
  }
}

const commands = {
  init(args, cfg, configPath) {
    const out = {
      identity: cfg.identity,
      layout: cfg.layout,
      root: cfg.root,
      dirs: cfg.dirs,
      participants: cfg.participants,
      intervalSec: cfg.intervalSec,
      timeoutSec: cfg.timeoutSec,
      seenFile: cfg.seenFile,
      patchRoot: cfg.patchRoot,
    };
    writeFileSync(configPath, JSON.stringify(out, null, 2) + "\n", "utf-8");
    console.log(`已生成配置: ${configPath}`);
  },

  send(args, cfg) {
    if (!args.to) throw new Error("send 需要 --to <id|alias|all>");
    let payload = {};
    if (args.payload) {
      try { payload = JSON.parse(args.payload); } catch { throw new Error(`payload 不是合法 JSON: ${args.payload}`); }
    }
    core.assertUsable(cfg);
    safeTouchCli(cfg);
    const target = core.resolveTarget(cfg, args.to);
    const id = core.sendMessage(cfg, {
      to: args.to,
      type: args.type || "notify",
      topic: args.topic || "",
      payload,
      replyTo: args.replyTo || "",
    });
    console.log(`sent ${id}  (${new Date().toTimeString().slice(0, 8)})`);
    if (!core.isKnownTarget(cfg, target)) {
      console.log(core.unknownTargetHint(cfg, target));
    }
  },

  recv(args, cfg) {
    core.assertUsable(cfg);
    safeTouchCli(cfg);
    const msgs = core.recvNew(cfg, true);
    if (msgs.length === 0) { console.log("(无新消息)"); return; }
    if (args.format === "json") {
      for (const m of msgs) console.log(JSON.stringify(m));
    } else {
      for (const m of msgs) {
        const p = m.payload && Object.keys(m.payload).length ? ` payload=${JSON.stringify(m.payload)}` : "";
        console.log(`[${m.from} -> ${m.to}] ${m.type} topic=${m.topic} id=${m.id}${m.reply_to ? ` reply_to=${m.reply_to}` : ""}${p}`);
      }
    }
  },

  async wait(args, cfg) {
    core.assertUsable(cfg);
    safeTouchCli(cfg);
    const started = Date.now();
    for (;;) {
      const msgs = core.recvNew(cfg, true);
      if (msgs.length > 0) {
        console.log(`=== NEW MESSAGES: ${msgs.length} ===`);
        for (const m of msgs) console.log(JSON.stringify(m));
        console.log("=== WAKE-UP (exit 0) ===");
        process.exit(0);
      }
      if (cfg.timeoutSec > 0 && (Date.now() - started) / 1000 >= cfg.timeoutSec) {
        console.log(`TIMEOUT after ${cfg.timeoutSec}s, no new messages`);
        process.exit(0);
      }
      await sleep(cfg.intervalSec * 1000);
    }
  },

  async poll(args, cfg) {
    core.assertUsable(cfg);
    safeTouchCli(cfg);
    console.log(`poll 启动 (identity=${cfg.identity} 每 ${cfg.intervalSec}s). Ctrl+C 退出`);
    for (;;) {
      try {
        for (const m of core.recvNew(cfg, true)) {
          console.log(`[收到] from=${m.from} type=${m.type} topic=${m.topic} id=${m.id}`);
          if (m.type === "request") {
            core.sendMessage(cfg, {
              to: m.from,
              type: "response",
              topic: m.topic,
              payload: { echo: m.payload, from: cfg.identity },
              replyTo: m.id,
            });
            console.log(`  → 已回 response (reply_to=${m.id})`);
          } else {
            console.log(JSON.stringify(m));
          }
          try { core.removeMessage(cfg, m.id, true); } catch { /* 权限不足则跳过 */ }
        }
      } catch (e) {
        console.warn(`轮询异常: ${e.message}`);
      }
      await sleep(cfg.intervalSec * 1000);
    }
  },

  clean(args, cfg) {
    core.assertUsable(cfg);
    const removed = core.cleanTTL(cfg, {
      ttlHours: args.ttlHours !== undefined ? Number(args.ttlHours) : 24,
      dryRun: !!args.dryRun,
    });
    console.log(`clean: ${args.dryRun ? "dry-run" : "已删除"} ${removed} 条过期消息`);
  },

  status(args, cfg) {
    core.assertUsable(cfg);
    safeTouchCli(cfg);
    const s = core.statusOf(cfg);
    console.log(`身份: ${s.identity}  layout=${s.layout}`);
    console.log(`写:   ${s.outDir}  (消息 ${s.outCount})`);
    console.log(`seen: ${s.seen} 条`);
    for (const i of s.inboxes) console.log(`读:   ${i.name || i.dir}  (消息 ${i.msgCount}, 未读 ${i.unread ?? 0})`);
    if (s.sessions.length > 0) {
      console.log("会话目录:");
      const now = Date.now();
      for (const r of s.sessions) {
        const on = r.online ? "●在线" : "○离线";
        const ago = r.lastSeen ? `${Math.max(0, Math.round((now - r.lastSeen) / 1000))}s前` : "-";
        console.log(`  ${on} ${r.identity}${r.alias ? ` (${r.alias})` : ""}  ${r.workspace || "?"}${r.title ? `  «${r.title}»` : ""}  last=${ago}`);
      }
    }
  },

  sessions(args, cfg) {
    core.assertUsable(cfg);
    const list = core.listSessions(cfg);
    if (list.length === 0) { console.log("(暂无注册会话: 各会话调用一次 mailbox 工具即自动登记)"); return; }
    const now = Date.now();
    for (const r of list) {
      const on = core.isOnline(r, cfg.presenceWindowSec) ? "●在线" : "○离线";
      const ago = r.lastSeen ? `${Math.max(0, Math.round((now - r.lastSeen) / 1000))}s前` : "-";
      console.log(`${on} ${r.identity}${r.alias ? ` (alias=${r.alias})` : ""}  ${r.workspace || "?"}${r.title ? `  «${r.title}»` : ""}  last=${ago}`);
    }
  },
};

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "status";
const { cfg, configPath } = getConfig(args);

try {
  const fn = commands[command];
  if (!fn) throw new Error(`未知命令: ${command} (可用: init/send/recv/wait/poll/clean/status/sessions)`);
  await fn(args, cfg, configPath);
} catch (e) {
  console.error(`[mailbox] ${e.message}`);
  process.exit(1);
}
