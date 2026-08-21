import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, setAlias, touchRegistry, recvNew, sendMessage } from "../lib/core.js";
import { parseMailboxCommand, executeMailboxCommand } from "../lib/command.js";

const fakeSession = (id, cwd, title) => ({
  id,
  header: { cwd },
  events: title ? [{ type: "session/title", data: { title } }] : [],
});

const fakeInvocation = (session, rawInput) => ({ agent: { session }, rawInput });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-mailbox-cmd-"));
  const cfg = resolveConfig({ root });
  return { root, cfg };
}

test("parseMailboxCommand 各分支", () => {
  assert.deepEqual(parseMailboxCommand(""), { kind: "usage" });
  assert.deepEqual(parseMailboxCommand("  "), { kind: "usage" });
  assert.deepEqual(parseMailboxCommand("list"), { kind: "list" });
  assert.deepEqual(parseMailboxCommand("LIST"), { kind: "list" });
  assert.deepEqual(parseMailboxCommand("recv"), { kind: "recv" });
  assert.deepEqual(parseMailboxCommand("alpha"), { kind: "no-message", to: "alpha" });
  assert.deepEqual(parseMailboxCommand("alpha 你好"), { kind: "send", to: "alpha", message: "你好" });
  assert.deepEqual(parseMailboxCommand("all 大家好 有空吗"), { kind: "send", to: "all", message: "大家好 有空吗" });
  assert.deepEqual(parseMailboxCommand("alpha  "), { kind: "no-message", to: "alpha" });
});

test("/mailbox 发送 + 对方 recv (含别名路由)", () => {
  const { root, cfg } = setup();
  try {
    const sA = fakeSession("session-aaaa0000-1111", "D:/ws/dsh-mailbox", "联调");
    const sB = fakeSession("session-bbbb0000-2222", "D:/ws/mcp-serial", "");
    touchRegistry(cfg, sA);
    touchRegistry(cfg, sB);
    setAlias(cfg, sB, "beta");

    const result = executeMailboxCommand({}, cfg, fakeInvocation(sA, "beta 你好，收到请回复"));
    assert.equal(result.kind, "success");
    assert.match(result.text, /已发送/);
    assert.match(result.text, /→ mcp-serial-bbbb0000/);
    assert.match(result.text, /目标在线/); // sB 刚登记, lastSeen 在当前窗口内

    const cfgB = resolveConfig({ root, identity: "mcp-serial-bbbb0000" });
    const msgs = recvNew(cfgB);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, "dsh-mailbox-aaaa0000");
    assert.equal(msgs[0].to, "mcp-serial-bbbb0000");
    assert.equal(msgs[0].topic, "message");
    assert.equal(msgs[0].payload.text, "你好，收到请回复");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/mailbox 缺消息 / 用法 / 目录 / recv", () => {
  const { root, cfg } = setup();
  try {
    const sA = fakeSession("session-aaaa0000-1111", "D:/ws/dsh-mailbox", "联调");
    touchRegistry(cfg, sA);

    const usage = executeMailboxCommand({}, cfg, fakeInvocation(sA, ""));
    assert.equal(usage.kind, "success");
    assert.match(usage.text, /会话目录:/); // 裸 /mailbox 不再带 Usage 行, 只做目录发现
    assert.match(usage.text, /dsh-mailbox-aaaa0000/);

    const list = executeMailboxCommand({}, cfg, fakeInvocation(sA, "list"));
    assert.match(list.text, /dsh-mailbox-aaaa0000/);

    const noMsg = executeMailboxCommand({}, cfg, fakeInvocation(sA, "somebody"));
    assert.equal(noMsg.kind, "error");
    assert.match(noMsg.text, /缺少消息内容/);

    // recv: 先由对方发来一条
    const cfgB = resolveConfig({ root, identity: "mcp-serial-bbbb0000" });
    sendMessage(cfgB, { to: "dsh-mailbox-aaaa0000", type: "notify", topic: "message", payload: { text: "回你" } });
    const recv = executeMailboxCommand({}, cfg, fakeInvocation(sA, "recv"));
    assert.equal(recv.kind, "success");
    assert.match(recv.text, /新消息 1 条/);
    assert.match(recv.text, /回你/);
    const recv2 = executeMailboxCommand({}, cfg, fakeInvocation(sA, "recv"));
    assert.match(recv2.text, /无新消息/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/mailbox all 广播", () => {
  const { root, cfg } = setup();
  try {
    const sA = fakeSession("session-aaaa0000-1111", "D:/ws/dsh-mailbox", "联调");
    const r = executeMailboxCommand({}, cfg, fakeInvocation(sA, "all 大家好"));
    assert.equal(r.kind, "success");
    const msgs = recvNew(resolveConfig({ root, identity: "mcp-serial-bbbb0000" }));
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].to, "all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/mailbox 未知目标: 失败即地址簿 (附会话目录)", () => {
  const { root, cfg } = setup();
  try {
    const sA = fakeSession("session-aaaa0000-1111", "D:/ws/dsh-mailbox", "联调");
    touchRegistry(cfg, sA);
    setAlias(cfg, sA, "hub");
    const r = executeMailboxCommand({}, cfg, fakeInvocation(sA, "dsh 你好"));
    assert.equal(r.kind, "success");
    assert.match(r.text, /"dsh" 未登记/);
    assert.match(r.text, /dsh-mailbox-aaaa0000/, "提示里应列出已登记会话 (含自己)");
    assert.match(r.text, /hub/, "提示里应含别名");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
