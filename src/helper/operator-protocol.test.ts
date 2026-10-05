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
  it("returns both values and removes them from the environment", () => {
    const env: NodeJS.ProcessEnv = {
      BROWX_OPERATOR_SOCKET: " /run/x/d.sock ",
      BROWX_OPERATOR_TOKEN: "t".repeat(32),
      KEEP: "1",
    };
    expect(takeOperatorEnv(env)).toEqual({ socketPath: "/run/x/d.sock", token: "t".repeat(32) });
    expect(env).toEqual({ KEEP: "1" });
  });

  it("treats blank values as unset and still removes them", () => {
    const env: NodeJS.ProcessEnv = { BROWX_OPERATOR_SOCKET: "  ", BROWX_OPERATOR_TOKEN: "" };
    expect(takeOperatorEnv(env)).toEqual({ socketPath: undefined, token: undefined });
    expect(Object.keys(env)).toEqual([]);
  });
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

  it("accepts a 0600 socket in a 0700 directory", async () => {
    const l = layout();
    await l.ready;
    expect(checkOperatorSocket(l.path)).toEqual({ state: "ok" });
  });

  it("reports a missing socket as missing, not unsafe", async () => {
    const l = layout({ sockMode: null });
    await l.ready;
    expect(checkOperatorSocket(l.path)).toEqual({ state: "missing" });
  });

  it("reports a missing directory as missing, so a restarting daemon can come back", () => {
    expect(checkOperatorSocket(join(tmpdir(), "bx-pc-nope-dir", "d.sock"))).toEqual({
      state: "missing",
    });
  });

  it("refuses a directory that is not 0700", async () => {
    const l = layout({ dirMode: 0o750 });
    await l.ready;
    expect(checkOperatorSocket(l.path)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining("0700"),
    });
  });

  it("refuses a socket that is not 0600", async () => {
    const l = layout({ sockMode: 0o660 });
    await l.ready;
    expect(checkOperatorSocket(l.path)).toMatchObject({
      state: "unsafe",
      reason: expect.stringContaining("0600"),
    });
  });

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

  it("refuses a relative path", () => {
    expect(checkOperatorSocket("d.sock")).toMatchObject({ state: "unsafe" });
  });

  it("never puts the path in the reason", async () => {
    const l = layout({ dirMode: 0o755 });
    await l.ready;
    const r = checkOperatorSocket(l.path);
    expect(JSON.stringify(r)).not.toContain(l.dir);
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
    for (const bad of [undefined, null, 5, {}, "", "zz", p.slice(2), p + "00"]) {
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

  it("accepts approve and deny on an approval, and nothing else", () => {
    expect(checkAnswer(approval, { decision: "approve" })).toMatchObject({ ok: true });
    expect(checkAnswer(approval, { decision: "deny" })).toMatchObject({ ok: true });
    expect(checkAnswer(approval, { decision: "done" })).toEqual({
      ok: false,
      code: "invalid-answer",
    });
    expect(checkAnswer(approval, { decision: "yes" })).toMatchObject({ ok: false });
    expect(checkAnswer(approval, {})).toMatchObject({ ok: false });
  });

  it("accepts done and abort on a human request, and not approve", () => {
    expect(checkAnswer(human("acknowledge"), { decision: "done" })).toMatchObject({ ok: true });
    expect(checkAnswer(human("acknowledge"), { decision: "abort" })).toMatchObject({ ok: true });
    expect(checkAnswer(human("acknowledge"), { decision: "approve" })).toMatchObject({ ok: false });
  });

  it("checks the value against the human kind", () => {
    expect(checkAnswer(human("confirm"), { decision: "done", value: true })).toMatchObject({
      ok: true,
      value: true,
    });
    expect(checkAnswer(human("confirm"), { decision: "done", value: "yes" })).toMatchObject({
      ok: false,
    });
    expect(checkAnswer(human("confirm"), { decision: "done" })).toMatchObject({ ok: false });
    expect(checkAnswer(human("choose", 2), { decision: "done", value: 1 })).toMatchObject({
      ok: true,
    });
    expect(checkAnswer(human("choose", 2), { decision: "done", value: 2 })).toMatchObject({
      ok: false,
    });
    expect(checkAnswer(human("choose", 2), { decision: "done", value: 0.5 })).toMatchObject({
      ok: false,
    });
    expect(checkAnswer(human("input"), { decision: "done", value: "x" })).toMatchObject({
      ok: true,
    });
    expect(checkAnswer(human("input"), { decision: "done", value: 3 })).toMatchObject({
      ok: false,
    });
    expect(checkAnswer(human("acknowledge"), { decision: "done", value: 1 })).toMatchObject({
      ok: false,
    });
    expect(checkAnswer(approval, { decision: "approve", value: true })).toMatchObject({
      ok: false,
    });
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

  it("refuses a grant on a deny, and on a request that cannot carry one", () => {
    const grant = { scope: "session", ttlSeconds: 60 };
    expect(checkAnswer(approval, { decision: "deny", grant })).toEqual({
      ok: false,
      code: "grant-not-allowed",
    });
    expect(checkAnswer(plainApproval, { decision: "approve", grant })).toEqual({
      ok: false,
      code: "grant-not-allowed",
    });
    expect(checkAnswer(human("acknowledge"), { decision: "done", grant })).toEqual({
      ok: false,
      code: "grant-not-allowed",
    });
  });
});
