import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveConfig,
  defaultMailboxRoot,
  sendMessage,
  recvNew,
  statusOf,
  cleanTTL,
  removeMessage,
  assertUsable,
} from "../lib/core.js";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-mailbox-"));
  mkdirSync(join(root, "agent-a"));
  mkdirSync(join(root, "agent-b"));
  const cfgA = resolveConfig({ identity: "agent-a", root });
  const cfgB = resolveConfig({ identity: "agent-b", root });
  return { root, cfgA, cfgB };
}

const msgFiles = (dir) => readdirSync(dir).filter((f) => f.startsWith("msg_"));

test("往返 + seen 去重", () => {
  const { root, cfgA, cfgB } = setup();
  try {
    const id = sendMessage(cfgA, { to: "agent-b", topic: "hello", payload: { x: 1 } });
    const msgs = recvNew(cfgB);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, "agent-a");
    assert.equal(msgs[0].topic, "hello");
    assert.equal(msgs[0].payload.x, 1);
    assert.equal(msgs[0].id, id);
    assert.equal(recvNew(cfgB).length, 0, "seen 去重应生效");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("to=all 广播双方都收到", () => {
  const { root, cfgA, cfgB } = setup();
  try {
    mkdirSync(join(root, "rp"));
    const cfgR = resolveConfig({ identity: "rp", root });
    sendMessage(cfgR, { to: "all", topic: "broadcast" });
    assert.equal(recvNew(cfgA).length, 1);
    assert.equal(recvNew(cfgB).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reply_to 保留 (请求-响应)", () => {
  const { root, cfgA, cfgB } = setup();
  try {
    const reqId = sendMessage(cfgA, { to: "agent-b", type: "request", topic: "ping" });
    const [req] = recvNew(cfgB);
    sendMessage(cfgB, { to: "agent-a", type: "response", topic: "ping", replyTo: req.id });
    const [resp] = recvNew(cfgA);
    assert.equal(resp.reply_to, reqId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TTL 清理 + removeMessage", () => {
  const { root, cfgA, cfgB } = setup();
  try {
    sendMessage(cfgA, { to: "agent-b", topic: "old" });
    sendMessage(cfgA, { to: "agent-b", topic: "keep" });
    const outDir = join(root, "agent-a");
    const files = msgFiles(outDir);
    assert.equal(files.length, 2);
    // 把第一条消息的 mtime 改成 2 天前
    const old = new Date(Date.now() - 2 * 864e5);
    utimesSync(join(outDir, files[0]), old, old);
    const dry = cleanTTL(cfgA, { ttlHours: 24, dryRun: true });
    assert.equal(dry, 1);
    assert.equal(msgFiles(outDir).length, 2, "dry-run 不应删除");
    const removed = cleanTTL(cfgA, { ttlHours: 24 });
    assert.equal(removed, 1);
    assert.equal(msgFiles(outDir).length, 1);
    // removeMessage
    const keepFile = msgFiles(outDir)[0];
    const keepId = JSON.parse(readFileSync(join(outDir, keepFile), "utf-8")).id;
    assert.equal(removeMessage(cfgA, keepId), true);
    assert.equal(msgFiles(outDir).length, 0);
    assert.equal(removeMessage(cfgA, "nope"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("statusOf 统计", () => {
  const { root, cfgA, cfgB } = setup();
  try {
    sendMessage(cfgA, { to: "agent-b", topic: "a" });
    sendMessage(cfgA, { to: "agent-b", topic: "b" });
    const s = statusOf(cfgA);
    assert.equal(s.identity, "agent-a");
    assert.equal(s.outCount, 2);
    assert.equal(s.inboxes.length, 1);
    assert.equal(s.inboxes[0].dir, join(root, "agent-b"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertUsable 缺配置时抛错", () => {
  const { root } = setup();
  try {
    assert.throws(() => assertUsable(resolveConfig({ identity: "" })), /identity/);
    assert.throws(() => assertUsable(resolveConfig({ identity: "x", root: "" })), /root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("默认 root: DSH_HOME/mailbox (不重复拼 .dsh)", () => {
  const cfg = resolveConfig({});
  assert.equal(cfg.root, defaultMailboxRoot());
  assert.match(cfg.root, /\.dsh[\\/]mailbox$/);
  assert.ok(!cfg.root.includes(".dsh" + "/.dsh") && !cfg.root.includes(".dsh\\.dsh"), "不得出现 .dsh/.dsh 双拼");
});
