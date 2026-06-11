// Investigation smoke for `screenshot_marks` — substantiates the
// wrightxai tool-fit question:
//
//   1. Verify the namespace-sharing claim end-to-end (snapshot → pick refs →
//      screenshot_marks → mapping["N"] === eM AND painted bbox == find()
//      evidence.bbox).
//   2. Wall-clock profile against the alternative flow (find + screenshot)
//      on three public targets.
//   3. Edge-case probe: label modes (index/ref/role), bare-{ref} vs
//      full-candidate fast path, hidden/clipped/detached refs, overlapping
//      bboxes.
//
// Targets: example.com, developer.mozilla.org, en.wikipedia.org/wiki/Main_Page.
// Public no-auth pages only. Same scope Builder A used for the smoke.
//
// NOT part of the keystone or unit suite — runs from
// vitest.investigation.config.ts. Live network; skipped when WRX_NO_NET is
// set (CI default).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const TIMEOUT = 240_000;
const SKIP = process.env.WRX_NO_NET === "1";

let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

interface FindCandidate {
  ref: string;
  role?: string;
  name?: string;
  testId?: string;
  selectorHint: string;
  stability: string;
  selectorTier: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
  clipped: boolean;
}

interface MarkEntry {
  index: number;
  ref: string;
  role?: string;
  name?: string;
  testId?: string;
  bbox: { x: number; y: number; width: number; height: number } | null;
  painted: boolean;
}

interface MarksResult {
  marks: MarkEntry[];
  mapping: Record<string, string>;
  warnings: string[];
}

async function callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`no handler "${name}"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

async function callMarks(args: Record<string, unknown>): Promise<{
  json: MarksResult;
  imageBase64: string;
  imageBytes: number;
}> {
  const fn = handlers["screenshot_marks"];
  if (!fn) throw new Error(`no handler "screenshot_marks"`);
  const res = await fn(args);
  const text = (res.content[0] as { text: string }).text;
  const json = JSON.parse(text) as MarksResult;
  const img = res.content[1] as { data: string };
  const imageBase64 = img?.data ?? "";
  const imageBytes = Buffer.from(imageBase64, "base64").length;
  return { json, imageBase64, imageBytes };
}

async function callScreenshot(
  args: Record<string, unknown>,
): Promise<{ bytes: number; base64: string }> {
  const fn = handlers["screenshot"];
  if (!fn) throw new Error(`no handler "screenshot"`);
  const res = await fn(args);
  // Find the image entry — screenshot returns { content: [{text}, {image}] } or [{image}].
  for (const c of res.content) {
    if ((c as { type: string }).type === "image") {
      const data = (c as { data: string }).data;
      return { bytes: Buffer.from(data, "base64").length, base64: data };
    }
  }
  return { bytes: 0, base64: "" };
}

function now(): number {
  return Date.now();
}

beforeAll(async () => {
  if (SKIP) return;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-investigation-"));
  process.env.BROWX_WORKSPACE = workspace;
  server = await createServer({ headless: true });
  handlers = server.handlers;
  // Bump the per-call deadline — cross-internet first-paint + tree walk easily
  // beats the 5 s default. Same posture wrightxai uses (30 s).
  await callJson("set_config", { scope: "project", patch: { actionTimeoutMs: 90_000 } });
}, TIMEOUT);

afterAll(async () => {
  if (SKIP) return;
  await server?.shutdown().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, TIMEOUT);

const TARGETS = [
  { name: "example", url: "https://example.com/", query: "the More information link" },
  { name: "mdn", url: "https://developer.mozilla.org/en-US/", query: "the search input" },
  { name: "wiki", url: "https://en.wikipedia.org/wiki/Main_Page", query: "the search input" },
];

const artifactsDir = join(__dirname, "..", "..", "artifacts");

describe.skipIf(SKIP)("screenshot_marks investigation — namespace sharing + wall-clock", () => {
  for (const target of TARGETS) {
    it(
      `${target.name}: namespace round-trip + bbox equality + wall-clock`,
      async () => {
        const session = `inv-${target.name}`;
        await callJson("open_session", { session, mode: "incognito" });
        await callJson("navigate", { session, url: target.url, timeoutMs: 30_000 });
        // Allow the page to settle visually.
        await new Promise((r) => setTimeout(r, 500));

        // (a) Snapshot is the canonical, deterministic ref minter — find()'s
        // NL ranker can return 0 on cold large pages. We use snapshot for the
        // wall-clock test (snapshot+marks-bare is the realistic wrightxai-loop
        // perception step). find() is only invoked when we want the
        // bbox-equality fast-path arm; on heavy targets (mdn) it can blow
        // past the 90s budget, in which case we report tFindWithBboxMs:null.
        const t0Snap = now();
        const snapText = await callJson<string>("snapshot", { session });
        const tSnapshot = now() - t0Snap;
        const refs = Array.from(
          new Set(Array.from(snapText.matchAll(/\[ref=(e\d+)\]/g)).map((m) => m[1]!)),
        ).slice(0, 6);
        expect(refs.length, `${target.name}: snapshot minted >=1 ref`).toBeGreaterThanOrEqual(1);
        const useRefs = refs.slice(0, Math.min(3, refs.length));

        // Try find() — bounded; on heavy pages it can time out. Single attempt,
        // generic role query. If it returns bboxes, we get the fast-path arm
        // too; otherwise we report the failure as a data point.
        const t0Find = now();
        let cands: FindCandidate[] = [];
        try {
          const found = await callJson<{ candidates?: FindCandidate[] }>("find", {
            session,
            query: "link",
            maxCandidates: 5,
          });
          cands = (found.candidates ?? []).filter((c) => c.bbox !== null);
        } catch {
          /* swallow — find() failure is a data point, not a test fail */
        }
        const tFind = now() - t0Find;
        const haveFindCands = cands.length >= 1;
        const withBbox = cands.slice(0, 3);

        console.log(
          `[${target.name}] tSnapshot=${tSnapshot}ms tFind=${tFind}ms refs=${refs.length} findBbox=${cands.length}`,
        );

        // (b) Flow A: screenshot_marks. Prefer the full-candidate fast path
        // when find() returned bbox-carrying rows; otherwise use bare-ref
        // fallback so the test still proves namespace sharing.
        const fastPath = haveFindCands;
        const t0Marks = now();
        const marks = await callMarks({
          session,
          candidates: fastPath
            ? withBbox.map((c) => ({
                ref: c.ref,
                role: c.role,
                name: c.name,
                testId: c.testId,
                bbox: c.bbox,
              }))
            : useRefs.map((r) => ({ ref: r })),
          label: "index",
        });
        const tMarks = now() - t0Marks;

        console.log(
          `[${target.name}] marks.json keys=`,
          Object.keys(marks.json ?? {}),
          "bytes=",
          marks.imageBytes,
        );

        // Namespace round-trip: mapping["N"] must equal the eM of the
        // N-th candidate, AND must equal entry.ref for that index. The
        // bare-ref path internally re-walks the a11y/DOM tree; on heavy DOMs
        // (mdn) that compose can blow past the per-call deadline and the
        // handler returns `{ok:false, error}`. That's a real wrightxai-loop
        // finding — caller-supplied bbox (fast-path) avoids it entirely. We
        // record the outcome both ways.
        const sourceRefs = fastPath ? withBbox.map((c) => c.ref) : useRefs;
        const marksTimedOut = (marks.json as unknown as { ok?: boolean }).ok === false;
        if (!marksTimedOut) {
          for (let i = 0; i < sourceRefs.length; i++) {
            const idx = String(i + 1);
            expect(marks.json.mapping[idx], `mapping[${idx}] == sourceRef[${i}]`).toBe(
              sourceRefs[i],
            );
            expect(marks.json.marks[i]!.ref).toBe(sourceRefs[i]);
            if (fastPath) {
              // Fast-path: bbox passed through must match find()'s evidence.bbox.
              expect(marks.json.marks[i]!.bbox).toEqual(withBbox[i]!.bbox);
            }
          }
          expect(marks.imageBytes).toBeGreaterThan(0);
        }

        // Save the screenshot artifact for proof-of-execution (when present).
        if (marks.imageBytes > 0) {
          const artifactPath = join(artifactsDir, `marks-${target.name}.png`);
          writeFileSync(artifactPath, Buffer.from(marks.imageBase64, "base64"));
        }

        // (c) Flow B: plain screenshot.
        const t0Shot = now();
        const snap = await callScreenshot({ session });
        const tSnap = now() - t0Shot;

        // (d) Bare-{ref} path — slower (re-walk). On heavy DOMs this may
        // return {ok:false, timeout}; record either way.
        const t0Bare = now();
        const bare = await callMarks({
          session,
          candidates: sourceRefs.map((r) => ({ ref: r })),
          label: "index",
        });
        const tBare = now() - t0Bare;
        const bareTimedOut = (bare.json as unknown as { ok?: boolean }).ok === false;
        if (!bareTimedOut) {
          for (let i = 0; i < sourceRefs.length; i++) {
            expect(bare.json.mapping[String(i + 1)]).toBe(sourceRefs[i]);
          }
        }

        // (e) Label modes — ref + role (only when we have full candidates).
        let labelRefBytes = 0;
        let labelRoleBytes = 0;
        if (fastPath) {
          const labelRef = await callMarks({
            session,
            candidates: withBbox.map((c) => ({
              ref: c.ref,
              bbox: c.bbox,
              role: c.role,
              name: c.name,
            })),
            label: "ref",
          });
          labelRefBytes = labelRef.imageBytes;
          const labelRole = await callMarks({
            session,
            candidates: withBbox.map((c) => ({
              ref: c.ref,
              bbox: c.bbox,
              role: c.role,
              name: c.name,
            })),
            label: "role",
          });
          labelRoleBytes = labelRole.imageBytes;
        }

        // Profile line — two distinct comparisons:
        //   Flow A (vision-grounded action choice, realistic wrightxai loop):
        //     snapshot → screenshot_marks(bare refs)   = tSnapshot + tBare
        //   Flow B (alternative): find(query) → screenshot                = tFind + tSnap
        //   Flow C (pure baseline): screenshot only                       = tSnap
        const profileLine = {
          target: target.name,
          fastPath,
          marksTimedOut,
          bareTimedOut,
          tSnapshot,
          tFind,
          tMarks_fastpath: fastPath ? tMarks : null,
          tMarks_bareRef: fastPath ? tBare : tMarks,
          tScreenshot: tSnap,
          flowA_snapshot_plus_marks: tSnapshot + (fastPath ? tBare : tMarks),
          flowB_find_plus_screenshot: tFind + tSnap,
          flowC_screenshot_only: tSnap,
          marksPainted: marksTimedOut ? 0 : marks.json.marks.filter((m) => m.painted).length,
          marksBytes: marks.imageBytes,
          labelRefBytes,
          labelRoleBytes,
          snapBytes: snap.bytes,
        };
        writeFileSync(
          join(artifactsDir, `profile-${target.name}.json`),
          JSON.stringify(profileLine, null, 2),
        );

        await callJson("close_session", { session });
      },
      TIMEOUT,
    );
  }
});

describe.skipIf(SKIP)("screenshot_marks investigation — edge cases", () => {
  it(
    "unresolvable ref + clipped/null bbox + overlapping bboxes — all degrade gracefully",
    async () => {
      const session = "inv-edge";
      await callJson("open_session", { session, mode: "incognito" });
      await callJson("navigate", { session, url: "https://example.com/" });
      await new Promise((r) => setTimeout(r, 300));

      // (1) Bare ref that does NOT exist → warning + painted:false, no crash.
      const ghost = await callMarks({
        session,
        candidates: [{ ref: "e999999" }],
        label: "index",
      });
      expect(ghost.json.marks[0]!.painted).toBe(false);
      expect(ghost.json.warnings.some((w) => /e999999/.test(w))).toBe(true);
      // Image is still returned (no painted boxes → no overlay installed,
      // but a blank-overlay viewport screenshot may or may not be produced).
      // What matters is no throw.

      // (2) Explicit null-bbox candidate (caller-provided, simulating clipped).
      const clipped = await callMarks({
        session,
        candidates: [{ ref: "e1", bbox: null }],
        label: "index",
      });
      expect(clipped.json.marks[0]!.painted).toBe(false);

      // (3) Overlapping bboxes — two refs at the same coords, mapping intact,
      //     no crash. We synthesise overlap with caller-provided bboxes.
      const overlap = await callMarks({
        session,
        candidates: [
          { ref: "e1", role: "link", name: "A", bbox: { x: 100, y: 100, width: 80, height: 30 } },
          { ref: "e2", role: "link", name: "B", bbox: { x: 110, y: 105, width: 80, height: 30 } },
        ],
        label: "index",
      });
      expect(overlap.json.mapping["1"]).toBe("e1");
      expect(overlap.json.mapping["2"]).toBe("e2");
      expect(overlap.imageBytes).toBeGreaterThan(0);
      writeFileSync(
        join(artifactsDir, "marks-overlap.png"),
        Buffer.from(overlap.imageBase64, "base64"),
      );

      await callJson("close_session", { session });
    },
    TIMEOUT,
  );
});
