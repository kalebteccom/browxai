// session registry. Holds one isolated SessionEntry per session id;
// the "default" entry is created lazily on first browser-touching tool call
// (back-compat: every existing caller that omits `session` resolves here).
//
// Browser-agnostic by construction: the registry takes an entry `factory` and
// a `teardown`, so it's unit-testable without launching Chrome. The factory /
// teardown that actually wire Playwright live in server.ts.
//
// The per-session role-bundle TYPE catalogue (the SessionEntry sub-interfaces
// + OpenSpec) lives in `./session-entry-types.js` — split out because it grows
// for a different reason (a feature field is added) than this class (the session
// lifecycle changes). Re-exported here so every importer's path is unchanged.

import type { SessionEntry, OpenSpec } from "./session-entry-types.js";
import { holdsAskHuman } from "../policy/ask-human-guard.js";
import type { PermissionPolicy } from "./permission-policy.js";
import type { NotificationPolicy } from "./notification-policy.js";
import type { FsPickerPolicy } from "./fs-picker-policy.js";

// Barrel re-export — preserve the public surface: every type that used to be
// declared here stays importable from `./registry.js`.
export type {
  SessionMode,
  SessionCore,
  SessionObserveRole,
  SessionNetworkRole,
  SessionFeatureRole,
  SessionEmulationRole,
  SessionDeepRole,
  SessionHealthRole,
  SessionPolicyRole,
  SessionDeviceRole,
  SessionCaptureRole,
  SessionEntry,
  OpenSpec,
} from "./session-entry-types.js";

export const DEFAULT_SESSION_ID = "default";

/** The `ask-human` policies a session name held when it last closed. Only the
 *  policies that held something for a human are present. */
export interface HeldAskHuman {
  /** The persistent profile directory the session ran on, when it had one. A
   *  different name launched on it would reuse the same cookies and login state. */
  profileDir?: string;
  permission?: PermissionPolicy;
  notification?: NotificationPolicy;
  fsPicker?: FsPickerPolicy;
}

/** The `ask-human` policies a live entry holds right now, or undefined when it
 *  holds none. Reads the live policy state, so a policy moved off `ask-human`
 *  under `human-gate-override` is no longer held. */
function heldBy(e: SessionEntry): HeldAskHuman | undefined {
  const perm = e.permission.current();
  const notif = e.notification.current();
  const pick = e.fsPicker.current();
  const held: HeldAskHuman = {};
  if (holdsAskHuman({ mode: perm.mode, overrides: perm.perPermission })) held.permission = perm;
  if (holdsAskHuman({ mode: notif.mode })) held.notification = notif;
  if (holdsAskHuman({ mode: pick.mode, overrides: pick.perAPI })) held.fsPicker = pick;
  if (Object.keys(held).length === 0) return undefined;
  if (e.session.profileDir) held.profileDir = e.session.profileDir;
  return held;
}

export class SessionRegistry {
  private entries = new Map<string, SessionEntry>();
  /** In-flight creations, so two concurrent first-calls for the same id don't
   *  each launch a browser. */
  private creating = new Map<string, Promise<SessionEntry>>();
  /** Per session name, the `ask-human` policies it held when it last closed.
   *  Written only by this class, on close, from the live policy state, so no tool
   *  argument can set or clear it. A name that reopens inherits these for any
   *  policy the caller leaves out, and `open_session` refuses to replace them
   *  without `human-gate-override`. Lives for the server process. */
  private held = new Map<string, HeldAskHuman>();

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
    const p = this.factory(id, this.inheritHeld(id, spec))
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

  /** The `ask-human` policies this name held when it last closed, if any. */
  heldAskHuman(id: string): HeldAskHuman | undefined {
    return this.held.get(id);
  }

  /** The record of a closed `ask-human` session that ran on this profile
   *  directory, whatever its name. */
  heldOnProfile(profileDir: string): HeldAskHuman | undefined {
    for (const held of this.held.values()) if (held.profileDir === profileDir) return held;
    return undefined;
  }

  /** Fill each policy the spec leaves out with the one the name held on
   *  `ask-human` at its last close, so a reopen (or a lazily re-created default
   *  session) cannot fall back to a default that ends the hold. */
  private inheritHeld(id: string, spec: OpenSpec | undefined): OpenSpec | undefined {
    const held = this.held.get(id);
    if (!held) return spec;
    return {
      ...spec,
      permissionPolicy: spec?.permissionPolicy ?? held.permission,
      notificationPolicy: spec?.notificationPolicy ?? held.notification,
      fsPickerPolicy: spec?.fsPickerPolicy ?? held.fsPicker,
    };
  }

  /** Replace the name's record with what the closing entry holds. */
  private remember(e: SessionEntry): void {
    const held = heldBy(e);
    if (held) this.held.set(e.id, held);
    else this.held.delete(e.id);
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
    this.remember(e);
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
      this.remember(e);
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
