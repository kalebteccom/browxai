// Phase 2.5 — session registry. Holds one isolated SessionEntry per session id;
// the "default" entry is created lazily on first browser-touching tool call
// (back-compat: every existing caller that omits `session` resolves here).
//
// Browser-agnostic by construction: the registry takes an entry `factory` and
// a `teardown`, so it's unit-testable without launching Chrome. The factory /
// teardown that actually wire Playwright live in server.ts.

import type { BrowserSession } from "./types.js";
import type { RefRegistry } from "../page/refs.js";
import type { ConsoleBuffer } from "../page/console.js";
import type { NetworkBuffer, WsBuffer } from "../page/network.js";
import type { BrowxBridge } from "../helper/bridge.js";
import type { Recorder } from "../page/recording.js";
import type { FeedbackMemory } from "../page/learning.js";

export type SessionMode = "persistent" | "incognito" | "attached";

/** Per-session state. Everything here was a server-singleton pre-Phase-2.5;
 *  one of these exists per live session id. */
export interface SessionEntry {
  id: string;
  mode: SessionMode;
  session: BrowserSession;
  refs: RefRegistry;
  console: ConsoleBuffer;
  network: NetworkBuffer;
  /** session-wide WebSocket/SSE frame ring. */
  ws: WsBuffer;
  bridge: BrowxBridge;
  recorder: Recorder;
  feedback: FeedbackMemory;
  openedAt: number;
  /** epoch ms of the last `get()` for this id — drives idle-age
   *  reaping (`close_sessions({ idleMs })`) at multi-agent scale. */
  lastActivityAt: number;
}

export const DEFAULT_SESSION_ID = "default";

/** Per-session creation spec, supplied by `open_session` (or undefined for the
 *  lazily-created default, which falls back to the server's launch mode). */
export interface OpenSpec {
  mode?: SessionMode;
  /** Persistent mode only: named profile dir under the workspace. */
  profile?: string;
  /** Playwright device-preset name (e.g. "iPhone 14"). */
  device?: string;
  /** explicit viewport; overrides a preset's viewport. */
  viewport?: { width: number; height: number };
}

export class SessionRegistry {
  private entries = new Map<string, SessionEntry>();
  /** In-flight creations, so two concurrent first-calls for the same id don't
   *  each launch a browser. */
  private creating = new Map<string, Promise<SessionEntry>>();

  constructor(
    private factory: (id: string, spec?: OpenSpec) => Promise<SessionEntry>,
    private teardown: (e: SessionEntry) => Promise<void>,
  ) {}

  /** Resolve (or lazily create) the entry for `id`. Concurrency-safe. The
   *  `spec` is only consulted on creation — once an entry exists it's returned
   *  as-is regardless of spec. */
  async get(id: string = DEFAULT_SESSION_ID, spec?: OpenSpec): Promise<SessionEntry> {
    const existing = this.entries.get(id);
    if (existing) {
      existing.lastActivityAt = Date.now(); // touch for idle reaping
      return existing;
    }
    const inflight = this.creating.get(id);
    if (inflight) return inflight;
    const p = this.factory(id, spec)
      .then((e) => {
        this.entries.set(id, e);
        this.creating.delete(id);
        return e;
      })
      .catch((err) => {
        this.creating.delete(id);
        throw err;
      });
    this.creating.set(id, p);
    return p;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Non-creating peek — returns undefined if not yet open. */
  peek(id: string): SessionEntry | undefined {
    return this.entries.get(id);
  }

  list(): SessionEntry[] {
    return [...this.entries.values()];
  }

  /** Tear down + remove one session. Returns false if it wasn't open. */
  async close(id: string): Promise<boolean> {
    const e = this.entries.get(id);
    if (!e) return false;
    this.entries.delete(id);
    await this.teardown(e);
    return true;
  }

  /**
   * bulk teardown. Selects live sessions by `prefix` (id starts-with),
   * `all`, and/or `idleMs` (no `get()` in the last N ms). Filters AND together
   * when multiple are given; at least one selector is required. Returns the
   * closed ids (in selection order). The team-lead reap primitive — at
   * multi-agent scale a wedged/killed agent strands sessions.
   */
  async closeMatching(sel: { prefix?: string; all?: boolean; idleMs?: number }): Promise<string[]> {
    const now = Date.now();
    const victims = [...this.entries.values()].filter((e) => {
      if (sel.prefix !== undefined && !e.id.startsWith(sel.prefix)) return false;
      if (sel.idleMs !== undefined && now - e.lastActivityAt < sel.idleMs) return false;
      // `all` (or prefix/idle match with all unset) — if no positive selector
      // was given the caller must pass `all`, enforced at the tool layer.
      return true;
    });
    const closed: string[] = [];
    for (const e of victims) {
      this.entries.delete(e.id);
      await this.teardown(e).catch(() => undefined);
      closed.push(e.id);
    }
    return closed;
  }

  /** Tear down everything (server shutdown). */
  async closeAll(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    for (const e of all) {
      await this.teardown(e).catch(() => undefined);
    }
  }
}
