// L2 (single source of truth) — DERIVED batch allow-set ≡ the `{ batchable: true }`
// registrations.
//
// `BATCH_ALLOWED_TOOLS` (src/tools/host-build.ts) is no longer a hand-maintained
// literal: RFC 0004 P2 (D2) derives it from each `register({ batchable: true })`
// call. The set is surfaced via the read-only `ToolHost.batchAllowedTools` member
// (host.ts) and read off a built host (see _surface.ts), never by import.
//
// This suite flipped from a FREEZE (P0) to a DERIVATION check: every tool that
// registered `{ batchable: true }` appears in the set, and nothing else does —
// proving the derivation, which is what let the hand-list disappear. The 71-entry
// size stays the behaviour-preservation oracle against the P0 snapshot.

import { describe, it, expect } from "vitest";
import { registeredToolNames, batchAllowedTools, toolRegistrations } from "./_surface.js";

describe("L2 — the batch allow-set is derived from the registrations", () => {
  it("every batchable tool is a registered tool (no ghost)", async () => {
    const names = new Set(await registeredToolNames());
    const batch = await batchAllowedTools();
    const ghosts = [...batch].filter((t) => !names.has(t));
    expect(ghosts, `batch-allowed names with no registered tool: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("the derived set is exactly the `{ batchable: true }` registrations", async () => {
    const table = await toolRegistrations();
    const flagged = new Set([...table].filter(([, m]) => m.batchable).map(([name]) => name));
    const batch = await batchAllowedTools();
    const onlyInSet = [...batch].filter((t) => !flagged.has(t));
    const onlyFlagged = [...flagged].filter((t) => !batch.has(t));
    expect(onlyInSet, "in the batch set but not flagged batchable").toEqual([]);
    expect(onlyFlagged, "flagged batchable but missing from the batch set").toEqual([]);
  });

  it("the derived set equals the P0 snapshot size (behaviour preserved at 71)", async () => {
    // 71 today. The derivation must reproduce the frozen snapshot exactly: a 72nd
    // batchable tool, or a dropped one, shifts this and is reviewed.
    expect((await batchAllowedTools()).size).toBe(71);
  });
});
