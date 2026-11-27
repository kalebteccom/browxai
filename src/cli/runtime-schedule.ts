// `browxai runtime update --auto`: when the background job may contact the
// registry and apply a version (RFC 0015, section 7 and D12). Pure functions of
// the state, an injected clock and an injected random source, so every number
// here has a unit test.
//
// The job wakes hourly. It contacts the registry every 6 hours plus 0 to 60
// minutes of jitter, waits 10 to 30 minutes after the first run that follows a
// boot, makes at most 6 contacts and 2 applies in 24 hours, backs off 1 hour
// after a failed contact and doubles that up to 24 hours, and applies a version
// only 24 hours after it was published.

import type { PendingUpdate, RuntimeState } from "./runtime-store.js";

const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SCHEDULE = {
  checkEveryMs: 6 * HOUR,
  jitterMs: 60 * MINUTE,
  bootDelayMinMs: 10 * MINUTE,
  bootDelayMaxMs: 30 * MINUTE,
  contactsPerDay: 6,
  appliesPerDay: 2,
  failuresBeforeHold: 3,
  backoffFirstMs: HOUR,
  backoffMaxMs: DAY,
  cooldownHours: 24,
} as const;

/** A random number in [0, 1). Tests pass a fixed one. */
export type Random = () => number;

const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (time: string | undefined): number | undefined => {
  if (!time) return undefined;
  const t = Date.parse(time);
  return Number.isNaN(t) ? undefined : t;
};

/** When the next contact is due after a check that got an answer. */
export function nextCheckAfter(now: number, random: Random): string {
  return iso(now + SCHEDULE.checkEveryMs + Math.floor(clamp01(random()) * SCHEDULE.jitterMs));
}

/** The first contact after a boot: 10 to 30 minutes from now. */
export function bootDelayUntil(now: number, random: Random): string {
  const span = SCHEDULE.bootDelayMaxMs - SCHEDULE.bootDelayMinMs;
  return iso(now + SCHEDULE.bootDelayMinMs + Math.floor(clamp01(random()) * span));
}

/** The backoff after a failed contact: 1 hour, then double the last, at most 24 hours. */
export function nextBackoffMs(lastMs: number | undefined): number {
  if (lastMs === undefined || lastMs < SCHEDULE.backoffFirstMs) return SCHEDULE.backoffFirstMs;
  return Math.min(lastMs * 2, SCHEDULE.backoffMaxMs);
}

/** The times in `list` that fall in the 24 hours before `now`. */
export function lastDay(list: readonly string[] | undefined, now: number): string[] {
  return (list ?? []).filter((t) => {
    const at = ms(t);
    return at !== undefined && at <= now && now - at < DAY;
  });
}

/** When the delay after publish ends for a version published at `publishedAt`. */
export function cooldownEnds(publishedAt: string | undefined, hours: number): number | undefined {
  const at = ms(publishedAt);
  return at === undefined ? undefined : at + hours * HOUR;
}

export type ContactGate =
  | { go: true }
  /** `quiet`: an hourly wake that is early, logged nowhere. */
  | { go: false; quiet: true }
  | { go: false; quiet: false; reason: string; nextCheck: string };

/**
 * Whether this run may contact the registry. A run inside a backoff or before
 * `nextCheck` returns quietly, since the job wakes every hour. A run that would
 * pass 6 contacts in 24 hours moves `nextCheck` to when the oldest one expires.
 */
export function contactGate(state: RuntimeState, now: number): ContactGate {
  const backoff = ms(state.backoffUntil);
  if (backoff !== undefined && now < backoff) return { go: false, quiet: true };
  const next = ms(state.nextCheck);
  if (next !== undefined && now < next) return { go: false, quiet: true };
  const recent = lastDay(state.contacts, now);
  if (recent.length >= SCHEDULE.contactsPerDay) {
    const oldest = Math.min(...recent.map((t) => ms(t)!));
    return {
      go: false,
      quiet: false,
      reason: `${SCHEDULE.contactsPerDay} registry contacts in 24 hours`,
      nextCheck: iso(oldest + DAY),
    };
  }
  return { go: true };
}

/** Whether another apply fits in the last 24 hours. */
export function applyAllowed(state: RuntimeState, now: number): boolean {
  return lastDay(state.applies, now).length < SCHEDULE.appliesPerDay;
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(Math.max(x, 0), 0.999_999) : 0;
}

export interface Candidate {
  version: string;
  publishedAt?: string;
  deprecated?: string;
}

export type AutoDecision =
  /** Nothing to apply. `currentDeprecated` carries the registry's message when
   *  the channel's version is `current` and the maintainers deprecated it. */
  | { kind: "none"; result: string; currentDeprecated?: string }
  | { kind: "pending"; pending: PendingUpdate; result: string }
  | { kind: "apply" };

export interface DecideInput {
  candidate: Candidate;
  current: string | undefined;
  state: RuntimeState;
  now: number;
  cooldownHours: number;
  /** `--now`: skip the delay after publish. */
  skipDelay: boolean;
  compare: (a: string, b: string) => number;
}

/**
 * What the background job does with the channel's version, in the order of RFC
 * 0015 section 4: skip one that isn't newer, skip a deprecated one, keep a held
 * one or one that failed three times, wait out the delay after publish, then
 * respect the daily apply limit.
 */
export function decideAuto(input: DecideInput): AutoDecision {
  const { candidate: c, current, state, now } = input;
  const v = c.version;
  if (current && input.compare(v, current) <= 0) {
    return {
      kind: "none",
      result: `up to date on ${current}`,
      ...(v === current && c.deprecated ? { currentDeprecated: c.deprecated } : {}),
    };
  }
  if (c.deprecated) return { kind: "none", result: `${v} is deprecated, skipped` };
  const failures = state.failed?.[v] ?? 0;
  const held =
    state.held?.[v] ??
    (failures >= SCHEDULE.failuresBeforeHold ? `failed its checks ${failures} times` : undefined);
  if (held) {
    return {
      kind: "pending",
      pending: { version: v, state: "held", reason: held },
      result: `${v} held: ${held}`,
    };
  }
  const ends = cooldownEnds(c.publishedAt, input.cooldownHours);
  if (!input.skipDelay && ends !== undefined && now < ends) {
    const until = iso(ends);
    return {
      kind: "pending",
      pending: { version: v, state: "waiting", until },
      result: `${v} waits until ${until}`,
    };
  }
  if (!applyAllowed(state, now)) {
    return {
      kind: "pending",
      pending: {
        version: v,
        state: "limit",
        reason: `${SCHEDULE.appliesPerDay} applies in 24 hours`,
      },
      result: `${v} waits for the daily apply limit`,
    };
  }
  return { kind: "apply" };
}
