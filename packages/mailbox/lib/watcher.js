// ============================================================================
//  @yuanchilin/dsh-mailbox — 插件内建 watcher (根治"重启杀监听")
//
//  背景: 用 CLI `wait` 挂后台 job 的监听属于会话进程, dsh 一重启就死。
//  方案: 监听做进插件本身 —— 插件每次启动 apply() 都会自动重启 watcher,
//        不依赖会话进程。轮询 <root>/ 各参与者目录, 发现发给"在线会话身份"
//        的新消息, 为该会话的 agent 创建一个立即完成的后台 job —— DSH 的
//        后台 job 完成通知会唤醒该 agent (与 CLI wait 完成唤醒同机制)。
//
//  去重: 收件人 seen 文件里已有的消息不重复唤醒 (已处理不打扰);
//        本进程内 known 集合保证同一文件只唤醒一次。
//
//  安全: jobs/agents 服务缺失时静默降级 (不影响其他 profile 启动);
//        任何轮询异常吞掉下轮重试, 绝不抛向启动流程。
// ============================================================================

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as core from "./core.js";

/**
 * 纯检测逻辑: 扫描 root 下参与者目录 (跳过 _/. 前缀), 找出 live 身份未 seen
 * 的新消息。known (Set<绝对路径>) 就地更新; 返回 Map<identity, msg[]>。
 */
export function scanMailboxRoot(root, known, live) {
  const fresh = new Map();
  if (!existsSync(root)) return fresh;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const dirPath = join(root, entry.name);
    let files;
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.startsWith("msg_") || !f.endsWith(".json")) continue;
      const filePath = join(dirPath, f);
      if (known.has(filePath)) continue;
      known.add(filePath);
      let m;
      try {
        m = JSON.parse(readFileSync(filePath, "utf-8"));
      } catch {
        continue; // 损坏消息跳过
      }
      for (const identity of live.keys()) {
        if (m.to !== identity && m.to !== "all") continue;
        // 自收消息 (from=自己): recv 只扫别人目录, 永远读不到 → 不唤醒 (否则每次重启重复响铃)
        if (m.from === identity) continue;
        // 收件人已处理 (seen 含该 id) 则不重复唤醒
        const seenPath = join(root, identity, ".seen.json");
        if (existsSync(seenPath)) {
          try {
            const v = JSON.parse(readFileSync(seenPath, "utf-8"));
            const seen = Array.isArray(v) ? v : [v];
            if (seen.includes(m.id)) continue;
          } catch {
            // seen 损坏则视为未处理, 照常唤醒
          }
        }
        if (!fresh.has(identity)) fresh.set(identity, []);
        fresh.get(identity).push(m);
      }
    }
  }
  return fresh;
}

/**
 * 启动内建 watcher。返回停止函数 (或 undefined = 未启用/环境不支持)。
 * jobs/agents 为惰性获取: 缺失即静默不启用 (web 面两者都存在)。
 */
export function startMailboxWatcher(ctx, cfg) {
  if (cfg.watcher === false || cfg.layout !== "root" || !cfg.root) return undefined;
  const jobs = ctx.get("jobs");
  const agents = ctx.get("agents");
  if (!jobs || typeof jobs.start !== "function") return undefined;
  if (!agents || typeof agents.list !== "function") return undefined;

  const known = new Set();

  const tick = () => {
    try {
      const live = new Map(); // identity → agent
      for (const agent of agents.list()) {
        try {
          const identity = core.effectiveIdentity(cfg, agent.session);
          if (identity) live.set(identity, agent);
        } catch {
          // 该 agent 无会话/身份, 跳过
        }
      }
      if (live.size === 0) return;
      const fresh = scanMailboxRoot(cfg.root, known, live);
      for (const [identity, messages] of fresh) {
        const agent = live.get(identity);
        for (const m of messages) {
          try {
            jobs.start({
              kind: "mailbox",
              label: `mailbox 新消息: [${m.from} -> ${m.to}] ${m.topic || "(无主题)"}`,
              owner: agent,
              run: () => ({
                cancel: () => {},
                done: Promise.resolve({
                  status: "completed",
                  detail: `[${m.from} -> ${m.to}] ${m.topic || ""}`,
                  output: `收到新消息 id=${m.id} from=${m.from} topic=${m.topic || ""}\n调用 mailbox_recv 读取处理。`,
                }),
              }),
            });
          } catch {
            // 单个唤醒失败不影响其他 (如 kind 不被 jobs 实现接受)
          }
        }
      }
    } catch {
      // 轮询异常静默, 下轮重试
    }
  };

  tick(); // 启动即扫一遍 (重启后立刻发现遗留未读)
  const handle = setInterval(tick, (cfg.intervalSec || 2) * 1000);
  const stop = () => clearInterval(handle);
  if (typeof ctx.effect === "function") ctx.effect(() => stop);
  return stop;
}
