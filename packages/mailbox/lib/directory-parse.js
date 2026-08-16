// ============================================================================
//  @yuanchilin/dsh-mailbox — 会话目录文本解析 (客户端补全用)
//
//  /mailbox 命令的裸执行输出 (renderDirectory) 是稳定格式:
//     Usage: ...
//
//     会话目录:
//       ●在线 dsh-mailbox-17cbcfa0 (hub)  D:\Downloads\Agent\dsh-mailbox  «标题»
//       ○离线 RP-a4666ed6  D:\Downloads\Agent\RP  «标题»
//
//  解析出 (identity, alias, workspace, title, online) 供 popupSelect 选项使用。
//  纯函数、零依赖, 可在 node 下单元测试, 客户端 bundle 直接内联。
// ============================================================================

const DIRECTORY_LINE = /^\s{2}([●○])(在线|离线)\s+(\S+)(?:\s+\(([^()]*)\))?\s+(.*)$/;

/**
 * 从 /mailbox 目录输出文本解析会话行。
 * @returns { id, label, detail }[] (popupSelect SelectOption 形状)
 */
export function parseDirectory(text) {
  const rows = [];
  if (typeof text !== "string") return rows;
  for (const raw of text.split(/\r?\n/)) {
    const m = DIRECTORY_LINE.exec(raw);
    if (!m) continue;
    const identity = m[3];
    const alias = m[4] ?? "";
    const rest = (m[5] ?? "").trim();
    rows.push({
      id: identity,
      label: alias ? `${identity} (${alias})` : identity,
      detail: `${m[1] === "●" ? "●在线" : "○离线"}  ${rest || "?"}`,
    });
  }
  return rows;
}
