import test from "node:test";
import assert from "node:assert/strict";
import { parseDirectory } from "../lib/directory-parse.js";
import { renderDirectory } from "../lib/command.js";
import { resolveConfig, touchRegistry } from "../lib/core.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeSession = (id, cwd, title) => ({ id, header: { cwd }, events: title ? [{ type: "session/title", data: { title } }] : [] });

test("parseDirectory: 解析 /mailbox 目录输出", () => {
  const text = [
    "Usage: /mailbox <target|alias|all> <message>   |   /mailbox [list|recv]",
    "",
    "会话目录:",
    "  ●在线 dsh-mailbox-17cbcfa0 (hub)  D:\\Downloads\\Agent\\dsh-mailbox  «发送消息并检查回复»",
    "  ○离线 RP-a4666ed6  D:\\Downloads\\Agent\\RP  «项目评估»",
  ].join("\n");
  const rows = parseDirectory(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "dsh-mailbox-17cbcfa0",
    label: "dsh-mailbox-17cbcfa0 (hub)",
    detail: "●在线  D:\\Downloads\\Agent\\dsh-mailbox  «发送消息并检查回复»",
  });
  assert.equal(rows[1].id, "RP-a4666ed6");
  assert.equal(rows[1].label, "RP-a4666ed6");
  assert.match(rows[1].detail, /○离线/);
});

test("parseDirectory 与 renderDirectory 闭环 (真实格式互通)", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-mailbox-parse-"));
  try {
    const cfg = resolveConfig({ root });
    touchRegistry(cfg, fakeSession("session-aaaa0000-1111", "D:/ws/dsh-mailbox", "联调"));
    const dirText = renderDirectory(resolveConfig({ root, identity: "x" }));
    const rows = parseDirectory(`会话目录:\n${dirText}`);
    assert.ok(rows.some((r) => r.id === "dsh-mailbox-aaaa0000"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
