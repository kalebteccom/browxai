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
import type { BrowxaiClient } from "../../src/sdk/types.js";
import type {
  FindArgs,
  FindResult,
  NavigateArgs,
  NavigateResult,
  FindResultData,
} from "../../src/sdk/tool-types.js";

describe("BrowxaiClient — per-tool typed methods", () => {
  it("navigate accepts url-only args and returns ActionResult", () => {
    expectTypeOf<Parameters<BrowxaiClient["navigate"]>[0]>().toEqualTypeOf<NavigateArgs>();
    expectTypeOf<ReturnType<BrowxaiClient["navigate"]>>().resolves.toEqualTypeOf<NavigateResult>();
    // Stand-in for "compiles": NavigateArgs requires `url`.
    expectTypeOf<NavigateArgs>().toMatchTypeOf<{ url: string }>();
  });

  it("find returns FindResult whose data is FindResultData | undefined", () => {
    expectTypeOf<Parameters<BrowxaiClient["find"]>[0]>().toEqualTypeOf<FindArgs>();
    expectTypeOf<ReturnType<BrowxaiClient["find"]>>().resolves.toEqualTypeOf<FindResult>();
    // The envelope's `data` carries the per-tool shape.
    type FindData = Awaited<ReturnType<BrowxaiClient["find"]>>["data"];
    expectTypeOf<FindData>().toEqualTypeOf<FindResultData | undefined>();
  });
});
