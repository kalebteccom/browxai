import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type InputSources,
  MAX_ARGS_BYTES,
  parseArgsObject,
  readArgsFile,
  readStdinText,
  resolveArgs,
} from "./shell-input.js";

const sources = (stdin = "", files: Record<string, string> = {}): InputSources => ({
  readStdin: () => Promise.resolve(stdin),
  readFile: (path) => {
    const text = files[path];
    if (text === undefined) throw new Error("ENOENT");
    return text;
  },
});

describe("parseArgsObject", () => {
  it("parses one JSON object", () => {
    expect(parseArgsObject('{"ref":"e7","n":2}')).toEqual({ ok: true, value: { ref: "e7", n: 2 } });
  });

  it("reads no text, or blank text, as an empty object", () => {
    expect(parseArgsObject("")).toEqual({ ok: true, value: {} });
    expect(parseArgsObject(" \n ")).toEqual({ ok: true, value: {} });
  });

  it.each([["[1,2]"], ["null"], ['"text"'], ["42"], ["true"]])(
    "refuses %s: the arguments must be one JSON object",
    (text) => {
      const parsed = parseArgsObject(text);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain("one JSON object");
    },
  );

  it("refuses invalid JSON without printing any of the text", () => {
    const parsed = parseArgsObject('{"token":"s3cr3t-value", oops}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("the arguments are not valid JSON");
      expect(parsed.message).not.toContain("s3cr3t-value");
      expect(parsed.message).not.toContain("oops");
    }
  });
});

describe("resolveArgs", () => {
  it("reads inline text, standard input and a file", async () => {
    const io = sources('{"from":"stdin"}', { "a.json": '{"from":"file"}' });
    const inline = await resolveArgs(
      { tool: "t", argsText: '{"from":"argv"}', argsFile: undefined },
      io,
    );
    expect(inline).toEqual({ ok: true, value: { from: "argv" } });
    const stdin = await resolveArgs({ tool: "t", argsText: "-", argsFile: undefined }, io);
    expect(stdin).toEqual({ ok: true, value: { from: "stdin" } });
    const file = await resolveArgs({ tool: "t", argsText: undefined, argsFile: "a.json" }, io);
    expect(file).toEqual({ ok: true, value: { from: "file" } });
  });

  it("means an empty object when no source is given", async () => {
    const none = await resolveArgs(
      { tool: "t", argsText: undefined, argsFile: undefined },
      sources(),
    );
    expect(none).toEqual({ ok: true, value: {} });
  });

  it("names a file it cannot read, and says nothing about its content", async () => {
    const res = await resolveArgs(
      { tool: "t", argsText: undefined, argsFile: "missing.json" },
      sources(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.message).toContain("could not read the arguments from the file missing.json");
  });

  it("refuses inline arguments for register_secret and names the standard input form", async () => {
    const res = await resolveArgs(
      { tool: "register_secret", argsText: '{"name":"PW","value":"hunter2"}', argsFile: undefined },
      sources(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).toContain("process listings");
      expect(res.message).toContain("standard input");
      expect(res.message).toContain("--args-file");
      expect(res.message).not.toContain("hunter2");
    }
  });

  it("lets register_secret take its arguments from standard input or a file", async () => {
    const body = '{"name":"PW","value":"hunter2"}';
    const stdin = await resolveArgs(
      { tool: "register_secret", argsText: "-", argsFile: undefined },
      sources(body),
    );
    expect(stdin).toEqual({ ok: true, value: { name: "PW", value: "hunter2" } });
    const file = await resolveArgs(
      { tool: "register_secret", argsText: undefined, argsFile: "s.json" },
      sources("", { "s.json": body }),
    );
    expect(file.ok).toBe(true);
  });
});

describe("reading files and standard input", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "brx-shell-input-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads a file as text and fails on a missing one", () => {
    const path = join(dir, "args.json");
    writeFileSync(path, '{"a":1}');
    expect(readArgsFile(path)).toBe('{"a":1}');
    expect(() => readArgsFile(join(dir, "nope.json"))).toThrow();
  });

  it("refuses a file over the size limit", () => {
    const path = join(dir, "big.json");
    writeFileSync(path, "x".repeat(MAX_ARGS_BYTES + 1));
    expect(() => readArgsFile(path)).toThrow("too large");
  });

  it("refuses a directory and a file over the limit by size, without reading it", () => {
    expect(() => readArgsFile(dir)).toThrow("not a regular file");
    const sub = join(dir, "sub");
    mkdirSync(sub);
    expect(() => readArgsFile(sub)).toThrow("not a regular file");
    // A sparse file reports its size without holding the bytes: the size check has to
    // fire from the stat, because reading it would build a 16 MiB string.
    const sparse = join(dir, "sparse.json");
    writeFileSync(sparse, "");
    truncateSync(sparse, MAX_ARGS_BYTES + 1);
    expect(() => readArgsFile(sparse)).toThrow("too large");
    const exact = join(dir, "exact.json");
    writeFileSync(exact, "");
    truncateSync(exact, MAX_ARGS_BYTES);
    expect(readArgsFile(exact)).toHaveLength(MAX_ARGS_BYTES);
  });

  it("collects standard input across chunks", async () => {
    const stream = Readable.from([Buffer.from('{"a":'), Buffer.from("1}")]);
    expect(await readStdinText(stream)).toBe('{"a":1}');
  });

  it("stops reading standard input past the size limit", async () => {
    const big = Buffer.alloc(MAX_ARGS_BYTES / 2 + 1, "x");
    const stream = Readable.from([big, big, big]);
    await expect(readStdinText(stream)).rejects.toThrow("too large");
  });
});
