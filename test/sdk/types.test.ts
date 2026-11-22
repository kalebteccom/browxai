// Compile-time probes for the typed `BrowxaiClient` surface. The shapes
// declared in `src/sdk/tool-types.ts` are the canonical reference an
// LLM-authoring consumer (the adopter) reads from `.d.ts`, so we keep a few
// minimal runtime expressions whose TYPE CHECK is the test. Deliberate-
// violation probes that prove the wrong shape fails to compile live in
// `test/sdk/types.probe.failing.ts.skip` (kept out of the build).
//
// Stage A.5 — purely additive on the type layer; no runtime is exercised
// beyond a couple of property lookups (see in-process.test.ts /
// sdk.keystone.test.ts for the full runtime path).

import { describe, it, expectTypeOf } from "vitest";
import type { BrowxaiClient, BrowxaiResult } from "../../src/sdk/types.js";
import type {
  ActionResultData,
  ExtractResult,
  ExtractResultData,
  FindArgs,
  FindResult,
  NavigateArgs,
  NavigateResult,
  FindResultData,
  ScreenshotFileResult,
  SnapshotFail,
} from "../../src/sdk/tool-types.js";

describe("BrowxaiClient — per-tool typed methods", () => {
  it("navigate accepts url-only args and resolves to the action result itself", () => {
    expectTypeOf<Parameters<BrowxaiClient["navigate"]>[0]>().toEqualTypeOf<NavigateArgs>();
    expectTypeOf<ReturnType<BrowxaiClient["navigate"]>>().resolves.toEqualTypeOf<NavigateResult>();
    // Stand-in for "compiles": NavigateArgs requires `url`.
    expectTypeOf<NavigateArgs>().toMatchTypeOf<{ url: string }>();
    expectTypeOf<NavigateResult>().toEqualTypeOf<ActionResultData>();
  });

  it("find resolves to FindResultData, with no envelope around it", () => {
    expectTypeOf<Parameters<BrowxaiClient["find"]>[0]>().toEqualTypeOf<FindArgs>();
    expectTypeOf<ReturnType<BrowxaiClient["find"]>>().resolves.toEqualTypeOf<FindResult>();
    expectTypeOf<FindResult>().toEqualTypeOf<FindResultData>();
    expectTypeOf<FindResult>().toHaveProperty("candidates");
  });

  it("extract resolves to the tool result, so a script reads result.data.title", () => {
    expectTypeOf<ExtractResult>().toEqualTypeOf<ExtractResultData>();
    type Ok = Extract<ExtractResult, { ok: true }>;
    expectTypeOf<Ok["data"]>().toEqualTypeOf<unknown>();
    expectTypeOf<Extract<ExtractResult, { ok: false }>>().toHaveProperty("failure");
  });

  it("snapshot resolves to the tree string, or a failure object", () => {
    expectTypeOf<ReturnType<BrowxaiClient["snapshot"]>>().resolves.toEqualTypeOf<
      string | SnapshotFail
    >();
  });

  it("screenshot keeps the envelope for the image, plus a JSON result for path mode", () => {
    expectTypeOf<ReturnType<BrowxaiClient["screenshot"]>>().resolves.toEqualTypeOf<
      BrowxaiResult | ScreenshotFileResult
    >();
  });

  it("callTool takes the expected result type as a type argument", () => {
    expectTypeOf<ReturnType<BrowxaiClient["callTool"]>>().resolves.toBeUnknown();
    // Never called: only its type is read.
    const probe = (c: BrowxaiClient) => c.callTool<{ ok: boolean }>("x");
    expectTypeOf(probe).returns.resolves.toEqualTypeOf<{ ok: boolean }>();
  });
});
