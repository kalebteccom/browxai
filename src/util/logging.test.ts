import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log, LOG_MASK_FAILED, setLogMask } from "./logging.js";

/** Everything the logger wrote, one string per `process.stderr.write` call. */
let written: string[];

beforeEach(() => {
  written = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  setLogMask(null);
  vi.restoreAllMocks();
});

const VALUE = "s3cret-value";
const maskValue = (text: string): string => text.split(VALUE).join("<TOKEN>");

describe("log: with no mask installed", () => {
  it("writes the message and fields as given", () => {
    log.info(`hello ${VALUE}`, { a: 1, v: VALUE });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] info browxai: hello s3cret-value \{"a":1,"v":"s3cret-value"\}\n$/,
    );
  });

  it("writes no field tail for a call without fields or with empty fields", () => {
    log.warn("plain");
    log.error("empty", {});
    expect(written[0]).toMatch(/ warn browxai: plain\n$/);
    expect(written[1]).toMatch(/ error browxai: empty\n$/);
  });
});

describe("log: with a mask installed", () => {
  it("masks the message and the serialised fields", () => {
    setLogMask(maskValue);
    log.warn(`got ${VALUE}`, { v: VALUE, nested: { deep: [`x ${VALUE} y`] } });
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain(VALUE);
    expect(written[0]).toMatch(
      / warn browxai: got <TOKEN> \{"v":"<TOKEN>","nested":\{"deep":\["x <TOKEN> y"\]\}\}\n$/,
    );
  });

  it.each(["info", "warn", "error"] as const)("masks at level %s", (level) => {
    setLogMask(maskValue);
    log[level](`value ${VALUE}`);
    expect(written[0]).toContain(` ${level} browxai: value <TOKEN>\n`);
    expect(written[0]).not.toContain(VALUE);
  });

  it("masks every line of a multi-line message in one write", () => {
    setLogMask(maskValue);
    log.info(`line one\nvalue ${VALUE}\n    [0] ${VALUE}\nline four`);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(
      / info browxai: line one\nvalue <TOKEN>\n {4}\[0\] <TOKEN>\nline four\n$/,
    );
  });

  it("hands the mask the message and field tail, without the timestamp and level", () => {
    const mask = vi.fn((text: string) => text.toUpperCase());
    setLogMask(mask);
    log.info("msg", { k: 1 });
    expect(mask).toHaveBeenCalledTimes(1);
    expect(mask).toHaveBeenCalledWith('msg {"k":1}');
    expect(written[0]).toMatch(/^\[\d{4}-[^\]]+Z\] info browxai: MSG \{"K":1\}\n$/);
  });

  it("goes back to writing entries as given after setLogMask(null)", () => {
    setLogMask(maskValue);
    setLogMask(null);
    log.info(`again ${VALUE}`);
    expect(written[0]).toContain(`again ${VALUE}`);
  });

  it("the last mask installed replaces the one before it", () => {
    setLogMask(maskValue);
    setLogMask((text) => text.split("other").join("<OTHER>"));
    log.info(`other ${VALUE}`);
    expect(written[0]).toContain(`<OTHER> ${VALUE}`);
  });

  it("withholds the entry when the mask throws", () => {
    setLogMask(() => {
      throw new Error("mask broke");
    });
    log.error(`lost ${VALUE}`, { v: VALUE });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(` error browxai: ${LOG_MASK_FAILED}\n`);
    expect(written[0]).not.toContain(VALUE);
  });
});
