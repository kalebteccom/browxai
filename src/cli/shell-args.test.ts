import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  parseCallArgs,
  parseToolsArgs,
  SESSION_ENV,
  SOCKET_ENV,
} from "./shell-args.js";

const call = (args: string[], env: Record<string, string | undefined> = {}) =>
  parseCallArgs(args, env);

function okCall(args: string[], env: Record<string, string | undefined> = {}) {
  const parsed = call(args, env);
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.message}`);
  return parsed.value;
}

describe("parseCallArgs", () => {
  it("takes the tool name, inline arguments and every flag", () => {
    const v = okCall([
      "click",
      '{"ref":"e7"}',
      "--socket",
      "/tmp/b.sock",
      "--session",
      "work",
      "--max-chars",
      "500",
      "--timeout",
      "2500",
      "--out",
      "shot.png",
      "--force",
    ]);
    expect(v).toEqual({
      tool: "click",
      argsText: '{"ref":"e7"}',
      argsFile: undefined,
      socket: "/tmp/b.sock",
      session: "work",
      maxChars: 500,
      timeoutMs: 2500,
      out: "shot.png",
      force: true,
    });
  });

  it("accepts --flag=value, and the flags before the tool name", () => {
    const v = okCall(["--socket=/tmp/b.sock", "snapshot", "--session=work"]);
    expect(v.tool).toBe("snapshot");
    expect(v.socket).toBe("/tmp/b.sock");
    expect(v.session).toBe("work");
  });

  it("treats a lone - as the standard input marker", () => {
    expect(okCall(["fill", "-"]).argsText).toBe("-");
  });

  it("defaults to the 40,000 character cap and accepts 0 for no cap", () => {
    expect(DEFAULT_MAX_CHARS).toBe(40_000);
    expect(okCall(["snapshot"]).maxChars).toBe(40_000);
    expect(okCall(["snapshot", "--max-chars", "0"]).maxChars).toBe(0);
  });

  it("waits 120 seconds by default, takes --timeout in milliseconds, and 0 means the longest wait", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(okCall(["snapshot"]).timeoutMs).toBe(120_000);
    expect(okCall(["snapshot", "--timeout", "900"]).timeoutMs).toBe(900);
    expect(okCall(["snapshot", "--timeout", "0"]).timeoutMs).toBe(MAX_TIMEOUT_MS);
    expect(MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
    expect(okCall(["snapshot", "--timeout", "99999999999999"]).timeoutMs).toBe(MAX_TIMEOUT_MS);
  });

  it("reads the socket and the session from the environment, and the flag wins", () => {
    const env = { [SOCKET_ENV]: "/tmp/env.sock", [SESSION_ENV]: "env-session" };
    expect(okCall(["snapshot"], env)).toMatchObject({
      socket: "/tmp/env.sock",
      session: "env-session",
    });
    expect(
      okCall(["snapshot", "--socket", "/tmp/flag.sock", "--session", "flag"], env),
    ).toMatchObject({ socket: "/tmp/flag.sock", session: "flag" });
  });

  it("has no default socket and no default session", () => {
    expect(okCall(["snapshot"]).socket).toBeUndefined();
    expect(okCall(["snapshot"]).session).toBeUndefined();
    expect(okCall(["snapshot"], { [SOCKET_ENV]: "  " }).socket).toBeUndefined();
  });

  it("accepts a plugin tool name", () => {
    expect(okCall(["example.echo"]).tool).toBe("example.echo");
  });

  it.each([
    [[], "missing TOOL"],
    [["--socket", "/tmp/b.sock"], "missing TOOL"],
    [["bad name"], "TOOL must be a tool name"],
    [["--bogus", "snapshot"], 'unknown argument "--bogus"'],
    [["snapshot", "-x"], 'unknown argument "-x"'],
    [["snapshot", "--socket"], "--socket needs a value"],
    [["snapshot", "--socket", "--json"], "--socket needs a value"],
    [["snapshot", "{}", "extra"], "one JSON object"],
    [["snapshot", "{}", "--args-file", "a.json"], "inline, on standard input, or in --args-file"],
    [["snapshot", "--max-chars", "ten"], "--max-chars takes a whole number"],
    [["snapshot", "--max-chars", "-5"], "--max-chars takes a whole number"],
    [["snapshot", "--timeout", "soon"], "--timeout takes whole milliseconds"],
    [["snapshot", "--timeout", "-1"], "--timeout takes whole milliseconds"],
    [["snapshot", "--timeout", "1.5"], "--timeout takes whole milliseconds"],
    [["snapshot", "--force"], "--force only applies with --out"],
  ])("refuses %j with a message naming the problem", (args, message) => {
    const parsed = call(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(message);
  });

  it("never echoes the text of a bad first argument", () => {
    const parsed = call(['{"password":"hunter2"}']);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).not.toContain("hunter2");
  });
});

describe("parseToolsArgs", () => {
  it("takes an optional name, --socket and --json", () => {
    expect(parseToolsArgs([], {})).toEqual({
      ok: true,
      value: { name: undefined, socket: undefined, json: false },
    });
    expect(parseToolsArgs(["click", "--json", "--socket", "/tmp/b.sock"], {})).toEqual({
      ok: true,
      value: { name: "click", socket: "/tmp/b.sock", json: true },
    });
  });

  it("falls back to BROWX_SOCKET", () => {
    const parsed = parseToolsArgs([], { [SOCKET_ENV]: "/tmp/env.sock" });
    expect(parsed.ok && parsed.value.socket).toBe("/tmp/env.sock");
  });

  it.each([
    [["a", "b"], "at most one tool name"],
    [["--bogus"], 'unknown argument "--bogus"'],
    [["--socket"], "--socket needs a value"],
    [["--json=1"], 'unknown argument "--json"'],
    [["bad name"], "TOOL must be a tool name"],
  ])("refuses %j", (args, message) => {
    const parsed = parseToolsArgs(args, {});
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain(message);
  });
});
