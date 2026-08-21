// ============================================================================
//  @yuanchilin/dsh-mailbox — core
//
//  跨会话文件信箱核心逻辑（与 mailbox.psm1 / mailbox.mjs 同协议）:
//    - N 参与者对等模型: 每人一个信箱目录, 各写各的, 互读对方的
//    - layout=root: <root>/<id>/ 每人一子目录 (participants 留空自动扫描)
//    - layout=dirs: dirs: { "<id>": "<目录>" } 显式映射 (旧双目录兼容)
//    - 消息: { id, from, to, type, topic, payload, ts, reply_to }, 文件 msg_<id>.json
//    - 路由: to=<id> 定向 / to=all 广播 (写一份, 各人自取)
//    - seen 去重: 每参与者独立 seen 目录 (默认 <outDir>/.seen/, 每消息一个 .seen 标记, 原子写)
// ============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

/** 默认信箱根目录: DSH_HOME 已是 .dsh 主目录时直接接 mailbox (如 C:/Users/<user>/.dsh/mailbox); 无 DSH_HOME 时回退 ~/.dsh/mailbox。 */
export function defaultMailboxRoot() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "mailbox");
}

export const DEFAULTS = {
  identity: "",
  layout: "root",      // "root" | "dirs"
  root: defaultMailboxRoot(),
  dirs: {},
  participants: [],
  intervalSec: 2,
  timeoutSec: 0,
  seenFile: "",
  patchRoot: "",
  presenceWindowSec: 300, // 在线判定窗口 (秒): lastSeen 在该窗口内视为在线
  watcher: true,          // 插件内建监听 (新消息 → 唤醒会话 agent; 重启自动复活)
};

/** 合并默认值(可选: 环境变量 > 显式覆盖)。插件侧直接传 Config 对象, CLI 侧先加载配置文件。 */
export function resolveConfig(partial = {}, env = {}) {
  const cfg = { ...DEFAULTS, ...partial };
  // schema 默认 "" 会覆盖 DEFAULTS 的回退值 (如 root=DSH_HOME/mailbox),
  // 导致零配置下 root 为空 → 注册表无法写入 → 会话目录永远为空。
  // 空 root / patchRoot 视为"未配置", 回退到 DEFAULTS。
  if (!cfg.root) cfg.root = DEFAULTS.root;
  if (!cfg.patchRoot) cfg.patchRoot = DEFAULTS.patchRoot;
  if (env.MAILBOX_ID) cfg.identity = env.MAILBOX_ID;
  if (env.MAILBOX_ROOT) { cfg.root = env.MAILBOX_ROOT; cfg.layout = "root"; }
  if (env.MAILBOX_INTERVAL) cfg.intervalSec = Number(env.MAILBOX_INTERVAL);
  if (env.MAILBOX_TIMEOUT) cfg.timeoutSec = Number(env.MAILBOX_TIMEOUT);
  if (!Array.isArray(cfg.participants)) cfg.participants = [];
  return cfg;
}

export function resolveDirs(cfg) {
  if (cfg.layout === "dirs") {
    if (!cfg.dirs || !cfg.dirs[cfg.identity]) {
      throw new Error(`layout=dirs 但配置缺少 identity '${cfg.identity}' 的目录映射`);
    }
    const out = cfg.dirs[cfg.identity];
    const inDirs = [...new Set(Object.entries(cfg.dirs).filter(([k]) => k !== cfg.identity).map(([, v]) => v))];
    return { out, in: inDirs };
  }
  if (!cfg.root) throw new Error("layout=root 需要配置 root");
  if (!cfg.identity) throw new Error("layout=root 需要 identity (显式配置或按会话自动派生)");
  const out = join(cfg.root, cfg.identity);
  let participants = cfg.participants.filter(Boolean);
  if (participants.length === 0 && existsSync(cfg.root)) {
    participants = readdirSync(cfg.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
      .map((d) => d.name);
  }
  const inDirs = [...new Set(participants.filter((p) => p !== cfg.identity).map((p) => join(cfg.root, p)))];
  return { out, in: inDirs };
}

const SEEN_EXT = ".seen";

/**
 * seen 旧默认文件路径 (仅用于迁移检测; 显式 cfg.seenFile 时作为单文件存储路径)。
 */
export function seenFileOf(cfg) {
  if (cfg.seenFile) return cfg.seenFile;
  return join(resolveDirs(cfg).out, ".seen.json");
}

/**
 * 目录化 seen 的存储目录。显式配置 cfg.seenFile 时走旧"单 JSON 数组文件"
 * 兼容路径, 返回 "" (此时用 seenFileOf)。
 *
 * 默认目录化: 每条已读消息一个 `.seen` 标记文件, 通过临时文件 + 原子 rename
 * 写入 —— 多进程/多主机并发 recv 互不覆盖, 根治单文件"读改写"丢 seen 记录。
 */
function seenDirOf(cfg) {
  if (cfg.seenFile) return "";
  return join(resolveDirs(cfg).out, ".seen");
}

function seenMarkName(id) { return `${id}${SEEN_EXT}`; }

/** 目录模式下, 把旧的单文件 .seen.json 迁移到 .seen/ 目录 (幂等; 显式 seenFile 时跳过)。 */
function migrateSeen(cfg, dir) {
  const legacy = seenFileOf(cfg);
  if (cfg.seenFile || !existsSync(legacy) || existsSync(dir)) return;
  try {
    const v = JSON.parse(readFileSync(legacy, "utf-8"));
    const arr = Array.isArray(v) ? v : [v];
    mkdirSync(dir, { recursive: true });
    for (const id of arr) {
      if (id) writeFileSync(join(dir, seenMarkName(id)), "", "utf-8");
    }
    rmSync(legacy, { force: true });
  } catch {
    // 迁移失败则保留旧文件; 目录不在时单文件 loadSeen/markSeen 仍兼容
  }
}

export function loadSeen(cfg) {
  const dir = seenDirOf(cfg);
  if (!dir) { // 单文件模式 (显式 seenFile)
    const f = seenFileOf(cfg);
    if (!existsSync(f)) return [];
    try {
      // pwsh 旧版本可能把单元素 seen 写成裸字符串 "id", 归一化为数组
      const v = JSON.parse(readFileSync(f, "utf-8"));
      return Array.isArray(v) ? v : [v];
    } catch {
      return [];
    }
  }
  migrateSeen(cfg, dir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((x) => x.endsWith(SEEN_EXT))
    .map((x) => x.slice(0, -SEEN_EXT.length));
}

/** 批量补写 (迁移/兼容调用; 目录模式逐条原子标记)。 */
export function saveSeen(cfg, seen) {
  const dir = seenDirOf(cfg);
  if (!dir) { // 单文件模式
    const f = seenFileOf(cfg);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify([...new Set(seen)]));
    return;
  }
  mkdirSync(dir, { recursive: true });
  for (const id of new Set(seen)) {
    if (id) markSeen(cfg, id);
  }
}

/** 标记单条已读: 目录模式临时文件 + rename 原子写入, 并发安全; 单文件模式读改写尽力兼容。 */
export function markSeen(cfg, id) {
  if (!id) return;
  const dir = seenDirOf(cfg);
  if (!dir) { // 单文件: 读改写 (显式配置, 为一次并发安全做尽力而为)
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
  renameSync(tmp, mark); // 原子 rename: 目录模式下并发写互不覆盖
}

/** 单条已读判定: 目录模式 O(1) 存在性检查 (供 watcher/unread 高效判断)。 */
export function isSeen(cfg, id) {
  const dir = seenDirOf(cfg);
  if (!dir) return loadSeen(cfg).includes(id);
  return existsSync(join(dir, seenMarkName(id)));
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand4 = () => Math.random().toString(16).slice(2, 6).padEnd(4, "0");
  return `${ts}-${rand4()}-${rand4()}`;
}

/** 发送: 写到自己的目录 (对方读你的目录)。to 支持 identity / 别名 / 完整 sessionId / all。返回消息 id。 */
export function sendMessage(cfg, { to, type = "notify", topic = "", payload = {}, replyTo = "" }) {
  if (!to) throw new Error("send 需要 to (参与者 id 或 all)");
  const target = resolveTarget(cfg, to);
  const dirs = resolveDirs(cfg);
  mkdirSync(dirs.out, { recursive: true });
  const id = newId();
  const msg = { id, from: cfg.identity, to: target, type, topic, payload, ts: Date.now(), reply_to: replyTo };
  writeFileSync(join(dirs.out, `msg_${id}.json`), JSON.stringify(msg) + "\n", "utf-8");
  return id;
}

/** 接收: 扫描所有对方目录, 取 to=自己 或 to=all 且未 seen 的消息。mark 默认 true。 */
export function recvNew(cfg, mark = true) {
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
      } catch {
        // 跳过损坏消息
      }
    }
  }
  return fresh;
}

// ---- 回执协议 (ack): 让"确认"成为协议一等公民 ----
//
// 生命周期: request 被消费时接收方自动回 delivered → 处理完回 done/error。
// 回执即普通 reply 消息 (topic="status", payload.status, reply_to=原消息id),
// 写接收方自己的目录, 发送方扫描对方目录即可读到 —— 不需要新通道。
// 幂等: 同一 (requestId, status) 只回一次, 防重启/重复消费导致重复回执。

export const ACK_TOPIC = "status";
const ACK_STATUSES = ["delivered", "processing", "done", "error"];

/** 本会话是否已对 requestId 发过指定 status 的回执 (扫自己发件目录, 幂等防重)。 */
export function hasAck(cfg, requestId, status) {
  if (!requestId || !status) return false;
  const dirs = resolveDirs(cfg);
  if (!existsSync(dirs.out)) return false;
  for (const f of readdirSync(dirs.out)) {
    if (!f.startsWith("msg_") || !f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(dirs.out, f), "utf-8"));
      if (m.reply_to === requestId && m.payload?.status === status) return true;
    } catch {
      // 跳过损坏消息
    }
  }
  return false;
}

/**
 * 回执: 向 request 消息的发送者回一条 reply (status: delivered|processing|done|error)。
 * 返回 true=已写入回执, false=跳过 (参数缺失 / 发给自己 / 幂等已存在)。
 */
export function sendAck(cfg, request, status, extra = {}) {
  if (!request || !request.id || !request.from || !ACK_STATUSES.includes(status)) return false;
  if (request.from === cfg.identity) return false;
  if (hasAck(cfg, request.id, status)) return false;
  sendMessage(cfg, {
    to: request.from,
    type: "reply",
    topic: ACK_TOPIC,
    payload: { status, requestId: request.id, ...extra },
    replyTo: request.id,
  });
  return true;
}

/** 查询 requestId 的最近回执: 扫描各对方目录中 reply_to===requestId 的消息。 */
// 决胜规则 (确定性, 不依赖 readdir 顺序/平台): 先比 ts, 同 ms 再比状态语义
// 优先级 error > done > processing > delivered —— 终态永远压过中间态。
const ACK_WEIGHT = { error: 3, done: 2, processing: 1, delivered: 0 };
export function latestReplyStatus(cfg, requestId, expectFrom = "") {
  let best = null; // { ts, status, id, from, payload }
  for (const dir of resolveDirs(cfg).in) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.startsWith("msg_") && x.endsWith(".json")).sort()) {
      try {
        const m = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        if (m.reply_to !== requestId) continue;
        if (expectFrom && m.from !== expectFrom) continue;
        if (m.payload?.status) {
          const ts = m.ts ?? 0;
          const w = ACK_WEIGHT[m.payload.status] ?? 0;
          const bw = best ? (ACK_WEIGHT[best.status] ?? 0) : -1;
          if (!best || ts > best.ts || (ts === best.ts && w > bw)) {
            best = { ts, status: m.payload.status, id: m.id, from: m.from, payload: m.payload };
          }
        }
      } catch {
        // 跳过损坏消息
      }
    }
  }
  return best;
}

/** 按 id 删除消息: inbox=true 删对方目录(已处理), 否则删自己的目录(已发送)。 */
export function removeMessage(cfg, id, inbox = false) {
  const dirs = resolveDirs(cfg);
  const targets = inbox ? dirs.in : [dirs.out];
  for (const dir of targets) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("msg_") || !f.endsWith(".json")) continue;
      try {
        const m = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        if (m.id === id) {
          rmSync(join(dir, f), { force: true });
          return true;
        }
      } catch {
        // 跳过
      }
    }
  }
  return false;
}

/** TTL 清理: 删除自己 OutDir 中超过 ttlHours 的已发送消息 (收方应已读过)。返回删除数。 */
export function cleanTTL(cfg, { ttlHours = 24, dryRun = false } = {}) {
  const dirs = resolveDirs(cfg);
  if (!existsSync(dirs.out)) return 0;
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
    } catch {
      // 跳过
    }
  }
  return removed;
}

/** 状态: 身份/布局/目录/消息数/未读数 + 会话目录(注册表)。 */
export function statusOf(cfg) {
  const dirs = resolveDirs(cfg);
  const seen = loadSeen(cfg);
  const outCount = existsSync(dirs.out)
    ? readdirSync(dirs.out).filter((f) => f.startsWith("msg_")).length
    : 0;
  const inboxes = dirs.in.map((dir) => ({
    dir,
    name: basename(dir),
    msgCount: existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("msg_")).length : 0,
    unread: unreadInDir(cfg, dir),
  }));
  const sessions = listSessions(cfg).map((s) => ({
    ...s,
    online: isOnline(s, cfg.presenceWindowSec),
    unread: unreadFrom(cfg, s.identity),
  }));
  return { identity: cfg.identity, layout: cfg.layout, outDir: dirs.out, outCount, seen: seen.length, inboxes, sessions };
}

/** 校验配置是否可用于收发 (identity/目录已解析)。 */
export function assertUsable(cfg) {
  if (!cfg.identity) throw new Error("mailbox 未配置 identity (在 cordis.patch.yml 的 mailbox 配置中设置)");
  resolveDirs(cfg); // 抛错即不可用
}

// ============================================================================
//  会话身份 + 注册表 (发现 / 在线 / 别名 / 目标解析)
//
//  背景: 一个工作区下可能开多个会话, 不能按工作区区分身份。
//  方案: 身份默认按 <工作区名>-<会话短id> 自动派生 (每会话唯一),
//        显式 config.identity 仍是最高优先级 (固定身份 / 旧配置兼容)。
//  注册表: <root>/_sessions/<sessionId>.json, 每次工具调用写心跳 (lastSeen),
//         `mailbox_sessions` / `status` 据此展示会话目录与在线状态。
// ============================================================================

const REGISTRY_DIR = "_sessions"; // 位于 root 下, 参与者扫描会跳过 "_" 前缀目录

/** 从 DSH Session 提取会话上下文 (sessionId / workspace cwd / 折叠标题)。无会话返回 undefined。 */
export function sessionCtx(session) {
  if (!session) return undefined;
  const sessionId = typeof session.id === "string" ? session.id : "";
  const workspace = typeof session.header?.cwd === "string" ? session.header.cwd : "";
  let title = "";
  const events = Array.isArray(session.events) ? session.events : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "session/title" && typeof e.data?.title === "string") {
      title = e.data.title;
      break;
    }
  }
  if (!sessionId && !workspace && !title) return undefined;
  return { sessionId, workspace, title };
}

function slugify(s) {
  return String(s || "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ws";
}

/** 按会话派生身份: <工作区名>-<会话短id> (同一工作区多会话互不冲突, 稳定唯一)。无真实会话返回空。 */
export function deriveIdentity(ctx) {
  if (!ctx || !ctx.sessionId) return "";
  const ws = slugify(ctx.workspace ? basename(ctx.workspace) : "workspace");
  const short = String(ctx.sessionId).replace(/^session-/, "").slice(0, 8) || "anon";
  return `${ws}-${short}`;
}

/** 身份优先级: 显式 config.identity > 会话派生 > "" (无法确定)。 */
export function effectiveIdentity(cfg, session) {
  if (cfg.identity) return cfg.identity;
  return deriveIdentity(sessionCtx(session));
}

/** 本次调用的有效配置: 解析身份, 无身份时抛出带指引的错误。 */
export function effectiveConfig(cfg, session) {
  const identity = effectiveIdentity(cfg, session);
  if (!identity) {
    const hint = cfg.layout === "dirs"
      ? "layout=dirs 需要在配置中显式设置 identity"
      : "identity 留空会自动按会话生成; 当前调用无会话上下文 (CLI 请显式传 --identity)";
    throw new Error(`mailbox 无法确定身份: ${hint}`);
  }
  return { ...cfg, identity };
}

/** 注册表目录 (仅 layout=root): <root>/_sessions。 */
export function registryDir(cfg) {
  if (cfg.layout !== "root" || !cfg.root) return "";
  return join(cfg.root, REGISTRY_DIR);
}

function registryFileOf(cfg, key) {
  const dir = registryDir(cfg);
  return dir ? join(dir, `${key}.json`) : "";
}

function readRegistry(cfg, key) {
  const f = registryFileOf(cfg, key);
  if (!f || !existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf-8"));
  } catch {
    return undefined;
  }
}

/** 心跳: 每次工具调用更新本会话注册信息 (含在线时间戳)。无会话上下文返回 undefined。 */
export function touchRegistry(cfg, session, { alias } = {}) {
  const ctx = sessionCtx(session);
  const dir = registryDir(cfg);
  if (!ctx || !dir) return undefined;
  const key = ctx.sessionId || "unknown";
  const prev = readRegistry(cfg, key) || {};
  const now = Date.now();
  const rec = {
    sessionId: ctx.sessionId,
    identity: effectiveIdentity(cfg, session),
    alias: alias !== undefined ? alias : (prev.alias || ""),
    workspace: ctx.workspace,
    title: ctx.title || prev.title || "",
    firstSeen: prev.firstSeen || now,
    lastSeen: now,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(registryFileOf(cfg, key), JSON.stringify(rec, null, 2) + "\n", "utf-8");
  return rec;
}

/** CLI 侧心跳 (无会话上下文): 以 cli-<identity> 为键登记, 让其他会话看到 CLI 参与者。 */
export function touchRegistryCli(cfg, { workspace = "" } = {}) {
  const dir = registryDir(cfg);
  if (!dir || !cfg.identity) return undefined;
  const key = `cli-${cfg.identity}`;
  const prev = readRegistry(cfg, key) || {};
  const now = Date.now();
  const rec = {
    sessionId: "",
    identity: cfg.identity,
    alias: prev.alias || "",
    workspace: workspace || prev.workspace || "",
    title: prev.title || "CLI",
    firstSeen: prev.firstSeen || now,
    lastSeen: now,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(registryFileOf(cfg, key), JSON.stringify(rec, null, 2) + "\n", "utf-8");
  return rec;
}

/** 会话目录: 所有已注册会话, 按 lastSeen 倒序。 */
export function listSessions(cfg) {
  const dir = registryDir(cfg);
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf-8")));
    } catch {
      // 跳过损坏记录
    }
  }
  return out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

/** 在线判定: lastSeen 在 presenceWindowSec 窗口内视为在线。 */
export function isOnline(rec, windowSec) {
  return !!(rec && rec.lastSeen && Date.now() - rec.lastSeen < (windowSec || 300) * 1000);
}

/** 设置/更换本会话别名 (全库唯一, 拒绝被其他会话占用)。 */
export function setAlias(cfg, session, alias) {
  const dir = registryDir(cfg);
  if (!dir) throw new Error("setAlias 仅支持 layout=root (需配置 root)");
  alias = String(alias || "").trim();
  if (!alias) throw new Error("alias 不能为空");
  if (!/^[a-zA-Z0-9._-]{1,32}$/.test(alias)) throw new Error("alias 仅允许字母数字 . _ - (≤32 字符)");
  const me = sessionCtx(session);
  if (!me || !me.sessionId) throw new Error("无法设置别名: 缺少会话上下文");
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let r;
    try {
      r = JSON.parse(readFileSync(join(dir, f), "utf-8"));
    } catch {
      continue;
    }
    if (r.alias === alias && r.sessionId !== me.sessionId) {
      throw new Error(`alias "${alias}" 已被 ${r.identity} 占用 (${r.workspace || "?"}${r.title ? ` / ${r.title}` : ""})`);
    }
  }
  return touchRegistry(cfg, session, { alias });
}

/** 目标解析: all → all; 别名 / 完整 sessionId / 工作区路径或目录名 → 对应 identity; 否则原样 (视为 identity)。 */
export function resolveTarget(cfg, to) {
  if (to === "all") return "all";
  const sessions = listSessions(cfg);
  const byAlias = sessions.find((s) => s.alias && s.alias === to);
  if (byAlias) return byAlias.identity || to;
  const byId = sessions.find((s) => s.sessionId === to);
  if (byId) return byId.identity || to;
  // 按工作区匹配: 完整路径 (正反斜杠归一) 或目录名 (如 D:/.../dsh-mailbox 或 dsh-mailbox)
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const targetNorm = norm(to);
  const byWorkspace = sessions.find((s) => {
    const ws = norm(s.workspace);
    return ws === targetNorm || ws.split("/").pop() === targetNorm;
  });
  if (byWorkspace) return byWorkspace.identity || to;
  return to;
}

/** 目标是否已登记: all 或注册表中的 identity。 */
export function isKnownTarget(cfg, target) {
  if (target === "all") return true;
  return listSessions(cfg).some((s) => s.identity === target);
}

/** 会话目录文本 (地址簿): 每行 ●在线/○离线 identity (alias) workspace «title»。 */
export function sessionDirectoryText(cfg) {
  const sessions = listSessions(cfg);
  if (sessions.length === 0) return "(暂无注册会话: 各会话调用一次 mailbox 工具即自动登记)";
  return sessions
    .map((s) => {
      const on = isOnline(s, cfg.presenceWindowSec) ? "●在线" : "○离线";
      const alias = s.alias ? ` (${s.alias})` : "";
      const title = s.title ? `  «${s.title}»` : "";
      return `  ${on} ${s.identity}${alias}  ${s.workspace || "?"}${title}`;
    })
    .join("\n");
}

/** 未知目标的提示文本 (失败即地址簿: 让发送者从错误里找到收件人)。 */
export function unknownTargetHint(cfg, target) {
  return `目标 "${target}" 未登记。当前会话目录:\n${sessionDirectoryText(cfg)}`;
}

/** 统计某目录中发给我、尚未读的消息数。 */
export function unreadInDir(cfg, dir) {
  if (!existsSync(dir)) return 0;
  const seen = loadSeen(cfg);
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("msg_") || !f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf-8"));
      if ((m.to === cfg.identity || m.to === "all") && !seen.includes(m.id)) n++;
    } catch {
      // 跳过损坏消息
    }
  }
  return n;
}

/** 统计某 identity 发给我、尚未读的消息数。 */
export function unreadFrom(cfg, identity) {
  if (!cfg.root || !identity) return 0;
  return unreadInDir(cfg, join(cfg.root, identity));
}
