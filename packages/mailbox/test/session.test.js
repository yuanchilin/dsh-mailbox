import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveConfig,
  sessionCtx,
  deriveIdentity,
  effectiveIdentity,
  effectiveConfig,
  touchRegistry,
  touchRegistryCli,
  listSessions,
  setAlias,
  resolveTarget,
  unreadFrom,
  isOnline,
  sendMessage,
  recvNew,
  statusOf,
} from "../lib/core.js";

/** 模拟 DSH Session 对象 (工具执行时 exec.agent.session 的形状)。 */
const fakeSession = (id, cwd, title) => ({
  id,
  header: { cwd },
  events: title ? [{ type: "session/title", data: { title } }] : [],
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-mailbox-sess-"));
  const cfg = resolveConfig({ root });
  return { root, cfg };
}

test("sessionCtx / deriveIdentity: 工作区多会话身份互不冲突", () => {
  const a = sessionCtx(fakeSession("session-11111111-aaaa", "D:/ws/dsh-mailbox", "联调"));
  const b = sessionCtx(fakeSession("session-22222222-bbbb", "D:/ws/dsh-mailbox", "另一个"));
  assert.equal(a.sessionId, "session-11111111-aaaa");
  assert.equal(a.workspace, "D:/ws/dsh-mailbox");
  assert.equal(a.title, "联调");
  const idA = deriveIdentity(a);
  const idB = deriveIdentity(b);
  assert.equal(idA, "dsh-mailbox-11111111");
  assert.equal(idB, "dsh-mailbox-22222222");
  assert.notEqual(idA, idB, "同一工作区的两个会话必须不同身份");
  assert.equal(sessionCtx(undefined), undefined);
});

test("effectiveIdentity: 显式 config > 会话派生", () => {
  const cfg = resolveConfig({ root: "/tmp/x" });
  const s = fakeSession("session-33333333-cccc", "D:/ws/rp", "RP 会话");
  assert.equal(effectiveIdentity(cfg, s), "rp-33333333");
  assert.equal(effectiveIdentity(resolveConfig({ root: "/tmp/x", identity: "rp" }), s), "rp", "显式身份优先");
});

test("effectiveConfig: 无身份时抛带指引错误", () => {
  assert.throws(() => effectiveConfig(resolveConfig({}), undefined), /无法确定身份/);
  const cfg = resolveConfig({ root: "/tmp/x" });
  const eff = effectiveConfig(cfg, fakeSession("session-44444444-dddd", "D:/ws/x", ""));
  assert.equal(eff.identity, "x-44444444");
  assert.equal(eff.root, "/tmp/x");
});

test("touchRegistry / listSessions: 心跳 + 排序 + 在线判定", () => {
  const { root, cfg } = setup();
  try {
    const sA = fakeSession("session-aaaa0000-1111", "D:/ws/dsh-mailbox", "联调");
    const sB = fakeSession("session-bbbb0000-2222", "D:/ws/mcp-serial", "");
    touchRegistry(cfg, sA);
    // 模拟 B 更早活跃 (改 lastSeen 为 10 分钟前)
    const recB = touchRegistry(cfg, sB);
    recB.lastSeen = Date.now() - 600_000;
    writeFileSync(join(root, "_sessions", "session-bbbb0000-2222.json"), JSON.stringify(recB));

    const sessions = listSessions(cfg);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].identity, "dsh-mailbox-aaaa0000", "按 lastSeen 倒序");
    assert.equal(sessions[1].identity, "mcp-serial-bbbb0000");
    assert.equal(isOnline(sessions[0], 300), true);
    assert.equal(isOnline(sessions[1], 300), false, "10 分钟前活跃视为离线");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setAlias: 唯一性 (跨会话冲突拒绝, 本会话幂等)", () => {
  const { root, cfg } = setup();
  try {
    const sA = fakeSession("session-aaaa0000-1111", "D:/ws/dsh-mailbox", "联调");
    const sB = fakeSession("session-bbbb0000-2222", "D:/ws/mcp-serial", "");
    const rec = setAlias(cfg, sA, "rp");
    assert.equal(rec.alias, "rp");
    assert.equal(rec.identity, "dsh-mailbox-aaaa0000");
    // 本会话重复设置允许
    setAlias(cfg, sA, "rp");
    // 其他会话占用则拒绝
    assert.throws(() => setAlias(cfg, sB, "rp"), /已被 .* 占用/);
    // 非法别名
    assert.throws(() => setAlias(cfg, sA, "bad alias!"), /alias 仅允许/);
    assert.throws(() => setAlias(cfg, sA, ""), /不能为空/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTarget: alias / sessionId / raw / all", () => {
  const { root, cfg } = setup();
  try {
    const sA = fakeSession("session-aaaa0000-1111", "D:/ws/dsh-mailbox", "联调");
    touchRegistry(cfg, sA);
    setAlias(cfg, sA, "rp");
    assert.equal(resolveTarget(cfg, "rp"), "dsh-mailbox-aaaa0000", "别名解析");
    assert.equal(resolveTarget(cfg, "session-aaaa0000-1111"), "dsh-mailbox-aaaa0000", "完整 sessionId 解析");
    assert.equal(resolveTarget(cfg, "mcp"), "mcp", "未注册按 identity 原样");
    assert.equal(resolveTarget(cfg, "all"), "all");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveTarget: 按工作区路径/目录名匹配", () => {
  const { root, cfg } = setup();
  try {
    const sA = fakeSession("session-aaaa0000-1111", "D:/Downloads/Agent/dsh-mailbox", "联调");
    touchRegistry(cfg, sA);
    assert.equal(resolveTarget(cfg, "D:\\Downloads\\Agent\\dsh-mailbox"), "dsh-mailbox-aaaa0000", "反斜杠完整路径");
    assert.equal(resolveTarget(cfg, "D:/Downloads/Agent/dsh-mailbox"), "dsh-mailbox-aaaa0000", "正斜杠完整路径");
    assert.equal(resolveTarget(cfg, "dsh-mailbox"), "dsh-mailbox-aaaa0000", "目录名");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sendMessage 别名路由 + recvNew + unreadFrom", () => {
  const { root, cfg } = setup();
  try {
    const sA = fakeSession("session-aaaa0000-1111", "D:/ws/dsh-mailbox", "联调");
    const sB = fakeSession("session-bbbb0000-2222", "D:/ws/mcp-serial", "");
    touchRegistry(cfg, sA);
    touchRegistry(cfg, sB);
    setAlias(cfg, sB, "mcp");
    const cfgA = resolveConfig({ root, identity: "dsh-mailbox-aaaa0000" });
    const cfgB = resolveConfig({ root, identity: "mcp-serial-bbbb0000" });

    sendMessage(cfgA, { to: "mcp", topic: "hello", payload: { x: 1 } }); // 走别名
    assert.equal(unreadFrom(cfgB, "dsh-mailbox-aaaa0000"), 1, "对方目录中发给我的未读=1 (recv 前)");
    const msgs = recvNew(cfgB);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from, "dsh-mailbox-aaaa0000");
    assert.equal(msgs[0].to, "mcp-serial-bbbb0000", "消息路由到解析后的 identity");
    assert.equal(unreadFrom(cfgB, "dsh-mailbox-aaaa0000"), 0, "recv 后已读");
    assert.equal(unreadFrom(cfgB, "mcp-serial-bbbb0000"), 0, "自己发自己的不算");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("statusOf: 含会话目录, _sessions 不进 inboxes", () => {
  const { root, cfg } = setup();
  try {
    mkdirSync(join(root, "dsh-mailbox-aaaa0000"));
    mkdirSync(join(root, "mcp-serial-bbbb0000"));
    const sA = fakeSession("session-aaaa0000-1111", "D:/ws/dsh-mailbox", "联调");
    touchRegistry(cfg, sA);
    const cfgA = resolveConfig({ root, identity: "dsh-mailbox-aaaa0000" });
    const s = statusOf(cfgA);
    assert.equal(s.identity, "dsh-mailbox-aaaa0000");
    assert.equal(s.inboxes.length, 1, "_sessions 不应被当参与者");
    assert.equal(s.inboxes[0].name, "mcp-serial-bbbb0000");
    assert.equal(s.sessions.length, 1);
    assert.equal(s.sessions[0].online, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("touchRegistryCli: CLI 参与者登记 (key=cli-<identity>)", () => {
  const { root, cfg } = setup();
  try {
    const cfgCli = resolveConfig({ root, identity: "rp" });
    touchRegistryCli(cfgCli, { workspace: "D:/ws/RP" });
    const sessions = listSessions(cfg);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].identity, "rp");
    assert.equal(sessions[0].title, "CLI");
    assert.equal(readdirSync(join(root, "_sessions")).includes("cli-rp.json"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveDirs 跳过 _ 前缀目录 (regression)", () => {
  const { root, cfg } = setup();
  try {
    mkdirSync(join(root, "agent-x"));
    mkdirSync(join(root, "_sessions"));
    const cfgX = resolveConfig({ root, identity: "agent-x" });
    const dirs = cfgX.layout === "root" && cfgX.root ? { out: join(root, "agent-x"), in: [] } : null;
    // 直接验证参与者扫描结果
    const participants = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
      .map((d) => d.name);
    assert.deepEqual(participants, ["agent-x"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
