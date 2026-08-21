// 最小类型声明 (core / command / watcher / directory-parse 导出的形状)
export interface MailboxConfig {
  identity: string;
  layout: "root" | "dirs";
  root: string;
  dirs: Record<string, string>;
  participants: string[];
  intervalSec: number;
  timeoutSec: number;
  seenFile: string;
  patchRoot: string;
  presenceWindowSec: number;
  watcher: boolean;
}

export interface MailboxMessage {
  id: string;
  from: string;
  to: string;
  type: "request" | "response" | "notify" | "reply";
  topic: string;
  payload: unknown;
  ts: number;
  reply_to: string;
}

export interface MailboxInbox {
  dir: string;
  name: string;
  msgCount: number;
  unread: number;
}

export interface MailboxSession {
  sessionId: string;
  identity: string;
  alias: string;
  workspace: string;
  title: string;
  firstSeen: number;
  lastSeen: number;
  online?: boolean;
  unread?: number;
}

export interface MailboxStatus {
  identity: string;
  layout: string;
  outDir: string;
  outCount: number;
  seen: number;
  inboxes: MailboxInbox[];
  sessions: MailboxSession[];
}

/** DSH Session 对象的最小形状 (工具执行时 exec.agent.session)。 */
export interface DshSessionLike {
  id: string;
  header?: { cwd?: string };
  events?: Array<{ type?: string; data?: { title?: string } }>;
}

export function resolveConfig(partial?: Partial<MailboxConfig>, env?: NodeJS.ProcessEnv): MailboxConfig;
export function resolveDirs(cfg: MailboxConfig): { out: string; in: string[] };
export function seenFileOf(cfg: MailboxConfig): string;
export function loadSeen(cfg: MailboxConfig): string[];
export function saveSeen(cfg: MailboxConfig, seen: string[]): void;
export function markSeen(cfg: MailboxConfig, id: string): void;
export function isSeen(cfg: MailboxConfig, id: string): boolean;

// ---- 回执协议 (ack) ----
export const ACK_TOPIC: "status";
export function hasAck(cfg: MailboxConfig, requestId: string, status: string): boolean;
export function sendAck(cfg: MailboxConfig, request: MailboxMessage, status: string, extra?: Record<string, unknown>): boolean;
export interface MailboxReplyStatus { ts: number; status: string; id: string; from: string; payload?: Record<string, unknown>; }
export function latestReplyStatus(cfg: MailboxConfig, requestId: string, expectFrom?: string): MailboxReplyStatus | null;
export function sendMessage(cfg: MailboxConfig, msg: Partial<Pick<MailboxMessage, "to" | "type" | "topic" | "payload" | "reply_to">>): string;
export function recvNew(cfg: MailboxConfig, mark?: boolean): MailboxMessage[];
export function removeMessage(cfg: MailboxConfig, id: string, inbox?: boolean): boolean;
export function cleanTTL(cfg: MailboxConfig, opts?: { ttlHours?: number; dryRun?: boolean }): number;
export function statusOf(cfg: MailboxConfig): MailboxStatus;
export function assertUsable(cfg: MailboxConfig): void;

// ---- 会话身份 + 注册表 ----
export function sessionCtx(session?: DshSessionLike | null): { sessionId: string; workspace: string; title: string } | undefined;
export function deriveIdentity(ctx?: { sessionId: string; workspace: string; title: string }): string;
export function effectiveIdentity(cfg: MailboxConfig, session?: DshSessionLike | null): string;
export function effectiveConfig(cfg: MailboxConfig, session?: DshSessionLike | null): MailboxConfig;
export function registryDir(cfg: MailboxConfig): string;
export function touchRegistry(cfg: MailboxConfig, session?: DshSessionLike | null, opts?: { alias?: string }): MailboxSession | undefined;
export function touchRegistryCli(cfg: MailboxConfig, opts?: { workspace?: string }): MailboxSession | undefined;
export function listSessions(cfg: MailboxConfig): MailboxSession[];
export function isOnline(rec?: MailboxSession | null, windowSec?: number): boolean;
export function setAlias(cfg: MailboxConfig, session: DshSessionLike, alias: string): MailboxSession;
export function resolveTarget(cfg: MailboxConfig, to: string): string;
export function isKnownTarget(cfg: MailboxConfig, target: string): boolean;
export function sessionDirectoryText(cfg: MailboxConfig): string;
export function unknownTargetHint(cfg: MailboxConfig, target: string): string;
export function unreadInDir(cfg: MailboxConfig, dir: string): number;
export function unreadFrom(cfg: MailboxConfig, identity: string): number;

// ---- 宿主 /mailbox 命令 ----
export interface MailboxCommandResult {
  kind: "success" | "error";
  text: string;
}
export interface MailboxInvocation {
  agent?: { session?: DshSessionLike };
  rawInput: string;
}
export const MAILBOX_USAGE: string;
export function parseMailboxCommand(rawInput: string):
  | { kind: "usage" }
  | { kind: "list" }
  | { kind: "recv" }
  | { kind: "no-message"; to: string }
  | { kind: "send"; to: string; message: string };
export function renderDirectory(cfg: MailboxConfig): string;
export function executeMailboxCommand(ctx: unknown, cfg: MailboxConfig, invocation: MailboxInvocation): MailboxCommandResult;
export function registerMailboxCommand(ctx: { commands: { register(definition: unknown): unknown } }, cfg: MailboxConfig): void;

// ---- 内建 watcher ----
export function scanMailboxRoot(root: string, known: Set<string>, live: Map<string, unknown>): Map<string, MailboxMessage[]>;
export function startMailboxWatcher(ctx: unknown, cfg: MailboxConfig): (() => void) | undefined;

// ---- 目录文本解析 (客户端补全) ----
export interface DirectoryOption {
  id: string;
  label: string;
  detail: string;
}
export function parseDirectory(text: string): DirectoryOption[];
