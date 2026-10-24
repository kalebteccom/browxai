// L7 (bounded everything) — the bounded-resource budget tests. RFC 0004 P5 / 02
// §4.2. Each test EXHIBITS a named bound rather than reading the constant and
// asserting it equals itself (a tautology a refactor would update in lockstep):
// it drives the resource past its cap and asserts the contained behaviour, so
// removing the guard fails the test for the right reason (the "exhibit the bound"
// discipline, 02 §4.2). These are `error`-level — the budget tests promote with
// the phase; the bounded-resource LINT rule stays advisory `warn` (it is a
// halting-problem heuristic, 0004-05 §1.3).
//
// The two gaps the audit named are the headline cases:
//   * perf-audit `enforceSummaryBudget` — the one loop in the bounded inventory
//     that lacked an explicit iteration cap; now bounded + a hard 2.5× size
//     ceiling. Exercised on an ADVERSARIAL report (termination + the ceiling).
//   * the a11y tree-walk depth — iterative but with no declared depth cap; now
//     `MAX_WALK_DEPTH`. Exercised with a tree deeper than the cap.
// The network ring (already capped at 500) is pinned too, so a refactor that
// dropped its eviction is caught here.

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Frame, Page, Request, Response } from "playwright-core";
import { PlaywrightNetworkBuffer } from "../../src/page/network-playwright.js";
import { ConsoleBuffer, MAX_CONSOLE_MESSAGE_CHARS } from "../../src/page/console.js";
import {
  DownloadsRegistry,
  MAX_DOWNLOAD_GET_BYTES,
  readCapturedBytes,
} from "../../src/page/downloads.js";
import { SocketTransport } from "../../src/transport/socket-transport.js";
import {
  composeReport,
  enforceSummaryBudget,
  SUMMARY_TOKEN_HARD_CEILING,
  type AuditReport,
  type AuditContext,
} from "../../src/page/perf-audit.js";
import { estimateTokens } from "../../src/util/tokens.js";
import { walk, MAX_WALK_DEPTH, type A11yNode } from "../../src/page/a11y.js";
import { NetworkBuffer } from "../../src/page/network.js";
import { WorkersSwChannel } from "../../src/page/workers-sw.js";
import { materialiseValue } from "../../src/page/actions-secrets.js";
import type { ActionContext } from "../../src/page/actionresult.js";
import { assetExport } from "../../src/page/asset-export.js";
import { submitToProvider, type CaptchaProviderConfig } from "../../src/page/solve-captcha.js";
import { MAX_UNWRAP_DEPTH, safeUrl, unwrapOrigin } from "../../src/util/origin-unwrap.js";
import { isOriginAllowed, resolveOriginPolicy } from "../../src/policy/origin.js";

// ── perf-audit token budget — termination + the ≤ 2.5× ceiling ───────────────

/** Build an adversarial summary report: many high-severity issues with long
 *  titles across every category, so the soft 2000-token budget is blown by a wide
 *  margin and the trim loops + the hard-ceiling truncation are forced to run to
 *  the end. High severity means the low/medium severity passes can't trim it —
 *  only the aggressive trim + the hard ceiling can. */
function adversarialReport(issuesPerCategory: number, titleLen: number): AuditReport {
  const longTitle = "X".repeat(titleLen);
  const categories = [
    "render-blocking",
    "unused-code",
    "oversize-images",
    "layout-thrashing",
    "long-tasks",
    "leak-suspects",
    "cache-opportunities",
    "font-loading",
  ] as const;
  const byCategory: AuditReport["byCategory"] = {};
  const topIssues: AuditReport["summary"]["topIssues"] = [];
  for (const cat of categories) {
    const issues = Array.from({ length: issuesPerCategory }, (_, i) => ({
      category: cat,
      severity: "high" as const,
      title: `${longTitle}-${cat}-${i}`,
    }));
    byCategory[cat] = {
      issues,
      remediations: issues.map((_, i) => ({ category: cat, action: `${longTitle}-fix-${i}` })),
    };
    for (const iss of issues) {
      topIssues.push({ category: iss.category, severity: iss.severity, title: iss.title });
    }
  }
  return { summary: { score: 0, topIssues }, byCategory, warnings: [] };
}

describe("L7 — perf-audit summary budget terminates and stays under the 2.5× ceiling", () => {
  it("terminates and returns ≤ 2.5× the soft budget on an adversarial report", () => {
    const report = adversarialReport(50, 400);
    // Pre-condition: the report genuinely blows the soft budget by a wide margin,
    // so the trim machinery is forced to run (not a no-op path).
    expect(estimateTokens(JSON.stringify(report))).toBeGreaterThan(SUMMARY_TOKEN_HARD_CEILING * 4);

    const out = enforceSummaryBudget(report);

    // Termination is exhibited by the call RETURNING at all (an unbounded loop
    // would hang the test). The size bound is the explicit guarantee: the
    // returned report is at or under the hard ceiling.
    expect(estimateTokens(JSON.stringify(out))).toBeLessThanOrEqual(SUMMARY_TOKEN_HARD_CEILING);
  });

  it("holds the ceiling even with a single irreducible huge entry", () => {
    // One high-severity issue whose title alone dwarfs the ceiling — whole-entry
    // trimming cannot shrink it (popping it would empty the report), so only the
    // hard-ceiling string truncation can. Proves the ceiling is a guarantee, not
    // an artefact of having many small entries to drop.
    const huge = "Y".repeat(SUMMARY_TOKEN_HARD_CEILING * 8);
    const report: AuditReport = {
      summary: {
        score: 0,
        topIssues: [{ category: "long-tasks", severity: "high", title: huge }],
      },
      byCategory: {
        "long-tasks": {
          issues: [{ category: "long-tasks", severity: "high", title: huge }],
          remediations: [{ category: "long-tasks", action: huge }],
        },
      },
      warnings: [],
    };
    const out = enforceSummaryBudget(report);
    expect(estimateTokens(JSON.stringify(out))).toBeLessThanOrEqual(SUMMARY_TOKEN_HARD_CEILING);
  });

  it("is a no-op (preserves the report) when already within budget", () => {
    // The bound must not perturb a small report — behaviour-preservation on the
    // common path.
    const report: AuditReport = {
      summary: { score: 90, topIssues: [{ category: "long-tasks", severity: "low", title: "ok" }] },
      byCategory: { "long-tasks": { issues: [], remediations: [] } },
      warnings: [],
    };
    const before = JSON.stringify(report);
    const out = enforceSummaryBudget(report);
    expect(JSON.stringify(out)).toBe(before);
  });

  it("returns a bounded report (never refuses) on a VALID audit with a ~1MB URL", () => {
    // Regression: a JS resource with a ~1MB-long URL (reachable via data: URIs /
    // long query strings) stores that URL in the issue's `details.url` AND the
    // remediation's `target`. The pre-fix `enforceHardCeiling` truncated only
    // titles/actions/warnings — not `details`/`target` — so a remediation the trim
    // KEEPS held the megabyte string and the report stayed over the hard ceiling,
    // firing the post-condition invariant and converting a VALID summary audit into
    // a browxai-internal refusal. The fix deep-truncates every string-bearing field
    // (incl. `details` recursively + `target`), so the ceiling is guaranteed by
    // construction: the audit returns a bounded report, it does NOT throw.
    const megaUrl = "https://example.test/app.js?" + "x".repeat(1024 * 1024);
    const ctx = {
      trace: [],
      jsCoverage: [{ url: megaUrl, totalBytes: 200000, usedBytes: 1000, usagePercent: 0.5 }],
    } as unknown as AuditContext;

    let report: AuditReport | undefined;
    expect(() => {
      report = composeReport(ctx, ["unused-code"] as never, "summary");
    }).not.toThrow();
    expect(report).toBeDefined();
    expect(estimateTokens(JSON.stringify(report))).toBeLessThanOrEqual(SUMMARY_TOKEN_HARD_CEILING);
  });
});

// ── a11y tree-walk depth cap ─────────────────────────────────────────────────

/** A linear chain of `depth` nested single-child nodes — the pathological tree
 *  the cap contains. */
function deepChain(depth: number): A11yNode {
  const root: A11yNode = { ref: "n0", role: "root", children: [] };
  let cur = root;
  for (let i = 1; i <= depth; i++) {
    const child: A11yNode = { ref: `n${i}`, role: "generic", children: [] };
    cur.children.push(child);
    cur = child;
  }
  return root;
}

describe("L7 — a11y walk() is depth-bounded", () => {
  it("never yields a node deeper than MAX_WALK_DEPTH on a pathological tree", () => {
    // Build a chain deeper than the cap; the walk must truncate, not exhaust.
    const root = deepChain(MAX_WALK_DEPTH + 500);
    let maxDepthSeen = 0;
    let count = 0;
    for (const { depth } of walk(root)) {
      maxDepthSeen = Math.max(maxDepthSeen, depth);
      count++;
      // Guard the test itself against a regression that removed the cap.
      if (count > MAX_WALK_DEPTH * 4) break;
    }
    expect(maxDepthSeen).toBeLessThanOrEqual(MAX_WALK_DEPTH);
    // Truncated at the cap (+1 for the root at depth 0), never the full chain.
    expect(count).toBeLessThanOrEqual(MAX_WALK_DEPTH + 1);
  });

  it("walks a normal-depth tree in full (the cap never trips in practice)", () => {
    const root = deepChain(40); // a deep SPA is rarely past this
    const depths = [...walk(root)].map((x) => x.depth);
    expect(Math.max(...depths)).toBe(40);
    expect(depths.length).toBe(41); // root + 40 descendants, none truncated
  });
});

// ── network ring buffer cap ──────────────────────────────────────────────────

describe("L7 — NetworkBuffer ring is capped", () => {
  it("rejects a non-positive cap (the bound must be meaningful)", () => {
    expect(() => new NetworkBuffer(undefined, 0)).toThrow(/invariant violated/i);
    expect(() => new NetworkBuffer(undefined, -1)).toThrow(/invariant violated/i);
  });

  it("retains at most `cap` entries when pushed past the bound", () => {
    // `push` is private; exercise it through the public `recent()` read after
    // driving more synthetic entries than the cap via the test-only seam.
    const cap = 8;
    const buf = new NetworkBuffer(undefined, cap);
    // pushEntryForTest is exposed only for this bounded-resource assertion.
    const anyBuf = buf as unknown as {
      push(e: { method: string; url: string; type: string }): void;
    };
    for (let i = 0; i < cap + 20; i++) {
      anyBuf.push({ method: "GET", url: `https://x/${i}`, type: "Other" });
    }
    const ringLen = (buf as unknown as { ring: unknown[] }).ring.length;
    expect(ringLen).toBe(cap);
  });
});

// ── service-worker id index ──────────────────────────────────────────────────

describe("L7 — the service-worker id index is capped on every path that mints an id", () => {
  const swIndexSize = (ch: WorkersSwChannel): number =>
    (ch as unknown as { swIdByUrl: Map<string, string> }).swIdByUrl.size;

  it("stops minting ids past 64 distinct URLs when workers are listed", () => {
    const ch = new WorkersSwChannel();
    const workers = Array.from({ length: 200 }, (_, i) => ({
      url: () => `https://x/sw-${i}.js`,
    }));
    const context = { serviceWorkers: () => workers } as unknown as Parameters<
      WorkersSwChannel["list"]
    >[0];
    expect(ch.list(context)).toHaveLength(64);
    expect(swIndexSize(ch)).toBe(64);
    // Listing again mints nothing new.
    expect(ch.list(context)).toHaveLength(64);
    expect(swIndexSize(ch)).toBe(64);
  });

  it("stops minting ids past 64 distinct URLs when page messages are ingested", () => {
    const ch = new WorkersSwChannel();
    ch.ingestPageMessages(
      Array.from({ length: 200 }, (_, i) => ({ url: `https://x/sw-${i}.js`, data: "m", at: i })),
    );
    expect(swIndexSize(ch)).toBe(64);
    expect(ch.swMessages).toHaveLength(64);
  });
});

// ── page-controlled sizes: bodies, console text, downloads, socket lines ─────

type EventHandler = (arg: unknown) => void;

describe("L7 — Firefox/WebKit response bodies are not read past the cap", () => {
  function respondWith(
    handlers: Map<string, EventHandler>,
    headers: Record<string, string>,
  ): () => Promise<Buffer> {
    const bodyFn = vi.fn(() => Promise.resolve(Buffer.from("payload")));
    const request = {
      method: () => "GET",
      url: () => "https://site.test/data",
      resourceType: () => "fetch",
    } as unknown as Request;
    const response = {
      request: () => request,
      status: () => 200,
      headers: () => headers,
      body: bodyFn,
    } as unknown as Response;
    handlers.get("request")?.(request);
    handlers.get("response")?.(response);
    return bodyFn;
  }

  async function setup(maxBodyBytes: number) {
    const handlers = new Map<string, EventHandler>();
    const context = {
      on: (event: string, cb: EventHandler) => handlers.set(event, cb),
    } as unknown as BrowserContext;
    const buffer = new PlaywrightNetworkBuffer(context, 500, 50, maxBodyBytes);
    await buffer.attach();
    return { buffer, handlers };
  }

  it("reads nothing while no one asks for a body", async () => {
    const { handlers } = await setup(1_000);
    const bodyFn = respondWith(handlers, { "content-length": "7" });
    expect(bodyFn).not.toHaveBeenCalled();
  });

  it("skips a body whose declared size is over the cap", async () => {
    const { buffer, handlers } = await setup(1_000);
    const bodyFn = respondWith(handlers, { "content-length": "1001" });
    const r = await buffer.fetchBody(buffer.iter().at(-1)!.requestId!, null);
    expect(r.ok).toBe(false);
    expect(r.truncated).toBe(true);
    expect(bodyFn).not.toHaveBeenCalled();
  });
});

describe("L7 — a console message is capped in size as well as in count", () => {
  it("stores no more than MAX_CONSOLE_MESSAGE_CHARS of a megabyte message", () => {
    const buf = new ConsoleBuffer();
    buf.ingest("log", "x".repeat(1024 * 1024));
    const stored = (buf as unknown as { msgs: Array<{ text: string }> }).msgs[0]!.text;
    expect(stored.length).toBeLessThan(MAX_CONSOLE_MESSAGE_CHARS + 64);
    expect(stored).toContain("[truncated");
  });
});

describe("L7 — downloads are bounded on read and in the pending list", () => {
  it("download_get refuses a file over the cap and names the saved path", () => {
    const dir = mkdtempSync(join(tmpdir(), "brx-bound-"));
    try {
      const reg = new DownloadsRegistry(dir);
      const path = join(dir, "big.bin");
      writeFileSync(path, Buffer.alloc(64, 1));
      reg.record({ suggestedFilename: "big.bin", sizeBytes: 64, path, capturedAt: Date.now() });
      expect(() => readCapturedBytes(reg, "d1", { maxBytes: 32 })).toThrow(path);
      expect(MAX_DOWNLOAD_GET_BYTES).toBe(16 * 1024 * 1024);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the pending list drains when captures go unclaimed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const reg = new DownloadsRegistry("/tmp/x");
      for (let i = 0; i < 300; i++) {
        reg.record({
          suggestedFilename: `f${i}`,
          sizeBytes: 1,
          path: `/tmp/x/f${i}`,
          capturedAt: Date.now(),
        });
      }
      // Eviction at 100 entries removes the evicted ones from the pending list too.
      expect(reg.pendingCount()).toBeLessThanOrEqual(100);
      vi.setSystemTime(1_000_000 + DownloadsRegistry.PENDING_TTL_MS + 1);
      expect(reg.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("L7 — the socket transport read buffer is capped", () => {
  it("closes the connection on a line that never ends", async () => {
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy() {
        this.destroyed = true;
      },
    });
    const transport = new SocketTransport(socket as unknown as Socket, { maxMessageBytes: 256 });
    const errors: Error[] = [];
    transport.onerror = (e) => errors.push(e);
    await transport.start();
    for (let i = 0; i < 10; i++) socket.emit("data", Buffer.alloc(100, 0x61));
    expect(socket.destroyed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("256-byte limit");
  });
});

// ── the loops added with the hardening pass: each stops at its bound ─────────

describe("L7 — the focused-frame walk stops at MAX_FRAME_DEPTH (16)", () => {
  it("descends 16 frames, not endlessly, when every frame holds a focused iframe", async () => {
    let descents = 0;
    const frameAt = (i: number): Frame =>
      ({
        url: () => `https://frame.test/${i}`,
        locator: () => ({
          count: async () => 1,
          first: () => ({
            elementHandle: async () => ({
              contentFrame: async () => {
                descents += 1;
                return frameAt(i + 1);
              },
              dispose: async () => undefined,
            }),
          }),
        }),
      }) as unknown as Frame;
    const page = { url: () => "https://top.test/", mainFrame: () => frameAt(0) } as unknown as Page;
    let seen = "";
    const secrets = {
      needsScopeCheck: () => true,
      materialize: (_raw: string, url: string) => {
        seen = url;
        return { ok: true, value: "v" };
      },
    };
    await materialiseValue({ page, secrets } as unknown as ActionContext, "<S>", "focused");
    expect(descents).toBe(16);
    expect(seen).toBe("https://frame.test/16");
  });
});

describe("L7 — asset_export gives up on a name after MAX_NAME_ATTEMPTS (1000)", () => {
  it("drops the asset when 1000 names are taken, and never tries the 1001st", async () => {
    const root = mkdtempSync(join(tmpdir(), "brx-names-"));
    try {
      mkdirSync(join(root, "out"));
      writeFileSync(join(root, "out", "a.png"), "x");
      for (let i = 1; i < 1000; i++) writeFileSync(join(root, "out", `a-${i}.png`), "x");
      const cdp = { send: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as CDPSession;
      const buffer = new NetworkBuffer(cdp);
      (buffer as unknown as { ring: unknown[] }).ring = [
        {
          method: "GET",
          url: "https://x.test/a.png",
          type: "Image",
          status: 200,
          mimeType: "image/png",
          bytes: 1,
          requestId: "r1",
        },
      ];
      const failingCdp = {
        send: vi.fn(async () => {
          throw new Error("No data found for resource");
        }),
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as CDPSession;
      const page = {
        evaluate: vi.fn(async () => ({ ok: true, base64: Buffer.from("n").toString("base64") })),
      } as unknown as Page;
      const r = await assetExport(
        { cdp: failingCdp, page, buffer, workspaceRoot: root, sessionId: "s" },
        { filter: {}, intoDir: "out" },
      );
      expect(r.persistedCount).toBe(0);
      expect(r.warnings.join("\n")).toMatch(/after 1000 tries/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("L7 — origin unwrapping stops at MAX_UNWRAP_DEPTH (2)", () => {
  it("returns null for a wrapper nested past the bound, however long the nesting", () => {
    expect(MAX_UNWRAP_DEPTH).toBe(2);
    const nested = "blob:".repeat(500) + "https://a.example/x";
    const parsed = safeUrl(nested);
    expect(parsed).not.toBeNull();
    expect(unwrapOrigin(parsed!)).toBeNull();
    expect(isOriginAllowed(nested, resolveOriginPolicy({}))).toBe(false);
  });
});

describe("L7 — the captcha error-cause walk stops at 4 levels", () => {
  const config = {
    provider: "2captcha",
    apiKey: "k",
    apiBase: "https://captcha.test",
    timeoutMs: 1000,
    pollMs: 1,
  } as unknown as CaptchaProviderConfig;

  it("ends on a cause chain that loops, and on one far deeper than the bound", async () => {
    const loop = new Error("loop");
    loop.cause = loop;
    let deep = new Error("unexpected redirect");
    for (let i = 0; i < 1000; i++) deep = new Error("wrapper", { cause: deep });
    for (const err of [loop, deep]) {
      const r = await submitToProvider(
        { type: "recaptcha2", pageUrl: "https://app.example", siteKey: "sk" },
        config,
        vi.fn(async () => {
          throw err;
        }),
        () => 0,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("network error submitting");
    }
  });
});
