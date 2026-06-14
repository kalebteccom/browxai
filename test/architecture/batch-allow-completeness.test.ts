// L2 (single source of truth) — freeze BATCH_ALLOWED_TOOLS against the live
// registration set.
//
// `BATCH_ALLOWED_TOOLS` (src/tools/host-build.ts:640-712, 71 entries) is the
// hand-maintained whitelist of tools a compound/batch tool may dispatch to. It
// is a local `const`, NOT exported, surfaced only via the read-only
// `ToolHost.batchAllowedTools` member (host.ts:160) — so this suite reads it off
// a built host (see _surface.ts), never by import.
//
// P0 stance (frozen, not derived): two invariants — no ghost (every batchable
// name is a real registered tool) and the size freeze (71). P2 (D2) derives the
// set from a `{ batchable: true }` flag at `host.register`, at which point these
// invert into a derivation check (every flagged registration ⇔ membership).

import { describe, it, expect } from "vitest";
import { registeredToolNames, batchAllowedTools } from "./_surface.js";

describe("L2 — the batch allow-set is real and frozen", () => {
  it("every batchable tool is a registered tool (no ghost in the 71-entry set)", async () => {
    const names = new Set(await registeredToolNames());
    const batch = await batchAllowedTools(); // ToolHost.batchAllowedTools — host.ts:160
    const ghosts = [...batch].filter((t) => !names.has(t));
    expect(
      ghosts,
      `BATCH_ALLOWED_TOOLS names with no registered tool: ${ghosts.join(", ")}`,
    ).toEqual([]);
  });

  it("the batch set is frozen at its current size (P0 snapshot)", async () => {
    // 71 today (host-build.ts:640-712). The freeze bites: any 72nd entry, or a
    // dropped one, fails until the change is reviewed. Post-D2 this becomes the
    // derivation check (every `{ batchable: true }` registration ⇔ membership).
    expect((await batchAllowedTools()).size).toBe(71);
  });
});
