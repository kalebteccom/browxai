import { describe, it, expect } from "vitest";
import { PolicyRecordBuffer } from "./policy-buffer.js";

// Direct unit test for the shared bounded ring the five policy classes compose
// (RFC 0004 P3 / D4). The behaviour-preservation proof for the extraction is the
// five existing policy suites (dialog/permission/notification/fs-picker/device-emu)
// running green against this; these assertions pin the abstraction's own contract.

interface TsRec {
  ts: number;
  tag: string;
}

describe("PolicyRecordBuffer", () => {
  it("slices records with timestamp >= since (default `ts` accessor)", () => {
    const buf = new PolicyRecordBuffer<TsRec>();
    buf.record({ ts: 10, tag: "a" });
    buf.record({ ts: 20, tag: "b" });
    buf.record({ ts: 30, tag: "c" });
    expect(buf.since(20).map((r) => r.tag)).toEqual(["b", "c"]);
    expect(buf.since(0).map((r) => r.tag)).toEqual(["a", "b", "c"]);
    expect(buf.since(31)).toEqual([]);
  });

  it("enforces the cap by dropping the oldest record (the load-bearing bound)", () => {
    const buf = new PolicyRecordBuffer<TsRec>(3);
    for (let i = 1; i <= 5; i++) buf.record({ ts: i, tag: `r${i}` });
    const kept = buf.since(0).map((r) => r.tag);
    expect(kept).toEqual(["r3", "r4", "r5"]); // first two evicted past cap=3
  });

  it("matchedSince applies the predicate only within the window", () => {
    const buf = new PolicyRecordBuffer<TsRec>();
    buf.record({ ts: 10, tag: "raised" });
    buf.record({ ts: 30, tag: "accepted" });
    expect(buf.matchedSince(5, (r) => r.tag === "raised")).toBe(true);
    // the "raised" record is at ts=10 — a window starting after it must miss
    expect(buf.matchedSince(20, (r) => r.tag === "raised")).toBe(false);
  });

  it("honours a custom timestamp extractor (the NotificationRecord `timestamp` shape)", () => {
    interface StampRec {
      timestamp: number;
      tag: string;
    }
    const buf = new PolicyRecordBuffer<StampRec>(200, (r) => r.timestamp);
    buf.record({ timestamp: 100, tag: "x" });
    buf.record({ timestamp: 200, tag: "y" });
    expect(buf.since(150).map((r) => r.tag)).toEqual(["y"]);
    expect(buf.matchedSince(50, (r) => r.tag === "x")).toBe(true);
  });
});
