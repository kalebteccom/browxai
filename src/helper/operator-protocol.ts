// Wire rules for the operator channel: the environment halves, the permission
// check on the socket the daemon passes in, the handshake proofs and the
// validation of an answer frame. Pure and synchronous apart from `lstat`, so each
// rule is unit-testable without a socket. The connection lifecycle lives in
// `operator-channel.ts`.
//
// Nothing here returns or logs the socket path or the token. A problem is
// described by what is wrong, never by the value that was wrong.

import { createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, type Stats } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { ConfirmHook } from "../util/capabilities.js";

export const OPERATOR_PROTOCOL_VERSION = 1;

/** A frame longer than this drops the connection. */
export const MAX_FRAME_BYTES = 64 * 1024;

/** Upper bound on one grant, the same cap `approve_actions` has. */
export const MAX_GRANT_TTL_SECONDS = 24 * 60 * 60;

/** Shortest token browxai accepts. 128 random bits as hex is 32 characters. */
export const MIN_TOKEN_LENGTH = 16;

/** The widest a grant can reach. A browxai process serves one workspace, so
 *  `workspace` is every session of this process, and nothing is wider. */
export type OperatorGrantScope = "session" | "workspace";

export type OperatorDecision = "approve" | "deny" | "done" | "abort";

export interface OperatorGrant {
  scope: OperatorGrantScope;
  ttlSeconds: number;
}

export type HumanKind = "acknowledge" | "confirm" | "choose" | "input";

// ---------- environment ----------

export interface OperatorEnv {
  socketPath?: string;
  token?: string;
}

/** Read the channel's two environment variables and remove them from `env`.
 *  The values are operator-set start-time secrets: removing them keeps them out
 *  of every process browxai spawns later (the browser, credential CLIs). */
export function takeOperatorEnv(env: NodeJS.ProcessEnv = process.env): OperatorEnv {
  const socketPath = env.BROWX_OPERATOR_SOCKET?.trim() || undefined;
  const token = env.BROWX_OPERATOR_TOKEN?.trim() || undefined;
  delete env.BROWX_OPERATOR_SOCKET;
  delete env.BROWX_OPERATOR_TOKEN;
  return { socketPath, token };
}

// ---------- socket permissions ----------

export type SocketCheck =
  | { state: "ok" }
  /** The socket or its directory has not been created yet. The daemon may still be starting. */
  | { state: "missing" }
  | { state: "unsafe"; reason: string };

function modeOf(st: Stats): number {
  return st.mode & 0o777;
}

/** Check the daemon's socket the way the daemon is expected to have made it: a
 *  real socket, mode 0600, in a real directory (not a symlink) at mode 0700,
 *  both owned by the user running browxai. Run at start and on every redial. */
export function checkOperatorSocket(socketPath: string): SocketCheck {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return { state: "unsafe", reason: "the operator channel needs a POSIX host" };
  }
  if (!isAbsolute(socketPath)) {
    return { state: "unsafe", reason: "the socket path must be absolute" };
  }
  let dir: Stats;
  try {
    dir = lstatSync(dirname(socketPath));
  } catch (e) {
    // A directory that is not there yet (or is being recreated by a restarting
    // daemon) is not a permission problem.
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "unsafe", reason: "the socket directory is unreadable" };
  }
  if (!dir.isDirectory()) {
    return { state: "unsafe", reason: "the socket directory is not a plain directory" };
  }
  if (dir.uid !== uid) {
    return { state: "unsafe", reason: "the socket directory is owned by another user" };
  }
  if (modeOf(dir) !== 0o700) {
    return { state: "unsafe", reason: "the socket directory is not mode 0700" };
  }
  let sock: Stats;
  try {
    sock = lstatSync(socketPath);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "unsafe", reason: "the socket is unreadable" };
  }
  if (!sock.isSocket()) return { state: "unsafe", reason: "the socket path is not a socket" };
  if (sock.uid !== uid) return { state: "unsafe", reason: "the socket is owned by another user" };
  if (modeOf(sock) !== 0o600) return { state: "unsafe", reason: "the socket is not mode 0600" };
  return { state: "ok" };
}

// ---------- handshake proofs ----------

export type ProofRole = "daemon" | "browxai";

/** HMAC-SHA-256 over both nonces, keyed by the token. The token itself never
 *  crosses the socket, so a process that took over the socket path learns
 *  nothing it can reuse. The role is in the message so one side's proof cannot
 *  be replayed as the other's. */
export function handshakeProof(
  token: string,
  role: ProofRole,
  helloNonce: string,
  daemonNonce: string,
): string {
  return createHmac("sha256", token)
    .update(`browxai-operator/${OPERATOR_PROTOCOL_VERSION}\n${role}\n${helloNonce}\n${daemonNonce}`)
    .digest("hex");
}

/** Constant-time comparison of a presented proof against the expected one. */
export function proofMatches(expectedHex: string, presented: unknown): boolean {
  // Exactly 64 lowercase hex digits, nothing for `Buffer.from` to truncate or
  // quietly skip.
  if (typeof presented !== "string" || !/^[0-9a-f]{64}$/.test(presented)) return false;
  const a = Buffer.from(expectedHex, "hex");
  const b = Buffer.from(presented, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------- answers ----------

/** What the daemon may say about one request, as the request's own shape
 *  allows it. */
export interface AnswerRules {
  answers: readonly OperatorDecision[];
  humanKind?: HumanKind;
  choiceCount?: number;
  /** The confirm scope a grant may extend. Absent when the request cannot carry one. */
  grantable?: ConfirmHook;
}

export type AnswerCheck =
  | { ok: true; decision: OperatorDecision; value?: unknown; grant?: OperatorGrant }
  | { ok: false; code: "invalid-answer" | "grant-not-allowed" };

const MAX_INPUT_CHARS = 10_000;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkValue(
  decision: OperatorDecision,
  rules: AnswerRules,
  value: unknown,
): { ok: true; value?: unknown } | { ok: false } {
  if (decision !== "done" || !rules.humanKind || rules.humanKind === "acknowledge") {
    return value === undefined ? { ok: true } : { ok: false };
  }
  if (rules.humanKind === "confirm") {
    return typeof value === "boolean" ? { ok: true, value } : { ok: false };
  }
  if (rules.humanKind === "choose") {
    const n = rules.choiceCount ?? 0;
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < n
      ? { ok: true, value }
      : { ok: false };
  }
  return typeof value === "string" && value.length <= MAX_INPUT_CHARS
    ? { ok: true, value }
    : { ok: false };
}

function checkGrant(
  rules: AnswerRules,
  raw: unknown,
):
  { ok: true; grant: OperatorGrant } | { ok: false; code: "invalid-answer" | "grant-not-allowed" } {
  if (!rules.grantable) return { ok: false, code: "grant-not-allowed" };
  if (!isObject(raw)) return { ok: false, code: "invalid-answer" };
  const { scope, ttlSeconds } = raw;
  // `global` and every other spelling are refused here: a grant is session or
  // workspace scoped and nothing wider exists.
  if (scope !== "session" && scope !== "workspace") return { ok: false, code: "invalid-answer" };
  if (
    typeof ttlSeconds !== "number" ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > MAX_GRANT_TTL_SECONDS
  ) {
    return { ok: false, code: "invalid-answer" };
  }
  return { ok: true, grant: { scope, ttlSeconds } };
}

/** Validate one `answer` frame against the request it names. A grant rides only
 *  on an `approve` of a request that declared a grantable scope. Anything else
 *  is rejected whole, leaving the request pending. */
export function checkAnswer(rules: AnswerRules, frame: Record<string, unknown>): AnswerCheck {
  const { decision } = frame;
  if (
    decision !== "approve" &&
    decision !== "deny" &&
    decision !== "done" &&
    decision !== "abort"
  ) {
    return { ok: false, code: "invalid-answer" };
  }
  if (!rules.answers.includes(decision)) return { ok: false, code: "invalid-answer" };
  const value = checkValue(decision, rules, frame.value);
  if (!value.ok) return { ok: false, code: "invalid-answer" };
  if (frame.grant === undefined) return { ok: true, decision, value: value.value };
  if (decision !== "approve") return { ok: false, code: "grant-not-allowed" };
  const grant = checkGrant(rules, frame.grant);
  if (!grant.ok) return grant;
  return { ok: true, decision, value: value.value, grant: grant.grant };
}
