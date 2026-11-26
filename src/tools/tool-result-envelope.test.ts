// The exact text the JSON-returning tool families put on the wire, pinned per
// tool. Two envelopes exist and a tool's choice between them is part of its
// documented output:
//
//   - ESTIMATED: the body, then `tokensEstimate` computed over the body's compact
//     JSON, pretty-printed with two spaces.
//   - BARE: the body pretty-printed with two spaces and nothing appended.
//
// Browser-free. Each handler runs against a stub host; a session with no page and
// no CDP connection drives the failure path of every page- or CDP-backed tool,
// and the tools that work on plain state get a success case too. The expected
// text is rebuilt here from the parsed body, independently of the code that
// produced it, so a change to key order, indentation or the estimate fails.

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { registerCanvasTools } from "./canvas-tools.js";
import { registerCaptureReportElementExportTools } from "./capture-report-element-export-tools.js";
import { registerCaptureReportExportTools } from "./capture-report-export-tools.js";
import { registerCaptureReportUploadTools } from "./capture-report-upload-tools.js";
import { registerDeepCoverageTools } from "./deep-coverage-tools.js";
import { registerDeepPerfTools } from "./deep-perf-tools.js";
import { registerSessionDialogPermissionTools } from "./session-dialog-permission-tools.js";
import { PermissionPolicyState } from "../session/permission-policy.js";
import { FsPickerPolicyState } from "../session/fs-picker-policy.js";
import type { ToolResponse } from "./host.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;
type Body = Record<string, unknown>;

const root = mkdtempSync(join(tmpdir(), "browxai-envelope-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NO_PAGE =
  'engine "stub" has no browser page. This operation needs one. ' +
  "Use a chromium, firefox, webkit or android session.";
const NO_CDP = /^engine "stub" has no CDP connection\./;

/** A session with neither a page nor a CDP connection: `requirePage` and
 *  `requireCdp` both throw, inside each handler's `try`. */
const noBrowser = { id: "s1", mode: "incognito", refs: {}, session: { engine: "stub" } };

function handlersOf(
  registerTools: (host: never) => void,
  entry: object,
  extra: object = {},
): Record<string, Handler> {
  const handlers: Record<string, Handler> = {};
  const host = {
    z,
    register: (name: string, _def: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
    gateCheck: () => null,
    engineGate: () => null,
    entryFor: async () => entry,
    cfgActionTimeout: () => 1_000,
    workspace: { root },
    toolHandlers: {},
    confirmCtxFor: () => ({ isByob: false }),
    denyContent: () => {
      throw new Error("unexpected confirm denial");
    },
    asTarget: () => ({ ref: "e1" }),
    ...extra,
  };
  registerTools(host as never);
  return handlers;
}

function textOf(r: ToolResponse): string {
  expect(r.content).toHaveLength(1);
  const item = r.content[0] as { type: string; text: string };
  expect(item.type).toBe("text");
  return item.text;
}

const estimate = (body: unknown) => Math.ceil(JSON.stringify(body).length / 4);
const estimatedText = (body: Body) =>
  JSON.stringify({ ...body, tokensEstimate: estimate(body) }, null, 2);
const bareText = (body: unknown) => JSON.stringify(body, null, 2);

/** Assert the ESTIMATED envelope and return the body without the estimate. */
function estimated(r: ToolResponse): Body {
  const text = textOf(r);
  const parsed = JSON.parse(text) as Body;
  expect(Object.keys(parsed).at(-1)).toBe("tokensEstimate");
  const { tokensEstimate: _tokensEstimate, ...body } = parsed;
  expect(text).toBe(estimatedText(body));
  return body;
}

/** Assert the BARE envelope and return the body. */
function bare(r: ToolResponse): Body {
  const text = textOf(r);
  const parsed = JSON.parse(text) as Body;
  expect(parsed).not.toHaveProperty("tokensEstimate");
  expect(text).toBe(bareText(parsed));
  return parsed;
}

/** A thrown error rendered in the ESTIMATED envelope. */
function estimatedError(r: ToolResponse, message: string | RegExp): void {
  const body = estimated(r);
  expect(Object.keys(body)).toEqual(["ok", "error"]);
  expect(body.ok).toBe(false);
  if (typeof message === "string") expect(body.error).toBe(message);
  else expect(body.error).toMatch(message);
}

/** A thrown error rendered in the BARE envelope. */
function bareError(r: ToolResponse, message: string | RegExp): void {
  const body = bare(r);
  expect(Object.keys(body)).toEqual(["ok", "error"]);
  expect(body.ok).toBe(false);
  if (typeof message === "string") expect(body.error).toBe(message);
  else expect(body.error).toMatch(message);
}

describe("canvas tools", () => {
  const h = handlersOf(registerCanvasTools, noBrowser);

  it.each([
    ["canvas_capture", { format: "png" }],
    ["gesture_chain", { steps: [] }],
    ["canvas_world_to_screen", { worldX: 1, worldY: 2 }],
    ["canvas_screen_to_world", { screenX: 1, screenY: 2 }],
  ])("%s renders a thrown error with an estimate", async (tool, args) => {
    estimatedError(await h[tool]!(args), NO_PAGE);
  });

  it("canvas_diff renders its result with an estimate", async () => {
    const px = Buffer.from([0, 0, 0, 255]).toString("base64");
    const body = estimated(
      await h.canvas_diff!({ beforeBase64: px, afterBase64: px, width: 1, height: 1 }),
    );
    expect(body.ok).toBe(true);
    expect(body.changedPixelCount).toBe(0);
  });

  it("canvas_diff renders a refusal body with an estimate", async () => {
    const body = estimated(await h.canvas_diff!({ beforeBase64: "AA==", afterBase64: "AA==" }));
    expect(body.ok).toBe(false);
    expect(body.code).toBe("missing-dimensions");
  });

  it("canvas_query renders the no-adapter body with an estimate", async () => {
    const body = estimated(await h.canvas_query!({ adapter: "nope", op: "nodes" }));
    expect(body).toEqual({
      ok: false,
      error:
        "no canvas adapter registered for nope; install @browxai/plugin-nope or pass a registered adapter namespace",
      code: "no-adapter",
      requestedAdapter: "nope",
      requestedOp: "nodes",
    });
  });
});

describe("element export tools", () => {
  const h = handlersOf(registerCaptureReportElementExportTools, noBrowser);

  it.each([
    ["element_export", { ref: "e1" }],
    ["dom_export", {}],
    ["overflow_detect", {}],
  ])("%s renders a thrown error with an estimate", async (tool, args) => {
    estimatedError(await h[tool]!(args), NO_PAGE);
  });
});

describe("upload and download tools", () => {
  it("upload_file renders a coords target refusal bare", async () => {
    const h = handlersOf(registerCaptureReportUploadTools, noBrowser, {
      asTarget: () => ({ coords: { x: 1, y: 2 } }),
    });
    expect(textOf(await h.upload_file!({}))).toBe(
      bareText({
        ok: false,
        error: "upload_file: target must be a ref/selector for the file input, not coords",
      }),
    );
  });

  it("upload_file renders a thrown error bare", async () => {
    const h = handlersOf(registerCaptureReportUploadTools, noBrowser);
    bareError(await h.upload_file!({}), NO_PAGE);
  });

  it("drop_files renders a thrown error with an estimate", async () => {
    const h = handlersOf(registerCaptureReportUploadTools, noBrowser);
    estimatedError(await h.drop_files!({ files: [] }), NO_PAGE);
  });

  it("downloads_capture renders the capture state with an estimate", async () => {
    const downloads = {
      captureOn: false,
      storageDir: "/ws/.downloads/s1",
      list: () => [
        {
          id: "d1",
          suggestedFilename: "a.txt",
          sizeBytes: 3,
          path: "/ws/.downloads/s1/a.txt",
          mimeType: "text/plain",
          url: "https://example.test/a.txt",
        },
        { id: "d2", suggestedFilename: "b.bin", sizeBytes: 9, path: "/ws/.downloads/s1/b.bin" },
      ],
    };
    const h = handlersOf(registerCaptureReportUploadTools, { ...noBrowser, downloads });
    expect(textOf(await h.downloads_capture!({ on: true }))).toBe(
      estimatedText({
        ok: true,
        captureOn: true,
        storageDir: "/ws/.downloads/s1",
        captured: [
          {
            id: "d1",
            suggestedFilename: "a.txt",
            sizeBytes: 3,
            path: "/ws/.downloads/s1/a.txt",
            mimeType: "text/plain",
          },
          { id: "d2", suggestedFilename: "b.bin", sizeBytes: 9, path: "/ws/.downloads/s1/b.bin" },
        ],
      }),
    );
  });

  it("downloads_capture renders a thrown error bare", async () => {
    const downloads = {
      captureOn: false,
      storageDir: "/ws/.downloads/s1",
      list: () => {
        throw new Error("boom");
      },
    };
    const h = handlersOf(registerCaptureReportUploadTools, { ...noBrowser, downloads });
    bareError(await h.downloads_capture!({ on: true }), "boom");
  });

  it("download_get renders the file with an estimate", async () => {
    const path = join(root, "got.txt");
    writeFileSync(path, "hey");
    const downloads = {
      get: () => ({ path, mimeType: "text/plain", suggestedFilename: "got.txt" }),
    };
    const h = handlersOf(registerCaptureReportUploadTools, { ...noBrowser, downloads });
    expect(textOf(await h.download_get!({ id: "d1" }))).toBe(
      estimatedText({
        ok: true,
        id: "d1",
        suggestedFilename: "got.txt",
        sizeBytes: 3,
        path,
        mimeType: "text/plain",
        content: Buffer.from("hey").toString("base64"),
      }),
    );
  });

  it("download_get renders a thrown error bare", async () => {
    const h = handlersOf(registerCaptureReportUploadTools, {
      ...noBrowser,
      downloads: { get: () => undefined },
    });
    bareError(await h.download_get!({ id: "d9" }), /^download_get: unknown id "d9"\./);
  });
});

describe("page export tools", () => {
  it.each([
    ["asset_export", NO_CDP],
    ["page_archive", NO_PAGE],
  ])("%s renders a thrown error with an estimate", async (tool, message) => {
    const h = handlersOf(registerCaptureReportExportTools, noBrowser);
    estimatedError(await h[tool]!({}), message);
  });

  it("pdf_save renders an attached-session refusal with an estimate", async () => {
    const h = handlersOf(registerCaptureReportExportTools, { ...noBrowser, mode: "attached" });
    const body = estimated(await h.pdf_save!({}));
    expect(Object.keys(body)).toEqual(["ok", "error", "hint"]);
    expect(body.ok).toBe(false);
  });

  it("pdf_save renders a saved result bare", async () => {
    const result = { ok: true, path: "/ws/pdfs/s1.pdf", bytes: 10 };
    const h = handlersOf(registerCaptureReportExportTools, noBrowser, {
      captureFor: () => ({ pdf: async () => ({ kind: "saved", result }) }),
    });
    expect(textOf(await h.pdf_save!({}))).toBe(bareText(result));
  });

  it("pdf_save renders an engine refusal bare", async () => {
    const h = handlersOf(registerCaptureReportExportTools, noBrowser, {
      captureFor: () => ({
        pdf: async () => ({ kind: "refusal", error: "no pdf here", hint: "use chromium" }),
      }),
    });
    expect(textOf(await h.pdf_save!({}))).toBe(
      bareText({ ok: false, error: "no pdf here", hint: "use chromium" }),
    );
  });

  it("pdf_save renders a thrown error bare", async () => {
    const h = handlersOf(registerCaptureReportExportTools, noBrowser, {
      captureFor: () => ({
        pdf: async () => {
          throw new Error("boom");
        },
      }),
    });
    bareError(await h.pdf_save!({}), "boom");
  });
});

describe("coverage and heap tools", () => {
  const withCdp = (coverage: object) => ({
    ...noBrowser,
    coverage,
    session: { engine: "stub", cdp: () => ({}) },
  });

  it.each([
    ["coverage_start", {}, NO_CDP],
    ["coverage_stop", {}, NO_CDP],
    ["layout_thrash_trace", {}, NO_CDP],
    ["heap_snapshot", {}, NO_CDP],
    ["memory_diff", { beforePath: "missing-a.heapsnapshot", afterPath: "missing-b.heapsnapshot" }],
    ["heap_retainers", { snapshotPath: "missing.heapsnapshot", query: { name: "Cache" } }],
  ] as Array<[string, Body, RegExp?]>)(
    "%s renders a thrown error with an estimate",
    async (tool, args, message) => {
      // The tracker exists on every session; with no CDP connection the handler
      // throws while building the call's argument.
      const coverage = { start: async () => ({}), stop: async () => ({}) };
      const h = handlersOf(registerDeepCoverageTools, { ...noBrowser, coverage });
      estimatedError(await h[tool]!(args), message ?? /\S/);
    },
  );

  it("coverage_start renders the started state with an estimate", async () => {
    const h = handlersOf(
      registerDeepCoverageTools,
      withCdp({ start: async () => ({ startedAt: 123, restarted: false }) }),
    );
    const body = estimated(await h.coverage_start!({}));
    expect(Object.keys(body)).toEqual(["ok", "running", "startedAt", "restarted", "hint"]);
    expect(body).toMatchObject({ ok: true, running: true, startedAt: 123, restarted: false });
  });

  it("coverage_start adds the restart warning after the hint", async () => {
    const h = handlersOf(
      registerDeepCoverageTools,
      withCdp({ start: async () => ({ startedAt: 123, restarted: true }) }),
    );
    const body = estimated(await h.coverage_start!({}));
    expect(Object.keys(body)).toEqual([
      "ok",
      "running",
      "startedAt",
      "restarted",
      "hint",
      "warning",
    ]);
  });

  it("coverage_stop renders not-running with an estimate", async () => {
    const h = handlersOf(
      registerDeepCoverageTools,
      withCdp({ stop: async () => ({ notRunning: true }) }),
    );
    const body = estimated(await h.coverage_stop!({}));
    expect(Object.keys(body)).toEqual(["ok", "notRunning", "hint"]);
    expect(body).toMatchObject({ ok: true, notRunning: true });
  });

  it("coverage_stop renders the report with an estimate", async () => {
    const report = { jsCoverage: [{ url: "a.js" }], cssCoverage: [], durationMs: 5 };
    const h = handlersOf(registerDeepCoverageTools, withCdp({ stop: async () => report }));
    expect(textOf(await h.coverage_stop!({}))).toBe(estimatedText({ ok: true, ...report }));
  });
});

describe("perf tools", () => {
  const withCdp = (perf: object) => ({
    ...noBrowser,
    perf,
    session: { engine: "stub", cdp: () => ({}) },
  });

  it.each([
    ["perf_start", {}, NO_CDP],
    ["perf_stop", {}, NO_CDP],
    ["perf_audit", {}, NO_CDP],
    ["perf_insights", { tracePath: "missing-trace.json" }],
  ] as Array<[string, Body, RegExp?]>)(
    "%s renders a thrown error with an estimate",
    async (tool, args, message) => {
      const perf = { start: async () => ({}), stop: async () => ({}) };
      const h = handlersOf(registerDeepPerfTools, { ...noBrowser, perf });
      estimatedError(await h[tool]!(args), message ?? /\S/);
    },
  );

  it("perf_start renders the started state with an estimate", async () => {
    const h = handlersOf(
      registerDeepPerfTools,
      withCdp({ start: async () => ({ categories: ["devtools.timeline"], restarted: false }) }),
    );
    const body = estimated(await h.perf_start!({}));
    expect(Object.keys(body)).toEqual(["ok", "running", "categories", "restarted", "hint"]);
    expect(body).toMatchObject({ ok: true, running: true, categories: ["devtools.timeline"] });
  });

  it("perf_stop renders not-running with an estimate", async () => {
    const h = handlersOf(
      registerDeepPerfTools,
      withCdp({ stop: async () => ({ notRunning: true }) }),
    );
    const body = estimated(await h.perf_stop!({}));
    expect(Object.keys(body)).toEqual(["ok", "notRunning", "hint"]);
    expect(body).toMatchObject({ ok: true, notRunning: true });
  });
});

describe("dialog, permission and picker policy tools", () => {
  const pageWithContext = {
    engine: "stub",
    page: () => ({
      context: () => ({
        clearPermissions: async () => undefined,
        grantPermissions: async () => undefined,
        newCDPSession: async () => ({ send: async () => undefined, detach: async () => {} }),
      }),
    }),
  };
  const throwing = {
    current: () => ({ mode: "raise" }),
    set: () => {
      throw new Error("boom");
    },
  };
  /** `{ok, session, policy, tokensEstimate}` where the estimate covers the
   *  POLICY alone, not the body. */
  const policyText = (policy: unknown, tail: Body = {}) =>
    bareText({ ok: true, session: "s1", policy, tokensEstimate: estimate(policy), ...tail });

  it("set_dialog_policy renders the resolved policy, estimate over the policy", async () => {
    const h = handlersOf(registerSessionDialogPermissionTools, {
      ...noBrowser,
      dialog: { set: (next: unknown) => next },
    });
    expect(textOf(await h.set_dialog_policy!({ mode: "accept" }))).toBe(
      policyText({ mode: "accept" }),
    );
  });

  it("set_dialog_policy renders a thrown error bare", async () => {
    const h = handlersOf(registerSessionDialogPermissionTools, {
      ...noBrowser,
      dialog: { set: (next: unknown) => next },
    });
    bareError(
      await h.set_dialog_policy!({ mode: "accept-prompt-with" }),
      'set_dialog_policy: mode "accept-prompt-with" requires `text`',
    );
  });

  it("set_permission_policy renders the resolved policy, estimate over the policy", async () => {
    const h = handlersOf(registerSessionDialogPermissionTools, {
      ...noBrowser,
      session: pageWithContext,
      permission: new PermissionPolicyState({ mode: "raise" } as never),
    });
    const text = textOf(await h.set_permission_policy!({ mode: "allow" }));
    const { policy } = JSON.parse(text) as { policy: { mode: string } };
    expect(policy.mode).toBe("allow");
    expect(text).toBe(policyText(policy));
  });

  it("set_permission_policy puts the attached-session warning after the estimate", async () => {
    const h = handlersOf(registerSessionDialogPermissionTools, {
      ...noBrowser,
      mode: "attached",
      session: pageWithContext,
      permission: new PermissionPolicyState({ mode: "raise" } as never),
    });
    const text = textOf(await h.set_permission_policy!({ mode: "allow" }));
    const parsed = JSON.parse(text) as { policy: unknown; warnings: string[] };
    expect(parsed.warnings).toHaveLength(1);
    expect(text).toBe(policyText(parsed.policy, { warnings: parsed.warnings }));
  });

  it("set_permission_policy renders a thrown error bare", async () => {
    const h = handlersOf(registerSessionDialogPermissionTools, {
      ...noBrowser,
      session: pageWithContext,
      permission: throwing,
    });
    bareError(await h.set_permission_policy!({ mode: "allow" }), "boom");
  });

  it("set_fs_picker_policy renders the resolved policy, estimate over the policy", async () => {
    const h = handlersOf(registerSessionDialogPermissionTools, {
      ...noBrowser,
      fsPicker: new FsPickerPolicyState({ mode: "raise" } as never),
    });
    const text = textOf(await h.set_fs_picker_policy!({ mode: "allow" }));
    const { policy } = JSON.parse(text) as { policy: { mode: string } };
    expect(policy.mode).toBe("allow");
    expect(text).toBe(policyText(policy));
  });

  it("set_fs_picker_policy renders a thrown error bare", async () => {
    const h = handlersOf(registerSessionDialogPermissionTools, {
      ...noBrowser,
      fsPicker: throwing,
    });
    bareError(await h.set_fs_picker_policy!({ mode: "allow" }), "boom");
  });

  it("fs_picker_respond renders the queued count, estimate over the queue entry", async () => {
    const pushed: unknown[] = [];
    const h = handlersOf(registerSessionDialogPermissionTools, {
      ...noBrowser,
      fsPicker: { pushResponse: (...args: unknown[]) => pushed.push(args) },
    });
    const queued = { api: "showOpenFilePicker", fileCount: 1 };
    expect(
      textOf(
        await h.fs_picker_respond!({
          api: "showOpenFilePicker",
          files: [{ contents: "aGV5", name: "a.txt" }],
        }),
      ),
    ).toBe(bareText({ ok: true, session: "s1", queued, tokensEstimate: estimate(queued) }));
    expect(pushed).toHaveLength(1);
  });

  it("fs_picker_respond renders a thrown error bare", async () => {
    const h = handlersOf(registerSessionDialogPermissionTools, {
      ...noBrowser,
      fsPicker: { pushResponse: () => undefined },
    });
    bareError(
      await h.fs_picker_respond!({
        api: "showOpenFilePicker",
        files: [{ path: "a.txt", contents: "aGV5" }],
      }),
      "fs_picker_respond: each file must pass exactly one of `path` or `contents`",
    );
  });
});
