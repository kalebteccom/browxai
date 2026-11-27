import { describe, expect, it } from "vitest";
import { compareVersions } from "./runtime-layout.js";
import {
  applyAllowed,
  bootDelayUntil,
  contactGate,
  cooldownEnds,
  decideAuto,
  heldReason,
  HOUR,
  lastDay,
  nextBackoffMs,
  nextCheckAfter,
  SCHEDULE,
  type DecideInput,
} from "./runtime-schedule.js";

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;

describe("the numbers of D12", () => {
  it("checks every 6 hours plus 0 to 60 minutes of jitter", () => {
    expect(nextCheckAfter(NOW, () => 0)).toBe(iso(NOW + 6 * HOUR));
    expect(nextCheckAfter(NOW, () => 0.5)).toBe(iso(NOW + 6 * HOUR + 30 * MIN));
    const latest = Date.parse(nextCheckAfter(NOW, () => 0.999_999_9));
    expect(latest).toBeLessThan(NOW + 7 * HOUR);
    expect(latest).toBeGreaterThan(NOW + 6 * HOUR + 59 * MIN);
    // A broken random source can't push a check outside the window.
    expect(nextCheckAfter(NOW, () => 5)).toBe(nextCheckAfter(NOW, () => 0.999_999_9));
    expect(nextCheckAfter(NOW, () => NaN)).toBe(iso(NOW + 6 * HOUR));
  });

  it("waits 10 to 30 minutes after boot", () => {
    expect(bootDelayUntil(NOW, () => 0)).toBe(iso(NOW + 10 * MIN));
    const latest = Date.parse(bootDelayUntil(NOW, () => 0.999_999_9));
    expect(latest).toBeLessThan(NOW + 30 * MIN);
    expect(latest).toBeGreaterThan(NOW + 29 * MIN);
  });

  it("backs off 1 hour, doubling, capped at 24 hours", () => {
    const seq: number[] = [];
    let last: number | undefined;
    for (let i = 0; i < 8; i++) seq.push((last = nextBackoffMs(last)) / HOUR);
    expect(seq).toEqual([1, 2, 4, 8, 16, 24, 24, 24]);
  });

  it("counts only the last 24 hours", () => {
    const list = [iso(NOW - 25 * HOUR), iso(NOW - 23 * HOUR), iso(NOW), "garbage", iso(NOW + HOUR)];
    expect(lastDay(list, NOW)).toEqual([iso(NOW - 23 * HOUR), iso(NOW)]);
    expect(lastDay(undefined, NOW)).toEqual([]);
  });

  it("ends the delay after publish at publish time plus the hours", () => {
    expect(cooldownEnds("2026-11-26T12:00:00.000Z", 24)).toBe(NOW);
    expect(cooldownEnds(undefined, 24)).toBeUndefined();
    expect(cooldownEnds("not a date", 24)).toBeUndefined();
  });
});

describe("contactGate", () => {
  it("goes when nothing is scheduled", () => {
    expect(contactGate({}, NOW)).toEqual({ go: true });
  });

  it("returns quietly before nextCheck and inside a backoff", () => {
    expect(contactGate({ nextCheck: iso(NOW + MIN) }, NOW)).toEqual({ go: false, quiet: true });
    expect(contactGate({ backoffUntil: iso(NOW + MIN) }, NOW)).toEqual({ go: false, quiet: true });
    expect(contactGate({ nextCheck: iso(NOW), backoffUntil: iso(NOW - 1) }, NOW)).toEqual({
      go: true,
    });
  });

  it("stops at 6 contacts in 24 hours, until the oldest one expires", () => {
    const contacts = [5, 4, 3, 2, 1, 0].map((h) => iso(NOW - h * HOUR));
    expect(contactGate({ contacts }, NOW)).toEqual({
      go: false,
      quiet: false,
      reason: "6 registry contacts in 24 hours",
      nextCheck: iso(NOW - 5 * HOUR + 24 * HOUR),
    });
    expect(contactGate({ contacts: contacts.slice(1) }, NOW)).toEqual({ go: true });
  });

  it("allows 2 applies in 24 hours", () => {
    expect(applyAllowed({ applies: [iso(NOW - HOUR)] }, NOW)).toBe(true);
    expect(applyAllowed({ applies: [iso(NOW - 2 * HOUR), iso(NOW - HOUR)] }, NOW)).toBe(false);
    expect(applyAllowed({ applies: [iso(NOW - 25 * HOUR), iso(NOW - HOUR)] }, NOW)).toBe(true);
  });
});

describe("decideAuto", () => {
  const published = (hoursAgo: number) => iso(NOW - hoursAgo * HOUR);
  const input = (over: Partial<DecideInput> = {}): DecideInput => ({
    candidate: { version: "0.23.0", publishedAt: published(48) },
    current: "0.22.0",
    state: {},
    now: NOW,
    cooldownHours: SCHEDULE.cooldownHours,
    skipDelay: false,
    compare: compareVersions,
    ...over,
  });

  it("applies a newer version past its delay", () => {
    expect(decideAuto(input())).toEqual({ kind: "apply" });
    expect(decideAuto(input({ current: undefined }))).toEqual({ kind: "apply" });
  });

  it("does nothing when the channel's version isn't newer, and notes a deprecated current", () => {
    expect(decideAuto(input({ current: "0.23.0" }))).toEqual({
      kind: "none",
      result: "up to date on 0.23.0",
    });
    expect(decideAuto(input({ current: "0.24.0" }))).toMatchObject({ kind: "none" });
    expect(
      decideAuto(
        input({ current: "0.23.0", candidate: { version: "0.23.0", deprecated: "Use 0.23.1." } }),
      ),
    ).toEqual({ kind: "none", result: "up to date on 0.23.0", currentDeprecated: "Use 0.23.1." });
  });

  it("skips a deprecated version", () => {
    expect(
      decideAuto(input({ candidate: { version: "0.23.0", deprecated: "broken" } })),
    ).toMatchObject({ kind: "none", result: "0.23.0 is deprecated, skipped" });
  });

  it("keeps a held version, and one that failed three times, held", () => {
    expect(decideAuto(input({ state: { held: { "0.23.0": "verification failed" } } }))).toEqual({
      kind: "pending",
      pending: { version: "0.23.0", state: "held", reason: "verification failed" },
      result: "0.23.0 held: verification failed",
    });
    expect(decideAuto(input({ state: { failed: { "0.23.0": 3 } } }))).toMatchObject({
      kind: "pending",
      pending: { state: "held", reason: "failed its checks 3 times" },
    });
    expect(decideAuto(input({ state: { failed: { "0.23.0": 2 } } }))).toEqual({ kind: "apply" });
  });

  it("holds a version a guard holds, before its delay and even with --now", () => {
    const guard = "a new major version (1.4.0 to 2.0.0). Run browxai runtime update --allow-major";
    expect(
      decideAuto(
        input({
          candidate: { version: "2.0.0", publishedAt: published(1) },
          current: "1.4.0",
          skipDelay: true,
          guard,
        }),
      ),
    ).toEqual({
      kind: "pending",
      pending: { version: "2.0.0", state: "held", reason: guard },
      result: `2.0.0 held: ${guard}`,
    });
  });

  it("names a recorded hold before a guard, and a guard after three failures", () => {
    expect(heldReason("0.23.0", { held: { "0.23.0": "rolled back by user" } }, "guard")).toBe(
      "rolled back by user",
    );
    expect(heldReason("0.23.0", { failed: { "0.23.0": 3 } }, "guard")).toBe(
      "failed its checks 3 times",
    );
    expect(heldReason("0.23.0", { held: { "0.22.0": "rolled back by user" } }, "guard")).toBe(
      "guard",
    );
    expect(heldReason("0.23.0", { held: { "0.22.0": "rolled back by user" } })).toBeUndefined();
  });

  it("waits 24 hours after publish, unless --now", () => {
    expect(
      decideAuto(input({ candidate: { version: "0.23.0", publishedAt: published(23) } })),
    ).toEqual({
      kind: "pending",
      pending: { version: "0.23.0", state: "waiting", until: iso(NOW + HOUR) },
      result: `0.23.0 waits until ${iso(NOW + HOUR)}`,
    });
    expect(
      decideAuto(
        input({ candidate: { version: "0.23.0", publishedAt: published(23) }, skipDelay: true }),
      ),
    ).toEqual({ kind: "apply" });
    expect(
      decideAuto(
        input({ candidate: { version: "0.23.0", publishedAt: published(1) }, cooldownHours: 0 }),
      ),
    ).toEqual({ kind: "apply" });
  });

  it("waits for the daily apply limit", () => {
    const applies = [iso(NOW - 2 * HOUR), iso(NOW - HOUR)];
    expect(decideAuto(input({ state: { applies } }))).toMatchObject({
      kind: "pending",
      pending: { version: "0.23.0", state: "limit" },
    });
  });
});
