import { describe, it, expect } from "vitest";
import { ConsoleBuffer } from "./console.js";

// ConsoleBuffer.ingest is the non-Playwright console feed — the safari engine
// pumps its BiDi log.entryAdded stream through it. These cover the
// level→type mapping + the read surface the tools consume.

describe("ConsoleBuffer.ingest (the safari BiDi feed)", () => {
  it("surfaces ingested entries through recent() like page-attached ones", () => {
    const buf = new ConsoleBuffer();
    buf.ingest("info", "hello from safari");
    buf.ingest("error", "boom");
    const recent = buf.recent();
    expect(recent.map((m) => m.text)).toEqual(["hello from safari", "boom"]);
    expect(recent.map((m) => m.type)).toEqual(["info", "error"]);
  });

  it("maps the BiDi 'warn' level to the 'warning' type the readers key on", () => {
    const buf = new ConsoleBuffer();
    const t0 = Date.now() - 1;
    buf.ingest("warn", "deprecation");
    buf.ingest("warn", "another");
    expect(buf.warningCountSince(t0)).toBe(2);
  });

  it("error entries are visible to errorsSince()", () => {
    const buf = new ConsoleBuffer();
    const t0 = Date.now() - 1;
    buf.ingest("error", "TypeError: x is undefined");
    buf.ingest("info", "noise");
    expect(buf.errorsSince(t0)).toEqual(["TypeError: x is undefined"]);
  });

  it("respects the ring cap (oldest evicted)", () => {
    const buf = new ConsoleBuffer(2);
    buf.ingest("info", "a");
    buf.ingest("info", "b");
    buf.ingest("info", "c");
    expect(buf.recent().map((m) => m.text)).toEqual(["b", "c"]);
  });
});
