// The panels' view of the event log (RFC 0007 P3). A panel is a pure function
// of the log and the playhead, so the cost that matters is the seek: a 50k
// event log must not be re-scanned every time the playhead moves.
//
// Two structures pay for that. The log is bucketed by `type` ONCE when the
// artifact opens, and everything a panel derives from a bucket stays ordered by
// `t`, so resolving the playhead is a binary search over a panel's own rows.
//
// Bucketing by the raw string keeps the forward-compatibility rule: a type this
// build has never heard of gets a bucket like any other, and a panel that does
// not ask for it simply never sees it.

import type { ReplayEvent } from "../../schema.js";

const EMPTY: readonly ReplayEvent[] = [];

export interface EventIndex {
  readonly events: readonly ReplayEvent[];
  /** Largest `t` in the log. What an unclosed span or a still-open socket runs
   *  to, since neither has an end event to read one from. */
  readonly duration: number;
  has(type: string): boolean;
  byType(type: string): readonly ReplayEvent[];
  count(type: string): number;
}

/** Envelope `t`, defended the same way `../model.ts` defends it: a negative or
 *  non-numeric stamp becomes 0 rather than corrupting every search that
 *  assumes the bucket is ordered. */
export function timeOf(event: ReplayEvent): number {
  const t = event.t;
  return typeof t === "number" && Number.isFinite(t) ? Math.max(0, t) : 0;
}

function payload(event: ReplayEvent): Record<string, unknown> {
  const p = event.payload;
  return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : {};
}

/** Payload reads, each defaulted. Every panel reads a payload this way: a field
 *  of the wrong type degrades to the default instead of throwing, which is the
 *  reader half of the forward-compatibility rule. */
export function strField(event: ReplayEvent, key: string, fallback = ""): string {
  const v = payload(event)[key];
  return typeof v === "string" ? v : fallback;
}

export function numField(event: ReplayEvent, key: string): number | undefined {
  const v = payload(event)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function objField(event: ReplayEvent, key: string): Record<string, unknown> {
  return asObject(payload(event)[key]);
}

export function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function rawPayload(event: ReplayEvent): Record<string, unknown> {
  return payload(event);
}

export function indexEvents(events: readonly ReplayEvent[]): EventIndex {
  const buckets = new Map<string, ReplayEvent[]>();
  let duration = 0;
  for (const event of events) {
    const t = timeOf(event);
    if (t > duration) duration = t;
    const bucket = buckets.get(event.type);
    if (bucket) bucket.push(event);
    else buckets.set(event.type, [event]);
  }
  // Append-only and monotonic is what the writer promises; a bucket that is not
  // (a hand-assembled log, a source stamping its own clock) is sorted here
  // rather than left to break every binary search downstream.
  for (const bucket of buckets.values()) sortByTime(bucket);
  return {
    events,
    duration,
    has: (type) => (buckets.get(type)?.length ?? 0) > 0,
    byType: (type) => buckets.get(type) ?? EMPTY,
    count: (type) => buckets.get(type)?.length ?? 0,
  };
}

function sortByTime(bucket: ReplayEvent[]): void {
  for (let i = 1; i < bucket.length; i++) {
    if (timeOf(bucket[i - 1]!) > timeOf(bucket[i]!)) {
      bucket.sort((a, b) => timeOf(a) - timeOf(b));
      return;
    }
  }
}

/**
 * Count of items at or before `t`, by binary search. Every panel resolves the
 * playhead through this, so a seek costs log2(n) on the panel's own rows
 * instead of a scan of the log.
 */
export function upToIndex<T>(items: readonly T[], t: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]!) <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose key is at or after `t`. The lower bound to `upToIndex`'s
 *  upper one, so a half-open range over a sorted list costs two searches. */
export function fromIndex<T>(items: readonly T[], t: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(items[mid]!) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The most recent `limit` items at or before `t`, plus how many older ones
 *  were left out. Bounded on purpose: a log can carry 50k requests and no
 *  reviewer reads 50k rows. */
export function windowUpTo<T>(
  items: readonly T[],
  t: number,
  limit: number,
  key: (item: T) => number,
): { rows: readonly T[]; hidden: number; total: number } {
  const total = upToIndex(items, t, key);
  const from = Math.max(0, total - limit);
  return { rows: items.slice(from, total), hidden: from, total };
}
