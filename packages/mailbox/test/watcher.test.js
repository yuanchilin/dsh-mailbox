import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../lib/core.js";
import { scanMailboxRoot, startMailboxWatcher } from "../lib/watcher.js";

const fakeSession = (id, cwd) => ({ id, header: { cwd }, events: [] });
const fakeAgent = (id, cwd) => ({ session: fakeSession(id, cwd) });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-mailbox-watch-"));
  return root;
}

function writeMsg(root, fromDir, msg) {
  mkdirSync(join(root, fromDir), { recursive: true });
  writeFileSync(join(root, fromDir, `msg_${msg.id}.json`), JSON.stringify({ topic: "", payload: {}, ts: Date.now(), reply_to: "", ...msg }));
}

test("scanMailboxRoot: 检测新消息 (定向 + 广播 + 跳过 _ 目录)", () => {
  const root = setup();
  try {
    writeMsg(root, "rp-bbbb0000", { id: "m1", from: "rp-bbbb0000", to: "dsh-mailbox-aaaa0000", topic: "hello" });
    writeMsg(root, "rp-bbbb0000", { id: "m2", from: "rp-bbbb0000", to: "all", topic: "broadcast" });
    writeMsg(root, "rp-bbbb0000", { id: "m3", from: "rp-bbbb0000", to: "someone-else", topic: "other" });
    mkdirSync(join(root, "_sessions"));
    writeFileSync(join(root, "_sessions", "x.json"), "{}");

    const live = new Map([["dsh-mailbox-aaaa0000", fakeAgent("session-aaaa0000-1111", "D:/ws/dsh-mailbox")]]);
    const fresh = scanMailboxRoot(root, new Set(), live);
    assert.equal(fresh.get("dsh-mailbox-aaaa0000").length, 2, "定向 + 广播各一条");
    assert.ok(fresh.get("dsh-mailbox-aaaa0000").some((m) => m.id === "m1"));
    assert.ok(fresh.get("dsh-mailbox-aaaa0000").some((m) => m.id === "m2"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanMailboxRoot: known 去重 + seen 去重", () => {
  const root = setup();
  try {
    writeMsg(root, "rp-bbbb0000", { id: "m1", from: "rp-bbbb0000", to: "dsh-mailbox-aaaa0000", topic: "hello" });
    const live = new Map([["dsh-mailbox-aaaa0000", fakeAgent("session-aaaa0000-1111", "D:/ws/dsh-mailbox")]]);
    const known = new Set();
    assert.equal(scanMailboxRoot(root, known, live).size, 1);
    assert.equal(scanMailboxRoot(root, known, live).size, 0, "known 去重: 同文件不重复");
    // seen 去重: 收件人 seen 含该 id → 新 known 也不唤醒
    mkdirSync(join(root, "dsh-mailbox-aaaa0000"), { recursive: true });
    writeFileSync(join(root, "dsh-mailbox-aaaa0000", ".seen.json"), JSON.stringify(["m1"]));
    assert.equal(scanMailboxRoot(root, new Set(), live).size, 0, "seen 去重: 已处理不唤醒");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startMailboxWatcher: 新消息 → 为 owner agent 创建完成 job", () => {
  const root = setup();
  try {
    const agentA = fakeAgent("session-aaaa0000-1111", "D:/ws/dsh-mailbox");
    writeMsg(root, "rp-bbbb0000", { id: "m1", from: "rp-bbbb0000", to: "dsh-mailbox-aaaa0000", topic: "hello" });
    const starts = [];
    const ctx = {
      get: (key) => (key === "jobs"
        ? { start: (spec) => { starts.push(spec); return "mailbox-1"; } }
        : key === "agents" ? { list: () => [agentA] } : undefined),
      effect: () => () => {},
    };
    const stop = startMailboxWatcher(ctx, resolveConfig({ root }));
    assert.equal(starts.length, 1, "初始 tick 同步唤醒一次");
    const spec = starts[0];
    assert.equal(spec.owner, agentA);
    assert.equal(spec.kind, "mailbox");
    const hooks = spec.run();
    assert.equal(typeof hooks.cancel, "function");
    stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scanMailboxRoot: 自收消息不唤醒 (recv 读不到, 避免重启重复响铃)", () => {
  const root = setup();
  try {
    writeMsg(root, "dsh-mailbox-aaaa0000", { id: "self1", from: "dsh-mailbox-aaaa0000", to: "dsh-mailbox-aaaa0000", topic: "self" });
    const live = new Map([["dsh-mailbox-aaaa0000", fakeAgent("session-aaaa0000-1111", "D:/ws/dsh-mailbox")]]);
    assert.equal(scanMailboxRoot(root, new Set(), live).size, 0, "from=自己 → 不唤醒");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startMailboxWatcher: jobs/agents 缺失 → 静默不启用", () => {
  const root = setup();
  try {
    const ctx = { get: () => undefined, effect: () => () => {} };
    assert.equal(startMailboxWatcher(ctx, resolveConfig({ root })), undefined);
    // watcher: false 配置同样禁用
    const ctx2 = {
      get: (key) => (key === "jobs" ? { start: () => { throw new Error("不应调用"); } } : undefined),
      effect: () => () => {},
    };
    assert.equal(startMailboxWatcher(ctx2, resolveConfig({ root, watcher: false })), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
