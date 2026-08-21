#!/usr/bin/env node
// ============================================================================
//  mailbox.mjs — 通用跨会话文件信箱 CLI v1 (Node 版, 零依赖)
//
//  与 pwsh 版 (mailbox.ps1) 同协议、同配置、同命令, 可互换混用:
//    node mailbox.mjs init  --id agent-a --root D:/Downloads/Agent/.mailbox
//    node mailbox.mjs send  --to agent-b --topic hello --payload '{"x":1}'
//    node mailbox.mjs recv  --format table
//    node mailbox.mjs wait  --timeout 60
//    node mailbox.mjs poll  --interval 2 --handlers ./handlers.mjs
//    node mailbox.mjs clean --ttl-hours 24
//    node mailbox.mjs status
//
//  配置优先级: 参数 > 环境变量 (MAILBOX_CONFIG/ID/ROOT/INTERVAL/TIMEOUT) > 配置文件 > 默认
//  消息格式: { id, from, to, type, topic, payload, ts, reply_to }
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = join(__dirname, "mailbox.config.json");

// ---------------------------------------------------------------------------
// 参数解析: --key value / --flag
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// 配置解析
// ---------------------------------------------------------------------------
function getConfig(args) {
  const cfg = {
    identity: "",
    layout: "root",
    root: "",
    dirs: {},
    participants: [],
    intervalSec: 2,
    timeoutSec: 0,
    seenFile: "",
    patchRoot: "",
  };
  let configPath = args.config || process.env.MAILBOX_CONFIG || DEFAULT_CONFIG;
  if (existsSync(configPath)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(configPath, "utf-8")));
    } catch (e) {
      console.warn(`[mailbox] 读取配置失败: ${configPath} (${e.message})`);
    }
  }
  if (process.env.MAILBOX_ID) cfg.identity = process.env.MAILBOX_ID;
  if (process.env.MAILBOX_ROOT) { cfg.root = process.env.MAILBOX_ROOT; cfg.layout = "root"; }
  if (process.env.MAILBOX_INTERVAL) cfg.intervalSec = Number(process.env.MAILBOX_INTERVAL);
  if (process.env.MAILBOX_TIMEOUT) cfg.timeoutSec = Number(process.env.MAILBOX_TIMEOUT);
  if (args.identity) cfg.identity = args.identity;
  if (args.root) { cfg.root = args.root; cfg.layout = "root"; }
  if (args.interval !== undefined) cfg.intervalSec = Number(args.interval);
  if (args.timeout !== undefined) cfg.timeoutSec = Number(args.timeout);
  return { cfg, configPath };
}

function resolveDirs(cfg) {
  if (cfg.layout === "dirs") {
    if (!cfg.dirs || !cfg.dirs[cfg.identity]) {
      throw new Error(`layout=dirs 但配置缺少 identity '${cfg.identity}' 的目录映射`);
    }
    const out = cfg.dirs[cfg.identity];
    const inDirs = [...new Set(Object.entries(cfg.dirs).filter(([k]) => k !== cfg.identity).map(([, v]) => v))];
    return { out, in: inDirs };
  }
  if (!cfg.root) throw new Error("layout=root 需要配置 root");
  const out = join(cfg.root, cfg.identity);
  let participants = Array.isArray(cfg.participants) && cfg.participants.length > 0 ? cfg.participants : [];
  if (participants.length === 0 && existsSync(cfg.root)) {
    participants = readdirSync(cfg.root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  }
  const inDirs = [...new Set(participants.filter((p) => p !== cfg.identity).map((p) => join(cfg.root, p)))];
  return { out, in: inDirs };
}

const SEEN_EXT = ".seen";

function seenFileOf(cfg) {
  if (cfg.seenFile) return cfg.seenFile;
  return join(resolveDirs(cfg).out, ".seen.json");
}

function seenDirOf(cfg) {
  if (cfg.seenFile) return "";
  return join(resolveDirs(cfg).out, ".seen");
}
function seenMarkName(id) { return `${id}${SEEN_EXT}`; }

function migrateSeen(cfg, dir) {
  const legacy = seenFileOf(cfg);
  if (cfg.seenFile || !existsSync(legacy) || existsSync(dir)) return;
  try {
    const v = JSON.parse(readFileSync(legacy, "utf-8"));
    const arr = Array.isArray(v) ? v : [v];
    mkdirSync(dir, { recursive: true });
    for (const id of arr) if (id) writeFileSync(join(dir, seenMarkName(id)), "", "utf-8");
    rmSync(legacy, { force: true });
  } catch { /* 迁移失败则保留旧文件 */ }
}

function loadSeen(cfg) {
  const dir = seenDirOf(cfg);
  if (!dir) {
    const f = seenFileOf(cfg);
    if (!existsSync(f)) return [];
    try {
      const v = JSON.parse(readFileSync(f, "utf-8"));
      return Array.isArray(v) ? v : [v];
    } catch { return []; }
  }
  migrateSeen(cfg, dir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((x) => x.endsWith(SEEN_EXT)).map((x) => x.slice(0, -SEEN_EXT.length));
}

function saveSeen(cfg, seen) {
  const dir = seenDirOf(cfg);
  if (!dir) {
    const f = seenFileOf(cfg);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify([...new Set(seen)]));
    return;
  }
  mkdirSync(dir, { recursive: true });
  for (const id of new Set(seen)) if (id) markSeen(cfg, id);
}

// 目录化 seen: 每条已读消息一个 `.seen` 标记文件, 临时文件 + 原子 rename 写入 (并发安全)
function markSeen(cfg, id) {
  if (!id) return;
  const dir = seenDirOf(cfg);
  if (!dir) {
    const cur = loadSeen(cfg);
    if (!cur.includes(id)) saveSeen(cfg, [...cur, id]);
    return;
  }
  migrateSeen(cfg, dir);
  mkdirSync(dir, { recursive: true });
  const mark = join(dir, seenMarkName(id));
  if (existsSync(mark)) return;
  const tmp = join(dir, `.tmp-${id}`);
  writeFileSync(tmp, "", "utf-8");
  renameSync(tmp, mark);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------
function cmdInit(cfg, configPath, args) {
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
  console.log(JSON.stringify(out, null, 2));
}

function cmdSend(cfg, args) {
  if (!args.to) throw new Error("send 需要 --to <id|all>");
  let payload = {};
  if (args.payload) {
    try { payload = JSON.parse(args.payload); } catch { throw new Error(`payload 不是合法 JSON: ${args.payload}`); }
  }
  const dirs = resolveDirs(cfg);
  mkdirSync(dirs.out, { recursive: true });
  const id = `${ts()}${rand4()}-${rand4()}`;
  const msg = {
    id, from: cfg.identity, to: args.to,
    type: args.type || "notify",
    topic: args.topic || "",
    payload,
    ts: Date.now(),
    reply_to: args.replyTo || "",
  };
  writeFileSync(join(dirs.out, `msg_${id}.json`), JSON.stringify(msg) + "\n", "utf-8");
  console.log(`sent ${id}  (${new Date().toTimeString().slice(0, 8)})`);
}

function cmdRecv(cfg, args) {
  const msgs = recvNew(cfg, true);
  if (msgs.length === 0) { console.log("(无新消息)"); return; }
  if (args.format === "json") {
    for (const m of msgs) console.log(JSON.stringify(m));
  } else {
    for (const m of msgs) {
      const p = m.payload && Object.keys(m.payload).length ? JSON.stringify(m.payload) : "";
      console.log(`[${m.from} -> ${m.to}] ${m.type} topic=${m.topic} id=${m.id}`);
      if (m.reply_to) console.log(`   reply_to=${m.reply_to} ts=${m.ts}`);
      if (p) console.log(`   payload: ${p}`);
    }
  }
}

function recvNew(cfg, mark) {
  const seen = loadSeen(cfg);
  const dirs = resolveDirs(cfg);
  const fresh = [];
  for (const dir of dirs.in) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.startsWith("msg_") && f.endsWith(".json")).sort()) {
      try {
        const m = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        if ((m.to === cfg.identity || m.to === "all") && !seen.includes(m.id)) {
          fresh.push(m);
          if (mark) markSeen(cfg, m.id);
        }
      } catch { /* 跳过损坏消息 */ }
    }
  }
  return fresh;
}

async function cmdWait(cfg, args) {
  const timeoutSec = cfg.timeoutSec;
  const started = Date.now();
  for (;;) {
    const msgs = recvNew(cfg, true);
    if (msgs.length > 0) {
      console.log(`=== NEW MESSAGES: ${msgs.length} ===`);
      for (const m of msgs) console.log(JSON.stringify(m));
      console.log("=== WAKE-UP (exit 0) ===");
      process.exit(0);
    }
    if (timeoutSec > 0 && (Date.now() - started) / 1000 >= timeoutSec) {
      console.log(`TIMEOUT after ${timeoutSec}s, no new messages`);
      process.exit(0);
    }
    await sleep(cfg.intervalSec * 1000);
  }
}

async function cmdPoll(cfg, args) {
  let handler = null;
  if (args.handlers) {
    const p = resolve(args.handlers);
    handler = await import("file://" + p.replace(/\\/g, "/"));
    console.log(`已加载 handlers: ${p}`);
  }
  console.log(`poll 启动 (identity=${cfg.identity} 每 ${cfg.intervalSec}s). Ctrl+C 退出`);
  for (;;) {
    try {
      for (const m of recvNew(cfg, true)) {
        console.log(`[收到] from=${m.from} type=${m.type} topic=${m.topic} id=${m.id}`);
        let handled = false;
        if (handler && typeof handler.handle === "function") {
          handled = await handler.handle(m, { cfg, send: (o) => sendFrom(cfg, { ...o, from: cfg.identity }) });
        }
        if (!handled) {
          if (m.type === "request") {
            sendFrom(cfg, { to: m.from, type: "response", topic: m.topic, payload: { echo: m.payload, from: cfg.identity }, replyTo: m.id });
            console.log(`  → 已回 response (reply_to=${m.id})`);
          } else {
            console.log(JSON.stringify(m));
          }
        }
        try { removeMsg(cfg, m.id, true); } catch { /* 权限不足则跳过 */ }
      }
    } catch (e) {
      console.warn(`轮询异常: ${e.message}`);
    }
    await sleep(cfg.intervalSec * 1000);
  }
}

function sendFrom(cfg, { to, type = "notify", topic = "", payload = {}, replyTo = "" }) {
  const dirs = resolveDirs(cfg);
  mkdirSync(dirs.out, { recursive: true });
  const id = `${ts()}${rand4()}-${rand4()}`;
  const msg = { id, from: cfg.identity, to, type, topic, payload, ts: Date.now(), reply_to: replyTo };
  writeFileSync(join(dirs.out, `msg_${id}.json`), JSON.stringify(msg) + "\n", "utf-8");
  return id;
}

function removeMsg(cfg, id, inbox) {
  const dirs = resolveDirs(cfg);
  const targets = inbox ? dirs.in : [dirs.out];
  for (const dir of targets) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("msg_") || !f.endsWith(".json")) continue;
      try {
        const m = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        if (m.id === id) { rmSync(join(dir, f), { force: true }); return; }
      } catch { /* 跳过 */ }
    }
  }
}

function cmdClean(cfg, args) {
  const ttlHours = args.ttlHours !== undefined ? Number(args.ttlHours) : 24;
  const dryRun = !!args.dryRun;
  const dirs = resolveDirs(cfg);
  if (!existsSync(dirs.out)) { console.log(`clean: 0 条 (目录不存在)`); return; }
  const cutoff = Date.now() - ttlHours * 3600 * 1000;
  let removed = 0;
  for (const f of readdirSync(dirs.out)) {
    if (!f.startsWith("msg_") || !f.endsWith(".json")) continue;
    const p = join(dirs.out, f);
    try {
      if (statSync(p).mtimeMs < cutoff) {
        if (!dryRun) rmSync(p, { force: true });
        removed++;
      }
    } catch { /* 跳过 */ }
  }
  console.log(`clean: ${dryRun ? "dry-run" : "已删除"} ${removed} 条过期消息 (TtlHours=${ttlHours})`);
}

function cmdStatus(cfg) {
  const dirs = resolveDirs(cfg);
  const seen = loadSeen(cfg).length;
  const outCount = existsSync(dirs.out) ? readdirSync(dirs.out).filter((f) => f.startsWith("msg_")).length : 0;
  console.log(`身份: ${cfg.identity}  layout=${cfg.layout}`);
  console.log(`写:   ${dirs.out}  (消息 ${outCount})`);
  console.log(`seen: ${seen} 条`);
  for (const d of dirs.in) {
    const n = existsSync(d) ? readdirSync(d).filter((f) => f.startsWith("msg_")).length : 0;
    console.log(`读:   ${d}  (消息 ${n})`);
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function rand4() {
  return Math.random().toString(16).slice(2, 6).padEnd(4, "0");
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "status";
const { cfg, configPath } = getConfig(args);

try {
  switch (command) {
    case "init": cmdInit(cfg, configPath, args); break;
    case "send": cmdSend(cfg, args); break;
    case "recv": cmdRecv(cfg, args); break;
    case "wait": await cmdWait(cfg, args); break;
    case "poll": await cmdPoll(cfg, args); break;
    case "clean": cmdClean(cfg, args); break;
    case "status": cmdStatus(cfg); break;
    default:
      console.error(`未知命令: ${command} (可用: init/send/recv/wait/poll/clean/status)`);
      process.exit(1);
  }
} catch (e) {
  console.error(`[mailbox] ${e.message}`);
  process.exit(1);
}
