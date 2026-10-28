import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAnswer,
  checkOperatorSocket,
  handshakeProof,
  proofMatches,
  takeOperatorEnv,
  type AnswerRules,
} from "./operator-protocol.js";

describe("takeOperatorEnv", () => {
  it.each([
    [
      "returns both values, trimmed, and removes them from the environment",
      {
        BROWX_OPERATOR_SOCKET: " /run/x/d.sock ",
        BROWX_OPERATOR_TOKEN: "t".repeat(32),
        KEEP: "1",
      },
      { socketPath: "/run/x/d.sock", token: "t".repeat(32) },
      { KEEP: "1" },
    ],
    [
      "treats blank values as unset and still removes them",
      { BROWX_OPERATOR_SOCKET: "  ", BROWX_OPERATOR_TOKEN: "" },
      { socketPath: undefined, token: undefined },
      {},
    ],
  ] as Array<[string, NodeJS.ProcessEnv, unknown, NodeJS.ProcessEnv]>)(
    "%s",
    (_label, env, taken, left) => {
      expect(takeOperatorEnv(env)).toEqual(taken);
      expect(env).toEqual(left);
    },
  );
});

describe("checkOperatorSocket", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanup.splice(0)) c();
  });

  function layout(opts: { dirMode?: number; sockMode?: number | null } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "bx-pc-"));
    chmodSync(dir, opts.dirMode ?? 0o700);
    const path = join(dir, "d.sock");
    let server: Server | undefined;
    const ready = (async () => {
      if (opts.sockMode === null) return;
      server = createServer();
      await new Promise<void>((r) => server!.listen(path, r));
      chmodSync(path, opts.sockMode ?? 0o600);
    })();
    cleanup.push(() => {
      server?.close();
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    });
    return { dir, path, ready };
  }

  it.each([
    ["accepts a 0600 socket in a 0700 directory", {}, { state: "ok" }],
    ["reports a missing socket as missing, not unsafe", { sockMode: null }, { state: "missing" }],
    [
      "refuses a directory that is not 0700",
      { dirMode: 0o750 },
      { state: "unsafe", reason: expect.stringContaining("0700") },
    ],
    [
      "refuses a socket that is not 0600",
      { sockMode: 0o660 },
      { state: "unsafe", reason: expect.stringContaining("0600") },
    ],
  ] as Array<[string, { dirMode?: number; sockMode?: number | null }, Record<string, unknown>]>)(
    "%s, and never puts the path in the result",
    async (_label, opts, expected) => {
      const l = layout(opts);
      await l.ready;
      const r = checkOperatorSocket(l.path);
      expect(r).toMatchObject(expected);
      expect(JSON.stringify(r)).not.toContain(l.dir);
    },
  );

  it("refuses a path that is not a socket", async () => {
    const l = layout({ sockMode: null });
    await l.ready;
    writeFileSync(l.path, "x", { mode: 0o600 });
    expect(checkOperatorSocket(l.path)).toMatchObject({ state: "unsafe" });
  });

  it("refuses a socket directory that is a symlink", async () => {
    const real = layout();
    await real.ready;
    const holder = mkdtempSync(join(tmpdir(), "bx-pc-"));
    cleanup.push(() => rmSync(holder, { recursive: true, force: true }));
    const link = join(holder, "link");
    symlinkSync(real.dir, link);
    expect(checkOperatorSocket(join(link, "d.sock"))).toMatchObject({ state: "unsafe" });
  });

  it.each([
    [
      "reports a missing directory as missing, so a restarting daemon can come back",
      join(tmpdir(), "bx-pc-nope-dir", "d.sock"),
      { state: "missing" },
    ],
    ["refuses a relative path", "d.sock", { state: "unsafe" }],
  ])("%s", (_label, path, expected) => {
    expect(checkOperatorSocket(path)).toMatchObject(expected);
  });
});

describe("handshake proofs", () => {
  const token = "k".repeat(32);

  it("matches only the same token, role and nonces", () => {
    const p = handshakeProof(token, "daemon", "aa", "bb");
    expect(proofMatches(p, handshakeProof(token, "daemon", "aa", "bb"))).toBe(true);
    expect(proofMatches(p, handshakeProof("z".repeat(32), "daemon", "aa", "bb"))).toBe(false);
    expect(proofMatches(p, handshakeProof(token, "browxai", "aa", "bb"))).toBe(false);
    expect(proofMatches(p, handshakeProof(token, "daemon", "aa", "bc"))).toBe(false);
  });

  it("rejects non-strings, bad hex and wrong lengths without throwing", () => {
    const p = handshakeProof(token, "daemon", "aa", "bb");
    for (const bad of [
      undefined,
      null,
      5,
      {},
      "",
      "zz",
      p.slice(2),
      p + "00",
      p.toUpperCase(),
      ` ${p.slice(1)}`,
    ]) {
      expect(proofMatches(p, bad)).toBe(false);
    }
  });
});

describe("checkAnswer", () => {
  const approval: AnswerRules = {
    answers: ["approve", "deny"],
    grantable: "navigate_off_allowlist",
  };
  const plainApproval: AnswerRules = { answers: ["approve", "deny"] };
  const human = (humanKind: AnswerRules["humanKind"], choiceCount = 0): AnswerRules => ({
    answers: ["done", "abort"],
    humanKind,
    choiceCount,
  });

  const grant = { scope: "session", ttlSeconds: 60 };
  const invalid = { ok: false, code: "invalid-answer" };
  const noGrant = { ok: false, code: "grant-not-allowed" };

  it.each<[string, AnswerRules, Record<string, unknown>, Record<string, unknown>]>([
    ["approval accepts approve", approval, { decision: "approve" }, { ok: true }],
    ["approval accepts deny", approval, { decision: "deny" }, { ok: true }],
    ["approval refuses a human decision", approval, { decision: "done" }, invalid],
    ["approval refuses an unknown decision", approval, { decision: "yes" }, { ok: false }],
    ["approval refuses a missing decision", approval, {}, { ok: false }],
    ["approval refuses a value", approval, { decision: "approve", value: true }, { ok: false }],
    ["human accepts done", human("acknowledge"), { decision: "done" }, { ok: true }],
    ["human accepts abort", human("acknowledge"), { decision: "abort" }, { ok: true }],
    ["human refuses approve", human("acknowledge"), { decision: "approve" }, { ok: false }],
    [
      "acknowledge refuses a value",
      human("acknowledge"),
      { decision: "done", value: 1 },
      { ok: false },
    ],
    [
      "confirm takes a boolean",
      human("confirm"),
      { decision: "done", value: true },
      { ok: true, value: true },
    ],
    [
      "confirm refuses a string",
      human("confirm"),
      { decision: "done", value: "yes" },
      { ok: false },
    ],
    ["confirm needs a value", human("confirm"), { decision: "done" }, { ok: false }],
    [
      "choose takes an index in range",
      human("choose", 2),
      { decision: "done", value: 1 },
      { ok: true },
    ],
    [
      "choose refuses an index past the end",
      human("choose", 2),
      { decision: "done", value: 2 },
      { ok: false },
    ],
    [
      "choose refuses a fractional index",
      human("choose", 2),
      { decision: "done", value: 0.5 },
      { ok: false },
    ],
    ["input takes a string", human("input"), { decision: "done", value: "x" }, { ok: true }],
    ["input refuses a number", human("input"), { decision: "done", value: 3 }, { ok: false }],
    ["a grant on a deny is refused", approval, { decision: "deny", grant }, noGrant],
    [
      "a grant on a plain approval is refused",
      plainApproval,
      { decision: "approve", grant },
      noGrant,
    ],
    [
      "a grant on a human request is refused",
      human("acknowledge"),
      { decision: "done", grant },
      noGrant,
    ],
  ])("%s", (_label, rules, answer, expected) => {
    const got = checkAnswer(rules, answer);
    if (expected.ok === false && "code" in expected) expect(got).toEqual(expected);
    else expect(got).toMatchObject(expected);
  });

  it("parses a session or workspace grant on an approve of a grantable request", () => {
    for (const scope of ["session", "workspace"] as const) {
      expect(
        checkAnswer(approval, { decision: "approve", grant: { scope, ttlSeconds: 900 } }),
      ).toEqual({
        ok: true,
        decision: "approve",
        value: undefined,
        grant: { scope, ttlSeconds: 900 },
      });
    }
  });

  it("refuses a global grant, an unknown scope and a missing scope", () => {
    for (const scope of ["global", "*", "all", "", undefined, 1]) {
      expect(
        checkAnswer(approval, { decision: "approve", grant: { scope, ttlSeconds: 60 } }),
      ).toEqual({ ok: false, code: "invalid-answer" });
    }
  });

  it("refuses a grant with a bad ttl", () => {
    for (const ttlSeconds of [0, -1, 86_401, 1.5, "60", undefined, Infinity, NaN]) {
      expect(
        checkAnswer(approval, { decision: "approve", grant: { scope: "session", ttlSeconds } }),
      ).toEqual({ ok: false, code: "invalid-answer" });
    }
    expect(
      checkAnswer(approval, {
        decision: "approve",
        grant: { scope: "workspace", ttlSeconds: 86_400 },
      }),
    ).toMatchObject({ ok: true });
  });
});
