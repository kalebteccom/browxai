// Diagnostics — unit tests covering:
//   1. recorder OFF: zero file IO + zero allocations beyond the gate check
//   2. recorder ON: a call lands as a JSONL record with the expected shape
//   3. secrets-masking composability: a registered secret echoed in args
//      lands as the masked alias, never raw
//   4. eval_js taxonomy classifier — every bucket
//   5. retention sweep removes ancient session dirs, keeps fresh ones
//   6. workspace-escape rejection: sessionId of `../escape` is refused

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  utimesSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DiagnosticsRecorder,
  classifyEvalExpr,
  redactArgs,
  resolveRetentionDays,
  sweepRetention,
  buildEvalJsCapture,
  buildReportSummary,
} from "./diagnostics.js";
import { SecretRegistry } from "./secrets.js";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "browx-diag-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("DiagnosticsRecorder gate-OFF", () => {
  it("write() short-circuits to no-op when disabled — no file IO", () => {
    const rec = new DiagnosticsRecorder({ enabled: false, workspaceRoot: workspace });
    rec.write({
      kind: "call",
      ts: "2026-06-08T00:00:00.000Z",
      tool: "snapshot",
      sessionId: "default",
      argsRedacted: {},
      resultMeta: { ok: true, sizeBytes: 0, warningsCount: 0 },
      durationMs: 0,
      capabilityDenials: 0,
    });
    // workspace must remain empty — no `diagnostics/` subdir written
    expect(existsSync(join(workspace, "diagnostics"))).toBe(false);
  });

  it("noteDenial() is a no-op when disabled", () => {
    const rec = new DiagnosticsRecorder({ enabled: false, workspaceRoot: workspace });
    rec.noteDenial();
    rec.noteDenial();
    expect(rec.denialsCount()).toBe(0);
  });

  it("write() makes ZERO filesystem mutations when disabled", () => {
    // The recorder's gate-OFF contract: zero allocations beyond the gate
    // check, zero file IO. We assert the negative directly — after a
    // write attempt, the workspace contents are byte-identical to before.
    const before = readdirSync(workspace);
    const rec = new DiagnosticsRecorder({ enabled: false, workspaceRoot: workspace });
    for (let i = 0; i < 50; i++) {
      rec.write({
        kind: "note",
        ts: "2026-06-08T00:00:00.000Z",
        sessionId: "default",
        insight: "x",
        category: "other",
        severity: "info",
      });
    }
    const after = readdirSync(workspace);
    expect(after.sort()).toEqual(before.sort());
  });
});

describe("DiagnosticsRecorder gate-ON", () => {
  it("writes a JSONL line under <workspace>/diagnostics/<sessionId>/<iso>.jsonl", () => {
    const rec = new DiagnosticsRecorder({
      enabled: true,
      workspaceRoot: workspace,
      serverStartIso: "2026-06-08T00-00-00-000Z",
    });
    rec.write({
      kind: "call",
      ts: "2026-06-08T00:00:01.000Z",
      tool: "snapshot",
      sessionId: "default",
      argsRedacted: { scope: "e1" },
      resultMeta: { ok: true, sizeBytes: 42, warningsCount: 0 },
      durationMs: 12,
      capabilityDenials: 0,
    });
    const dir = join(workspace, "diagnostics", "default");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0]!), "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj.tool).toBe("snapshot");
    expect(obj.resultMeta.sizeBytes).toBe(42);
  });

  it("noteDenial() increments the counter", () => {
    const rec = new DiagnosticsRecorder({ enabled: true, workspaceRoot: workspace });
    rec.noteDenial();
    rec.noteDenial();
    expect(rec.denialsCount()).toBe(2);
  });

  it("readAll() returns appended records in order", () => {
    const rec = new DiagnosticsRecorder({
      enabled: true,
      workspaceRoot: workspace,
      serverStartIso: "2026-06-08T00-00-00-000Z",
    });
    for (let i = 0; i < 3; i++) {
      rec.write({
        kind: "call",
        ts: `2026-06-08T00:00:0${i}.000Z`,
        tool: i % 2 === 0 ? "snapshot" : "find",
        sessionId: "default",
        argsRedacted: {},
        resultMeta: { ok: true, sizeBytes: 0, warningsCount: 0 },
        durationMs: i,
        capabilityDenials: 0,
      });
    }
    const all = rec.readAll();
    expect(all).toHaveLength(3);
    expect(all.map((r) => (r.kind === "call" ? r.tool : r.kind))).toEqual([
      "snapshot",
      "find",
      "snapshot",
    ]);
  });
});

describe("secrets-masking composability", () => {
  it("a registered secret echoed in args lands masked, never raw", () => {
    // 1. register a secret
    const secrets = new SecretRegistry();
    secrets.register({ name: "PASSWORD", value: "hunter2-real-password" });
    // 2. the args carry the raw value (simulating what would happen if a
    //    careless caller passed the materialised value instead of the alias).
    const rawArgs = { selector: "#pw", value: "hunter2-real-password" };
    // 3. the dispatch wrapper applies the same `applyMaskDeep` the egress
    //    sinks use BEFORE structural redaction
    const masked = secrets.applyMaskDeep(rawArgs);
    const redacted = redactArgs(masked);
    // 4. the redacted shape MUST NOT contain the raw value anywhere
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain("hunter2-real-password");
    expect(serialised).toContain("<PASSWORD>");
  });

  it("end-to-end: enabled recorder + secret mask → JSONL does not carry raw value", () => {
    const rec = new DiagnosticsRecorder({
      enabled: true,
      workspaceRoot: workspace,
      serverStartIso: "2026-06-08T00-00-00-000Z",
    });
    const secrets = new SecretRegistry();
    secrets.register({ name: "OTP", value: "012345-real-otp" });
    const args = { key: "012345-real-otp" };
    const masked = secrets.applyMaskDeep(args);
    rec.write({
      kind: "call",
      ts: "2026-06-08T00:00:01.000Z",
      tool: "press",
      sessionId: "default",
      argsRedacted: redactArgs(masked),
      resultMeta: { ok: true, sizeBytes: 0, warningsCount: 0 },
      durationMs: 0,
      capabilityDenials: 0,
    });
    const dir = join(workspace, "diagnostics", "default");
    const files = readdirSync(dir);
    const content = readFileSync(join(dir, files[0]!), "utf8");
    expect(content).not.toContain("012345-real-otp");
    expect(content).toContain("<OTP>");
  });
});

describe("classifyEvalExpr taxonomy", () => {
  it("dom-query matches querySelector / getElementBy* / closest / matches", () => {
    expect(classifyEvalExpr("document.querySelector('.x')")).toBe("dom-query");
    expect(classifyEvalExpr("document.getElementById('foo')")).toBe("dom-query");
    expect(classifyEvalExpr("el.closest('div')")).toBe("dom-query");
    expect(classifyEvalExpr("el.matches('.bar')")).toBe("dom-query");
  });

  it("storage-access matches localStorage / sessionStorage / indexedDB / caches / cookies", () => {
    expect(classifyEvalExpr("localStorage.getItem('x')")).toBe("storage-access");
    expect(classifyEvalExpr("sessionStorage.length")).toBe("storage-access");
    expect(classifyEvalExpr("indexedDB.open('app', 1)")).toBe("storage-access");
    expect(classifyEvalExpr("caches.keys()")).toBe("storage-access");
    expect(classifyEvalExpr("document.cookie")).toBe("storage-access");
  });

  it("computed-style matches getComputedStyle / getBoundingClientRect / offset/client/scroll dims", () => {
    expect(classifyEvalExpr("getComputedStyle(el)")).toBe("computed-style");
    expect(classifyEvalExpr("el.getBoundingClientRect()")).toBe("computed-style");
    expect(classifyEvalExpr("el.offsetWidth")).toBe("computed-style");
    expect(classifyEvalExpr("el.scrollHeight")).toBe("computed-style");
  });

  it("callback-trigger matches .click()/.focus()/.blur()/.dispatchEvent/.submit()", () => {
    expect(classifyEvalExpr("btn.click()")).toBe("callback-trigger");
    expect(classifyEvalExpr("input.focus()")).toBe("callback-trigger");
    expect(classifyEvalExpr("input.blur()")).toBe("callback-trigger");
    expect(classifyEvalExpr("el.dispatchEvent(new Event('x'))")).toBe("callback-trigger");
    expect(classifyEvalExpr("form.submit()")).toBe("callback-trigger");
  });

  it("feature-detect matches typeof window./navigator. and 'X' in window/navigator", () => {
    expect(classifyEvalExpr("typeof window.ResizeObserver")).toBe("feature-detect");
    expect(classifyEvalExpr("typeof navigator.bluetooth")).toBe("feature-detect");
    expect(classifyEvalExpr("'serial' in navigator")).toBe("feature-detect");
    expect(classifyEvalExpr("window.WebAssembly !== undefined")).toBe("feature-detect");
  });

  it("custom catches everything else", () => {
    expect(classifyEvalExpr("Math.random()")).toBe("custom");
    expect(classifyEvalExpr("1 + 1")).toBe("custom");
    expect(classifyEvalExpr("foo.bar(baz)")).toBe("custom");
  });
});

describe("redactArgs", () => {
  it("replaces large/sensitive payload fields with sha256 + byteLength", () => {
    // body of >=512 bytes triggers the BIG_BLOB redact path
    const out = redactArgs({ tool: "x", body: "very long body content".repeat(100) });
    expect(out.tool).toBe("x");
    const redacted = out.body as { __redacted: boolean; sha256: string; byteLength: number };
    expect(redacted.__redacted).toBe(true);
    expect(redacted.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(redacted.byteLength).toBeGreaterThan(0);
  });

  it("keeps small payload-field strings inline (debuggability)", () => {
    // small `value` (under the 512-byte threshold) passes through the
    // standard truncation path so a `<NAME>` alias remains readable in
    // the JSONL.
    const out = redactArgs({ value: "<PASSWORD>" });
    expect(out.value).toBe("<PASSWORD>");
  });

  it("truncates long strings with a length suffix", () => {
    const long = "x".repeat(500);
    const out = redactArgs({ selector: long });
    expect(typeof out.selector).toBe("string");
    expect((out.selector as string).endsWith("…[+244]")).toBe(true);
  });

  it("summarises arrays without inlining their contents", () => {
    const out = redactArgs({ items: [1, 2, 3, 4, 5] });
    expect(out.items).toEqual({ __array: true, length: 5 });
  });

  it("passes through primitives + null", () => {
    const out = redactArgs({ a: 1, b: true, c: null });
    expect(out).toEqual({ a: 1, b: true, c: null });
  });
});

describe("buildEvalJsCapture", () => {
  it("returns undefined for non-eval tools", () => {
    expect(buildEvalJsCapture("snapshot", { expr: "x" }, null)).toBeUndefined();
  });

  it("returns the SHA + head + taxonomy for eval_js calls", () => {
    const cap = buildEvalJsCapture(
      "eval_js",
      { expr: "document.querySelector('#foo')" },
      { ok: true, value: "<div>" },
    );
    expect(cap).toBeDefined();
    expect(cap!.taxonomy).toBe("dom-query");
    expect(cap!.exprSha).toMatch(/^[0-9a-f]{64}$/);
    expect(cap!.exprHead.startsWith("document.querySelector")).toBe(true);
    expect(cap!.returnType).toBe("string");
  });

  it("covers poll_eval too (same posture as eval_js)", () => {
    const cap = buildEvalJsCapture("poll_eval", { expr: "typeof navigator.bluetooth" }, null);
    expect(cap?.taxonomy).toBe("feature-detect");
  });
});

describe("retention sweep", () => {
  it("removes session dirs whose newest file is older than the window", () => {
    const root = join(workspace, "diagnostics");
    mkdirSync(join(root, "fresh"), { recursive: true });
    mkdirSync(join(root, "ancient"), { recursive: true });
    writeFileSync(join(root, "fresh", "a.jsonl"), "{}\n");
    writeFileSync(join(root, "ancient", "a.jsonl"), "{}\n");
    // backdate the ancient file by 40 days
    const past = Date.now() - 40 * 24 * 60 * 60 * 1000;
    utimesSync(join(root, "ancient", "a.jsonl"), past / 1000, past / 1000);
    const { removed, kept } = sweepRetention(workspace, 30);
    expect(removed).toContain("ancient");
    expect(kept).toContain("fresh");
    expect(existsSync(join(root, "ancient"))).toBe(false);
    expect(existsSync(join(root, "fresh"))).toBe(true);
  });

  it("is a no-op when retentionDays is 0 (sweep disabled)", () => {
    const root = join(workspace, "diagnostics");
    mkdirSync(join(root, "ancient"), { recursive: true });
    writeFileSync(join(root, "ancient", "a.jsonl"), "{}\n");
    const past = Date.now() - 1000 * 24 * 60 * 60 * 1000;
    utimesSync(join(root, "ancient", "a.jsonl"), past / 1000, past / 1000);
    const { removed } = sweepRetention(workspace, 0);
    expect(removed).toHaveLength(0);
    expect(existsSync(join(root, "ancient"))).toBe(true);
  });
});

describe("workspace-escape rejection", () => {
  it("a sessionId of `../escape` does NOT write outside the diagnostics subdir", () => {
    const rec = new DiagnosticsRecorder({
      enabled: true,
      workspaceRoot: workspace,
      serverStartIso: "2026-06-08T00-00-00-000Z",
    });
    // Snapshot the workspace contents BEFORE the call. We allow the
    // call to fall through silently (the contract is: the call still
    // runs, only the recording is skipped — see diagnostics.ts module
    // header). What we MUST verify is that nothing was written outside
    // the workspace.
    const before = readdirSync(workspace);
    rec.write({
      kind: "call",
      ts: "2026-06-08T00:00:01.000Z",
      tool: "snapshot",
      sessionId: "../escape",
      argsRedacted: {},
      resultMeta: { ok: true, sizeBytes: 0, warningsCount: 0 },
      durationMs: 0,
      capabilityDenials: 0,
    });
    const after = readdirSync(workspace);
    expect(after.sort()).toEqual(before.sort());
    // The parent of the workspace must not contain an "escape" dir
    // freshly written by the recorder.
    const parent = join(workspace, "..");
    const escapeDir = join(parent, "escape");
    expect(existsSync(escapeDir)).toBe(false);
  });
});

describe("resolveRetentionDays", () => {
  it("defaults to 30 when env unset", () => {
    expect(resolveRetentionDays({})).toBe(30);
  });

  it("honours BROWX_DIAGNOSTICS_RETENTION_DAYS", () => {
    expect(
      resolveRetentionDays({ BROWX_DIAGNOSTICS_RETENTION_DAYS: "7" } as NodeJS.ProcessEnv),
    ).toBe(7);
    expect(
      resolveRetentionDays({ BROWX_DIAGNOSTICS_RETENTION_DAYS: "0" } as NodeJS.ProcessEnv),
    ).toBe(0);
  });

  it("falls back to default on garbage input (no throw)", () => {
    expect(
      resolveRetentionDays({ BROWX_DIAGNOSTICS_RETENTION_DAYS: "garbage" } as NodeJS.ProcessEnv),
    ).toBe(30);
    expect(
      resolveRetentionDays({ BROWX_DIAGNOSTICS_RETENTION_DAYS: "-3" } as NodeJS.ProcessEnv),
    ).toBe(30);
  });
});

describe("buildReportSummary", () => {
  it("rolls up per-tool counts + p50/p95 + flags missing-primitive hypotheses", () => {
    const now = "2026-06-08T00:00:00.000Z";
    const records: import("./diagnostics.js").DiagnosticsRecord[] = [];
    // 3 snapshot calls (one error)
    for (let i = 0; i < 3; i++) {
      records.push({
        kind: "call",
        ts: now,
        tool: "snapshot",
        sessionId: "default",
        argsRedacted: {},
        resultMeta:
          i === 0
            ? { ok: false, sizeBytes: 10, warningsCount: 0, failureKind: "target-not-found" }
            : { ok: true, sizeBytes: 10, warningsCount: 0 },
        durationMs: 10 + i * 5,
        capabilityDenials: 0,
      });
    }
    // 4 eval_js dom-query patterns
    for (let i = 0; i < 4; i++) {
      records.push({
        kind: "call",
        ts: now,
        tool: "eval_js",
        sessionId: "default",
        argsRedacted: {},
        resultMeta: { ok: true, sizeBytes: 5, warningsCount: 0 },
        durationMs: 1,
        capabilityDenials: 0,
        evalJs: {
          exprSha: "a".repeat(64),
          exprHead: "document.querySelector('#x')",
          returnType: "string",
          returnSizeBytes: 3,
          taxonomy: "dom-query",
        },
      });
    }
    // 2 notes
    records.push({
      kind: "note",
      ts: now,
      sessionId: "default",
      insight: "miss",
      category: "missing-primitive",
      severity: "warn",
    });
    records.push({
      kind: "note",
      ts: now,
      sessionId: "default",
      insight: "wa",
      category: "workaround",
      severity: "info",
    });

    const summary = buildReportSummary(records);
    expect(summary.perTool.snapshot?.count).toBe(3);
    expect(summary.perTool.snapshot?.failureCount).toBe(1);
    expect(summary.perTool.eval_js?.count).toBe(4);
    expect(summary.topEvalJsPatterns).toHaveLength(1);
    expect(summary.topEvalJsPatterns[0]?.count).toBe(4);
    expect(summary.notesByCategory["missing-primitive"]).toBe(1);
    // dom-query has count 4 ≥ 3 → flagged
    expect(summary.missingPrimitiveHypotheses.some((h) => h.taxonomy === "dom-query")).toBe(true);
  });

  it("`since` filters records strictly", () => {
    const records: import("./diagnostics.js").DiagnosticsRecord[] = [
      {
        kind: "call",
        ts: "2026-06-01T00:00:00.000Z",
        tool: "snapshot",
        sessionId: "default",
        argsRedacted: {},
        resultMeta: { ok: true, sizeBytes: 0, warningsCount: 0 },
        durationMs: 0,
        capabilityDenials: 0,
      },
      {
        kind: "call",
        ts: "2026-06-10T00:00:00.000Z",
        tool: "find",
        sessionId: "default",
        argsRedacted: {},
        resultMeta: { ok: true, sizeBytes: 0, warningsCount: 0 },
        durationMs: 0,
        capabilityDenials: 0,
      },
    ];
    const summary = buildReportSummary(records, { since: "2026-06-05T00:00:00.000Z" });
    expect(summary.perTool.snapshot).toBeUndefined();
    expect(summary.perTool.find?.count).toBe(1);
  });
});
