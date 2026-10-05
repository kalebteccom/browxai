// The operator channel: a single connection from browxai to a Unix socket the
// host daemon listens on. Every confirm-hook request, permission and
// notification `ask-human` prompt and `await_human` is sent there, and the
// daemon's answer is the only one accepted while the channel is on.
//
// Who can reach what:
//   - The socket path and the token come from the operator's environment, are
//     read once at start and removed from `process.env`. Both live in `#private`
//     fields. No log line, error, or tool result carries either.
//   - The agent (MCP tools) and page scripts have no handle on this object. A
//     tool can reach a request only through `BrowxBridge.awaitSignal`, which
//     asks and waits; nothing here lets a caller answer.
//   - The daemon proves it knows the token (HMAC over two nonces, compared in
//     constant time) before browxai sends a request, and browxai proves the
//     same back. The token never crosses the socket.
//
// Failure is closed. A request with no answer is denied at its own timeout,
// whether the daemon is slow, gone, or never connected. Nothing here approves
// on its own, and a dropped connection never falls back to DevTools.

import { createConnection, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { log } from "../util/logging.js";
import { PACKAGE_VERSION } from "../util/version.js";
import { capabilityMissing, type CapabilityConfig } from "../util/capabilities.js";
import {
  CLASS_LIMIT,
  MAX_PENDING,
  SESSION_LIMIT,
  classOf,
  dedupeKey,
  requestFrame,
  type OperatorAsk,
  type PromptClass,
} from "./operator-frames.js";
import {
  MAX_FRAME_BYTES,
  MIN_TOKEN_LENGTH,
  OPERATOR_PROTOCOL_VERSION,
  checkAnswer,
  checkOperatorSocket,
  handshakeProof,
  proofMatches,
  takeOperatorEnv,
  type AnswerRules,
  type OperatorDecision,
  type OperatorGrant,
} from "./operator-protocol.js";

export type { OperatorDecision, OperatorGrant, HumanKind } from "./operator-protocol.js";
export type { OperatorPrompt, OperatorAsk } from "./operator-frames.js";

export interface OperatorAnswer {
  decision: OperatorDecision;
  value?: unknown;
  grant?: OperatorGrant;
}

/** The seam the bridge routes through. `ask` rejects on timeout (message ends
 *  `timed out after <n>ms`), on cancel and when the channel is closed. */
export interface OperatorChannel {
  ask(req: OperatorAsk, signal?: AbortSignal): Promise<OperatorAnswer>;
  close(): void;
}

type State = "down" | "hello" | "auth" | "ready" | "closed";
type Outcome = "approved" | "denied" | "done" | "aborted" | "timeout";

interface Pending {
  id: string;
  cls: PromptClass;
  session: string;
  frame: Record<string, unknown>;
  rules: AnswerRules;
  timer: NodeJS.Timeout;
  settle: (r: { answer: OperatorAnswer } | { error: Error }) => void;
}

const HANDSHAKE_TIMEOUT_MS = 5_000;
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 5_000;

const OUTCOME: Record<OperatorDecision, Outcome> = {
  approve: "approved",
  deny: "denied",
  done: "done",
  abort: "aborted",
};

class OperatorLink implements OperatorChannel {
  readonly #path: string;
  readonly #token: string;
  #state: State = "down";
  #sock: Socket | null = null;
  #buf = "";
  #helloNonce = "";
  #daemonNonce = "";
  #retry: NodeJS.Timeout | null = null;
  #handshake: NodeJS.Timeout | null = null;
  #backoff = BACKOFF_START_MS;
  #lastUnsafe = "";
  readonly #pending = new Map<string, Pending>();
  readonly #pageAsks = new Map<string, Promise<OperatorAnswer>>();

  constructor(path: string, token: string) {
    this.#path = path;
    this.#token = token;
  }

  start(): void {
    this.#connect();
  }

  ask(req: OperatorAsk, signal?: AbortSignal): Promise<OperatorAnswer> {
    if (this.#state === "closed") {
      return Promise.reject(new Error("operator-channel: the channel is closed"));
    }
    const id = `req_${randomBytes(16).toString("hex")}`;
    const { frame, rules } = requestFrame(id, req, Date.now());
    if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME_BYTES) {
      return Promise.reject(new Error("operator-channel: the request is too large to send"));
    }
    const cls = classOf(req.prompt);
    const key = dedupeKey(cls, frame);
    const same = key === null ? undefined : this.#pageAsks.get(key);
    if (same) return this.#join(same, signal);
    if (!this.#hasRoom(cls, String(frame.session))) {
      return Promise.reject(new Error("operator-channel: too many requests are waiting"));
    }
    const answer = this.#enqueue(id, cls, frame, rules, req, signal);
    if (key !== null) {
      this.#pageAsks.set(key, answer);
      const drop = (): void => void this.#pageAsks.delete(key);
      answer.then(drop, drop);
    }
    return answer;
  }

  /** Room under the total cap, the class share and the per-session limit. */
  #hasRoom(cls: PromptClass, session: string): boolean {
    let total = 0;
    let inClass = 0;
    let inSession = 0;
    for (const p of this.#pending.values()) {
      total++;
      if (p.cls !== cls) continue;
      inClass++;
      if (p.session === session) inSession++;
    }
    return total < MAX_PENDING && inClass < CLASS_LIMIT[cls] && inSession < SESSION_LIMIT[cls];
  }

  /** A repeat of a page prompt already out waits on the same answer. */
  #join(first: Promise<OperatorAnswer>, signal?: AbortSignal): Promise<OperatorAnswer> {
    return new Promise<OperatorAnswer>((resolve, reject) => {
      const onAbort = (): void => reject(new Error("bridge detached"));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      first.then(
        (a) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(a);
        },
        (e: Error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  #enqueue(
    id: string,
    cls: PromptClass,
    frame: Record<string, unknown>,
    rules: AnswerRules,
    req: OperatorAsk,
    signal?: AbortSignal,
  ): Promise<OperatorAnswer> {
    return new Promise<OperatorAnswer>((resolve, reject) => {
      let done = false;
      const settle = (r: { answer: OperatorAnswer } | { error: Error }): void => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        this.#pending.delete(id);
        if ("answer" in r) resolve(r.answer);
        else reject(r.error);
      };
      const finish = (outcome: Outcome, by: string, error: Error): void => {
        this.#send({ type: "resolved", id, outcome, by });
        settle({ error });
      };
      const onAbort = (): void => finish("aborted", "browxai", new Error("bridge detached"));
      const timer = setTimeout(
        () =>
          finish(
            "timeout",
            "timeout",
            new Error(`awaitHuman timed out after ${req.timeoutMs}ms (no operator answer)`),
          ),
        req.timeoutMs,
      );
      this.#pending.set(id, {
        id,
        cls,
        session: String(frame.session),
        frame,
        rules,
        timer,
        settle,
      });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (this.#state === "ready") this.#send(frame);
    });
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#clearTimers();
    this.#sock?.destroy();
    this.#sock = null;
    for (const p of [...this.#pending.values()]) {
      p.settle({ error: new Error("operator-channel: the channel is closed") });
    }
  }

  // ---------- connection ----------

  #connect(): void {
    if (this.#state === "closed") return;
    const check = checkOperatorSocket(this.#path);
    if (check.state === "unsafe") {
      // The directory or socket is not what the daemon is expected to make. Do
      // not connect to it. Pending requests keep waiting and are denied at their
      // timeouts, and a later retry connects once the daemon has made it right.
      if (this.#lastUnsafe !== check.reason) {
        log.error(`browxai: operator channel is not connecting: ${check.reason}`);
        this.#lastUnsafe = check.reason;
      }
      return this.#scheduleRetry();
    }
    this.#lastUnsafe = "";
    if (check.state === "missing") return this.#scheduleRetry();
    const sock = createConnection(this.#path);
    sock.setEncoding("utf8");
    this.#sock = sock;
    this.#state = "hello";
    this.#buf = "";
    this.#helloNonce = randomBytes(16).toString("hex");
    this.#handshake = setTimeout(() => sock.destroy(), HANDSHAKE_TIMEOUT_MS);
    sock.on("connect", () => {
      this.#send({
        type: "hello",
        nonce: this.#helloNonce,
        browxai: PACKAGE_VERSION,
        pid: process.pid,
      });
    });
    sock.on("data", (chunk: string) => this.#onData(sock, chunk));
    // Node's connect errors name the socket path in their message. Log the code only.
    sock.on("error", (e: NodeJS.ErrnoException) => {
      if (this.#sock === sock)
        log.warn("browxai: operator channel connection error", { code: e.code });
    });
    sock.on("close", () => {
      if (this.#sock !== sock) return;
      this.#sock = null;
      this.#clearHandshake();
      if (this.#state === "closed") return;
      this.#state = "down";
      this.#scheduleRetry();
    });
  }

  #scheduleRetry(): void {
    if (this.#state === "closed" || this.#retry) return;
    const wait = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX_MS);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      this.#connect();
    }, wait);
    this.#retry.unref();
  }

  #clearHandshake(): void {
    if (this.#handshake) clearTimeout(this.#handshake);
    this.#handshake = null;
  }

  #clearTimers(): void {
    this.#clearHandshake();
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
  }

  #send(frame: Record<string, unknown>): void {
    const sock = this.#sock;
    if (!sock || sock.destroyed) return;
    const line = JSON.stringify({ v: OPERATOR_PROTOCOL_VERSION, ...frame });
    // The receiver drops a connection on an oversized line, so one that big
    // never goes out: it would loop through redial and resend.
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return;
    sock.write(line + "\n");
  }

  // ---------- inbound ----------

  #onData(sock: Socket, chunk: string): void {
    if (this.#sock !== sock) return;
    this.#buf += chunk;
    let nl = this.#buf.indexOf("\n");
    while (nl >= 0 && this.#sock === sock) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (line.length > MAX_FRAME_BYTES) return void sock.destroy();
      this.#onLine(sock, line);
      nl = this.#buf.indexOf("\n");
    }
    if (this.#buf.length > MAX_FRAME_BYTES) sock.destroy();
  }

  #onLine(sock: Socket, line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
    const f = frame as Record<string, unknown>;
    if (f.v !== OPERATOR_PROTOCOL_VERSION) return;
    if (this.#state === "hello") return this.#onWelcome(sock, f);
    if (this.#state === "auth") return this.#onReady(sock, f);
    if (this.#state === "ready" && f.type === "answer") this.#onAnswer(f);
  }

  #onWelcome(sock: Socket, f: Record<string, unknown>): void {
    if (f.type !== "welcome" || typeof f.nonce !== "string" || f.nonce.length > 128) {
      return void sock.destroy();
    }
    const expected = handshakeProof(this.#token, "daemon", this.#helloNonce, f.nonce);
    if (!proofMatches(expected, f.proof)) {
      // A listener that does not know the token holds the socket. Do not retry:
      // pending requests are denied now.
      log.error("browxai: operator channel closed: the daemon failed authentication");
      return this.close();
    }
    this.#daemonNonce = f.nonce;
    this.#state = "auth";
    this.#send({
      type: "auth",
      proof: handshakeProof(this.#token, "browxai", this.#helloNonce, this.#daemonNonce),
    });
  }

  #onReady(sock: Socket, f: Record<string, unknown>): void {
    if (f.type !== "ready") return void sock.destroy();
    this.#clearHandshake();
    this.#state = "ready";
    this.#backoff = BACKOFF_START_MS;
    log.info("browxai: operator channel connected");
    // Requests made while the channel was down, or sent to a daemon that
    // restarted, go out again under the same id.
    for (const p of this.#pending.values()) this.#send(p.frame);
  }

  #onAnswer(f: Record<string, unknown>): void {
    const id = typeof f.id === "string" ? f.id : "";
    const p = this.#pending.get(id);
    if (!p) return this.#send({ type: "error", id: id.slice(0, 64), code: "unknown-request" });
    const check = checkAnswer(p.rules, f);
    if (!check.ok) return this.#send({ type: "error", id, code: check.code });
    this.#send({ type: "resolved", id, outcome: OUTCOME[check.decision], by: "operator" });
    p.settle({
      answer: {
        decision: check.decision,
        ...(check.value !== undefined ? { value: check.value } : {}),
        ...(check.grant ? { grant: check.grant } : {}),
      },
    });
  }
}

/** Capabilities that let a request skip the daemon when `operator-channel` is on.
 *  A grant made by `approve_actions` is consumed before the ask, and a policy the
 *  agent moved off `ask-human` never asks. Both are the operator's own opt-ins,
 *  so this is a warning, not a refusal. */
export function operatorCombinationWarnings(caps: CapabilityConfig): string[] {
  const out: string[] = [];
  if (!capabilityMissing("self-approval", caps)) {
    out.push(
      "operator-channel is on together with self-approval: a confirm scope the agent pre-approves with approve_actions is consumed BEFORE the daemon is asked, so the daemon never sees those requests. Drop self-approval if the daemon is meant to decide every confirm hook.",
    );
  }
  if (!capabilityMissing("human-gate-override", caps)) {
    out.push(
      "operator-channel is on together with human-gate-override: the agent can move a permission, notification or file-picker policy off ask-human, and a request on a policy that no longer asks never reaches the daemon. Drop human-gate-override if the daemon is meant to decide every such prompt.",
    );
  }
  return out;
}

/** Open the channel for this server, or return null when it is not wanted.
 *
 *  Reads and removes `BROWX_OPERATOR_SOCKET` and `BROWX_OPERATOR_TOKEN` from
 *  `env` in every case. With the capability off nothing is opened and DevTools
 *  stays the answer path; the variables being set anyway is logged by name,
 *  never by value. With the capability on, a missing variable, a token that is
 *  too short, or a socket directory or file with wrong ownership or mode throws:
 *  the operator asked for the channel and gets a failed start instead of a
 *  channel that is not what they think it is. */
export function openOperatorChannel(
  caps: CapabilityConfig,
  env: NodeJS.ProcessEnv = process.env,
): OperatorChannel | null {
  const { socketPath, token } = takeOperatorEnv(env);
  if (capabilityMissing("operator-channel", caps)) {
    if (socketPath || token) {
      log.warn(
        "browxai: BROWX_OPERATOR_SOCKET or BROWX_OPERATOR_TOKEN is set but the operator-channel capability is off; the channel stays closed and DevTools stays the answer path. Add operator-channel to BROWX_CAPABILITIES to use it.",
      );
    }
    return null;
  }
  if (!socketPath || !token) {
    // The capability was asked for, so a channel that is not there would leave
    // the operator believing prompts reach the daemon. Both variables are
    // consumed by the first server in a process, so a second server in the same
    // process lands here too.
    throw new Error(
      "operator-channel: refusing to start the channel: BROWX_OPERATOR_SOCKET and BROWX_OPERATOR_TOKEN must both be set (a server takes them from the environment once, so only the first server in a process can open the channel)",
    );
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `operator-channel: refusing to start the channel: BROWX_OPERATOR_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters`,
    );
  }
  const check = checkOperatorSocket(socketPath);
  if (check.state === "unsafe") {
    throw new Error(`operator-channel: refusing to start the channel: ${check.reason}`);
  }
  if (check.state === "missing") {
    log.warn(
      "browxai: the operator channel socket does not exist yet; retrying until the daemon creates it",
    );
  }
  for (const w of operatorCombinationWarnings(caps)) log.warn(`browxai: ${w}`);
  const link = new OperatorLink(socketPath, token);
  link.start();
  return link;
}
