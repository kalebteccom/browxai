import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLogMask, clearLogMasks, log, LOG_MASK_FAILED } from "./logging.js";

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
  clearLogMasks();
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
    addLogMask(maskValue);
    log.warn(`got ${VALUE}`, { v: VALUE, nested: { deep: [`x ${VALUE} y`] } });
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain(VALUE);
    expect(written[0]).toMatch(
      / warn browxai: got <TOKEN> \{"v":"<TOKEN>","nested":\{"deep":\["x <TOKEN> y"\]\}\}\n$/,
    );
  });

  it.each(["info", "warn", "error"] as const)("masks at level %s", (level) => {
    addLogMask(maskValue);
    log[level](`value ${VALUE}`);
    expect(written[0]).toContain(` ${level} browxai: value <TOKEN>\n`);
    expect(written[0]).not.toContain(VALUE);
  });

  it("masks every line of a multi-line message in one write", () => {
    addLogMask(maskValue);
    log.info(`line one\nvalue ${VALUE}\n    [0] ${VALUE}\nline four`);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(
      / info browxai: line one\nvalue <TOKEN>\n {4}\[0\] <TOKEN>\nline four\n$/,
    );
  });

  it("hands the mask the message and field tail, without the timestamp and level", () => {
    const mask = vi.fn((text: string) => text.toUpperCase());
    addLogMask(mask);
    log.info("msg", { k: 1 });
    expect(mask).toHaveBeenCalledTimes(1);
    expect(mask).toHaveBeenCalledWith('msg {"k":1}');
    expect(written[0]).toMatch(/^\[\d{4}-[^\]]+Z\] info browxai: MSG \{"K":1\}\n$/);
  });

  it("goes back to writing entries as given once the mask is removed", () => {
    const remove = addLogMask(maskValue);
    remove();
    log.info(`again ${VALUE}`);
    expect(written[0]).toContain(`again ${VALUE}`);
  });

  it("removing a mask twice is harmless", () => {
    const remove = addLogMask(maskValue);
    remove();
    remove();
    log.info(`again ${VALUE}`);
    expect(written[0]).toContain(`again ${VALUE}`);
  });

  it("withholds the entry when the mask throws", () => {
    addLogMask(() => {
      throw new Error("mask broke");
    });
    log.error(`lost ${VALUE}`, { v: VALUE });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(` error browxai: ${LOG_MASK_FAILED}\n`);
    expect(written[0]).not.toContain(VALUE);
  });
});

describe("log: two masks in one process", () => {
  const OTHER = "0ther-value";
  const maskOther = (text: string): string => text.split(OTHER).join("<OTHER>");

  it("a second mask adds to the first and does not replace it", () => {
    addLogMask(maskValue);
    addLogMask(maskOther);
    log.info(`a ${VALUE} b ${OTHER}`, { first: VALUE, second: OTHER });
    expect(written[0]).toContain('a <TOKEN> b <OTHER> {"first":"<TOKEN>","second":"<OTHER>"}');
    expect(written[0]).not.toContain(VALUE);
    expect(written[0]).not.toContain(OTHER);
  });

  it("runs the masks in the order they were added, each on the previous one's output", () => {
    const seen: string[] = [];
    addLogMask((text) => {
      seen.push(text);
      return `${text}+1`;
    });
    addLogMask((text) => {
      seen.push(text);
      return `${text}+2`;
    });
    log.info("m");
    expect(seen).toEqual(["m", "m+1"]);
    expect(written[0]).toContain(" info browxai: m+1+2\n");
  });

  it("removing one mask leaves the other in place, whichever was added first", () => {
    const removeFirst = addLogMask(maskValue);
    const removeSecond = addLogMask(maskOther);
    removeFirst();
    log.info(`a ${VALUE} b ${OTHER}`);
    expect(written[0]).toContain(`a ${VALUE} b <OTHER>`);
    removeSecond();
    const removeAgain = addLogMask(maskValue);
    addLogMask(maskOther);
    removeAgain();
    log.info(`c ${VALUE} d ${OTHER}`);
    expect(written[1]).toContain(`c ${VALUE} d <OTHER>`);
  });

  it("withholds the entry when any one mask throws", () => {
    addLogMask(maskValue);
    addLogMask(() => {
      throw new Error("mask broke");
    });
    log.info(`lost ${VALUE}`);
    expect(written[0]).toContain(LOG_MASK_FAILED);
    expect(written[0]).not.toContain(VALUE);
  });
});
