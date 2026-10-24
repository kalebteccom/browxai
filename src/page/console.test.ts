import { describe, it, expect } from "vitest";
import { ConsoleBuffer, MAX_CONSOLE_MESSAGE_CHARS, capConsoleText } from "./console.js";

// ConsoleBuffer.ingest is the non-Playwright console feed — the safari engine
// pumps its BiDi log.entryAdded stream through it. These cover the
// level→type mapping + the read surface the tools consume.

describe("ConsoleBuffer.ingest (the safari BiDi feed)", () => {
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

describe("console message size cap", () => {
  it("leaves a message at the cap as it is", () => {
    const text = "a".repeat(MAX_CONSOLE_MESSAGE_CHARS);
    expect(capConsoleText(text)).toBe(text);
  });

  it("cuts a longer message and says how much was dropped", () => {
    const out = capConsoleText("a".repeat(MAX_CONSOLE_MESSAGE_CHARS + 25));
    expect(out.startsWith("a".repeat(MAX_CONSOLE_MESSAGE_CHARS))).toBe(true);
    expect(out.endsWith("[truncated 25 chars]")).toBe(true);
  });

  it("stores an oversized ingested message capped", () => {
    const buf = new ConsoleBuffer();
    buf.ingest("error", "x".repeat(1024 * 1024));
    const [msg] = buf.recent();
    expect(msg!.text.length).toBeLessThan(MAX_CONSOLE_MESSAGE_CHARS + 64);
    expect(msg!.text).toContain("[truncated");
  });
});
