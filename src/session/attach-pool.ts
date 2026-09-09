// Attached-target pool (RFC 0005). One lease binds one session id to one CDP page
// target on one endpoint, so N sessions attached to one Chrome never share a Page.

import type { Page } from "playwright-core";
import { log } from "../util/logging.js";

export const DEFAULT_ATTACH_LEASE_TTL_MS = 300_000;
export const DEFAULT_ATTACH_POOL_MAX = 8;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function attachLeaseTtlMs(): number {
  return positiveIntEnv("BROWX_ATTACH_LEASE_TTL_MS", DEFAULT_ATTACH_LEASE_TTL_MS);
}

export function attachPoolMax(): number {
  return positiveIntEnv("BROWX_ATTACH_POOL_MAX", DEFAULT_ATTACH_POOL_MAX);
}

export interface AttachLease {
  readonly sessionId: string;
  readonly targetId: string;
  readonly endpoint: string;
  readonly acquiredAt: number;
  renewedAt: number;
  /** The session created this target and closes it at release. A claimed
   *  pre-existing target is the operator's own tab and always outlives us. */
  readonly owned: boolean;
}

export function attachTargetGone(sessionId: string, targetId: string): Error {
  return new Error(
    `attach-target-gone: session "${sessionId}" is leased to target "${targetId}", which is ` +
      "no longer open. The tab was closed in the attached browser. Close the session and open a " +
      "fresh one to claim another target.",
  );
}

export function attachLeaseExpired(sessionId: string, ttlMs: number): Error {
  return new Error(
    `attach-lease-expired: session "${sessionId}" no longer holds a target lease. It sat idle ` +
      `past the ${ttlMs}ms TTL (BROWX_ATTACH_LEASE_TTL_MS) and another session reclaimed its ` +
      "tab. Open a fresh session to claim a target; continuing on the old one would write to a " +
      "tab someone else now owns.",
  );
}

export function attachPoolExhausted(
  endpoint: string,
  ceiling: number,
  leases: readonly AttachLease[],
): Error {
  const live = leases.map((l) => `${l.sessionId}→${l.targetId}`).join(", ") || "none";
  return new Error(
    `attach-pool-exhausted: endpoint "${endpoint}" already holds ${leases.length} leases at the ` +
      `${ceiling}-target ceiling (BROWX_ATTACH_POOL_MAX). Live leases: ${live}. Close a session ` +
      "to free a target.",
  );
}

export class AttachLeaseTable {
  private readonly bySession = new Map<string, AttachLease>();

  claim(spec: {
    sessionId: string;
    targetId: string;
    endpoint: string;
    owned: boolean;
    now?: number;
  }): AttachLease {
    const now = spec.now ?? Date.now();
    const lease: AttachLease = {
      sessionId: spec.sessionId,
      targetId: spec.targetId,
      endpoint: spec.endpoint,
      acquiredAt: now,
      renewedAt: now,
      owned: spec.owned,
    };
    this.bySession.set(spec.sessionId, lease);
    return lease;
  }

  release(sessionId: string): AttachLease | undefined {
    const lease = this.bySession.get(sessionId);
    this.bySession.delete(sessionId);
    return lease;
  }

  get(sessionId: string): AttachLease | undefined {
    return this.bySession.get(sessionId);
  }

  /** Bump the lease. Elapsed time alone never fails a renewal: an idle session
   *  keeps its tab until another session actually needs one and reclaims it, so
   *  a long think between calls is not punished. `reclaimExpired` is what ends a
   *  lease, and `renew` reports that after the fact. */
  renew(sessionId: string, now = Date.now()): AttachLease | undefined {
    const lease = this.bySession.get(sessionId);
    if (!lease) return undefined;
    lease.renewedAt = now;
    return lease;
  }

  /** Drop leases idle past the TTL so their targets return to the pool. Lazy:
   *  called at acquisition, so a dead agent frees its tab without a sweeper. */
  reclaimExpired(endpoint: string, ttlMs = attachLeaseTtlMs(), now = Date.now()): AttachLease[] {
    const dead = this.forEndpoint(endpoint).filter((l) => now - l.renewedAt > ttlMs);
    for (const l of dead) this.bySession.delete(l.sessionId);
    return dead;
  }

  forEndpoint(endpoint: string): AttachLease[] {
    return [...this.bySession.values()].filter((l) => l.endpoint === endpoint);
  }

  leasedTargets(endpoint: string): Set<string> {
    return new Set(this.forEndpoint(endpoint).map((l) => l.targetId));
  }

  list(): AttachLease[] {
    return [...this.bySession.values()];
  }
}

/** Process-wide, not per-server: the pool protects the operator's browser from
 *  every session in this process, and two servers in one process attached to the
 *  same Chrome must not hand each other's tabs out twice. */
export const attachLeases = new AttachLeaseTable();

/** Renew the lease of a session that holds one, or refuse the call because the
 *  lease is gone. Callers pass the target the session is bound to: a lease that
 *  vanished, or that now names a different target, means another session
 *  reclaimed this tab, and continuing would write to a tab someone else owns —
 *  the exact silent-wrong-write this pool exists to stop. */
export function touchAttachLease(sessionId: string, targetId: string): void {
  const lease = attachLeases.get(sessionId);
  if (lease === undefined || lease.targetId !== targetId) {
    throw attachLeaseExpired(sessionId, attachLeaseTtlMs());
  }
  attachLeases.renew(sessionId);
}

export interface PoolTarget {
  readonly targetId: string;
  readonly page: Page;
}

export interface TargetSource {
  list(): Promise<PoolTarget[]>;
  create(): Promise<PoolTarget>;
}

export interface AcquiredTarget extends PoolTarget {
  readonly created: boolean;
}

const acquisitions = new Map<string, Promise<unknown>>();

/** Acquisition is serialized per endpoint: enumerate-then-claim spans an await,
 *  so two concurrent opens would otherwise both see the same target free. */
function serializePerEndpoint<T>(endpoint: string, run: () => Promise<T>): Promise<T> {
  const prior = acquisitions.get(endpoint) ?? Promise.resolve();
  const next = prior.then(run, run);
  acquisitions.set(
    endpoint,
    next.catch(() => undefined),
  );
  return next;
}

export function acquireTarget(
  leases: AttachLeaseTable,
  source: TargetSource,
  spec: { sessionId: string; endpoint: string },
): Promise<AcquiredTarget> {
  return serializePerEndpoint(spec.endpoint, async () => {
    const reclaimed = leases.reclaimExpired(spec.endpoint);
    if (reclaimed.length > 0) {
      log.warn(
        `attach pool: reclaimed ${reclaimed.length} idle lease(s) on ${spec.endpoint} — ` +
          reclaimed.map((l) => `${l.sessionId}→${l.targetId}`).join(", "),
      );
    }
    const held = leases.forEndpoint(spec.endpoint);
    const ceiling = attachPoolMax();
    if (held.length >= ceiling) throw attachPoolExhausted(spec.endpoint, ceiling, held);

    const taken = new Set(held.map((l) => l.targetId));
    const free = (await source.list()).find((t) => !taken.has(t.targetId) && !t.page.isClosed());
    const target = free ?? (await source.create());
    if (target.page.isClosed()) throw attachTargetGone(spec.sessionId, target.targetId);
    const created = free === undefined;
    leases.claim({ ...spec, targetId: target.targetId, owned: created });
    return { targetId: target.targetId, page: target.page, created };
  });
}

export async function releaseTarget(
  leases: AttachLeaseTable,
  sessionId: string,
  page: Page,
): Promise<void> {
  const lease = leases.release(sessionId);
  if (lease?.owned) await page.close().catch(() => undefined);
}
