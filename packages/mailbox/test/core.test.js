import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
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
  loadSeen,
  markSeen,
  sendAck,
  hasAck,
  latestReplyStatus,
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

test("seen 目录化: 多写者并发标记不互覆盖", () => {
  const { root } = setup();
  try {
    const cfgB = resolveConfig({ identity: "agent-b", root });
    // 两个独立写者 (模拟两个进程/主机) 各自标记不同消息, 目录化下互不覆盖
    markSeen(cfgB, "probe-A");
    markSeen(cfgB, "probe-B");
    // 旧单文件方案下第二次 save 会覆盖第一次, 丢掉 probe-A
    const all = loadSeen(cfgB).sort();
    assert.deepEqual(all, ["probe-A", "probe-B"], "目录化 seen 各方标记互不覆盖");
    // 变体: 走 recvNew 真实消息, 去重仍然正确
    mkdirSync(join(root, "who-c"));
    const pc = resolveConfig({ identity: "who-c", root });
    sendMessage(pc, { to: "agent-b", topic: "real" });
    assert.equal(recvNew(cfgB).length, 1);
    assert.equal(recvNew(cfgB).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("seen 迁移: 旧 .seen.json 自动迁移到目录化并删除旧文件", () => {
  const { root, cfgA, cfgB } = setup();
  try {
    const legacy = join(root, "agent-b", ".seen.json");
    writeFileSync(legacy, JSON.stringify(["old-1", "old-2"]), "utf-8");
    // recv 触发 loadSeen → 迁移
    recvNew(cfgB);
    assert.equal(existsSync(legacy), false, "旧单文件应被迁移删除");
    for (const id of ["old-1", "old-2"]) {
      assert.equal(existsSync(join(root, "agent-b", ".seen", `${id}.seen`)), true, `标记 ${id}.seen 应生成`);
    }
    const migrated = loadSeen(cfgB).sort();
    assert.deepEqual(migrated, ["old-1", "old-2"]);
    // 迁移后新增 recv 也应正常去重
    sendMessage(cfgA, { to: "agent-b", topic: "after" });
    assert.equal(recvNew(cfgB).length, 1);
    assert.equal(recvNew(cfgB).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("回执协议: request → delivered → done, 发送方可查生命周期 (幂等防重)", () => {
  const { root, cfgA, cfgB } = setup();
  try {
    // A 发 request 给 B
    const rid = sendMessage(cfgA, { to: "agent-b", type: "request", topic: "对齐", payload: { job: "x" } });
    // B recv 消费 → 回执 delivered (消费层自动调用, 此处直接测 sendAck 语义)
    const msgs = recvNew(cfgB);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].type, "request");
    assert.equal(sendAck(cfgB, msgs[0], "delivered"), true, "首次回执应写入");
    assert.equal(sendAck(cfgB, msgs[0], "delivered"), false, "同状态幂等: 不重复回执");
    // A 查生命周期: delivered
    let st = latestReplyStatus(cfgA, rid, "agent-b");
    assert.ok(st, "A 应能读到回执");
    assert.equal(st.status, "delivered");
    assert.equal(st.from, "agent-b");
    assert.equal(st.payload.requestId, rid);
    // B 处理完回 done (带详情)
    assert.equal(sendAck(cfgB, msgs[0], "done", { detail: "已对齐" }), true);
    st = latestReplyStatus(cfgA, rid);
    assert.equal(st.status, "done");
    assert.equal(st.payload.detail, "已对齐");
    // 回执不写给自己
    assert.equal(sendAck(cfgA, msgs[0], "done"), false, "from===自己 不回执");
    // hasAck
    assert.equal(hasAck(cfgB, rid, "delivered"), true);
    assert.equal(hasAck(cfgB, rid, "done"), true);
    assert.equal(hasAck(cfgB, rid, "error"), false);
    // 未知 requestId 查不到
    assert.equal(latestReplyStatus(cfgA, rid + "-nope"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertUsable 缺 identity 时抛错; 空 root 回退默认值不抛错", () => {
  const { root } = setup();
  try {
    assert.throws(() => assertUsable(resolveConfig({ identity: "" })), /identity/);
    assert.doesNotThrow(() => assertUsable(resolveConfig({ identity: "x", root: "" })));
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
