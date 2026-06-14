// L2 (single source of truth) — freeze TOOL_CAPABILITY against the live
// registration set.
//
// The audit's policy-util guardrail-gap #1: a tool can be registered but missing
// from TOOL_CAPABILITY (src/util/capabilities.ts:87), so `isToolEnabled` silently
// falls back to the `human` default (capabilities.ts:574 — `if (!cap) return true`)
// — a silently WEAKER gate, the exact L9 failure mode. This freeze makes that
// regression loud: a new tool that forgets its capability row fails here, in the
// fast lane, the moment it registers.
//
// P0 stance (frozen, not derived): the map is still hand-maintained today, so the
// test freezes it against the registration set rather than deriving it. P2 (D2)
// colocates the capability at `host.register` and flips this from a freeze to a
// derivation check (derived map ≡ registration set), at which point the
// KNOWN_MISSING exemption below is removed because every row is derived from the
// capability the tool's description already declares.

import { describe, it, expect } from "vitest";
import { TOOL_CAPABILITY } from "../../src/util/capabilities.js";
import { registeredToolNames } from "./_surface.js";

// The 10 control-plane coordination primitives that legitimately have NO browser
// capability and default to `human`: session lifecycle, batch orchestration,
// config, and the approval workflow. These are the SANCTIONED human-defaults —
// deliberately NOT the read/action tools (see KNOWN_MISSING below).
const HUMAN_DEFAULT_ALLOWLIST = new Set<string>([
  "open_session",
  "close_session",
  "close_sessions",
  "list_sessions",
  "batch",
  "get_config",
  "set_config",
  "reset_config",
  "approve_actions",
  "list_approvals",
]);

// KNOWN-GAP (P0 only). These 7 tools genuinely lack a TOOL_CAPABILITY row TODAY,
// so a "zero undeclared" assertion would FAIL the P0 gate. They are NOT
// human-default coordination primitives — they each declare their capability in
// their description (`read` for the four list/read tools, `action` for the three
// mutating ones) and SHOULD carry a row. P0's job is to instrument, not to fix
// src/, so this set tracks the gap explicitly and keeps the freeze green.
//
// This is deliberately a SEPARATE, commented set from HUMAN_DEFAULT_ALLOWLIST —
// it documents a debt to pay, not a sanctioned default. P2 (D2) adds these
// `read` + `action` rows and REMOVES this exemption; after that the freeze holds
// with no known gap (the row derives from the description's declared capability).
const KNOWN_MISSING = new Set<string>([
  // declare "Capability: `read`" in their description (plugin-runtime.ts:216,246
  // / gesture-network-tools.ts:504,578) but carry no TOOL_CAPABILITY row.
  "plugins_list",
  "plugins_info",
  "workers_list",
  "worker_messages_read",
  // declare "Capability: `action`" (gesture-network-tools.ts:538,615,662) but
  // carry no TOOL_CAPABILITY row.
  "worker_message_send",
  "sw_intercept_fetch",
  "sw_unintercept_fetch",
]);

describe("L2 — every registered tool declares a capability (frozen)", () => {
  it("no tool silently falls back to the human default (allowlist + known-gap exempt)", async () => {
    const names = await registeredToolNames();
    const undeclared = names.filter(
      (n) => !(n in TOOL_CAPABILITY) && !HUMAN_DEFAULT_ALLOWLIST.has(n) && !KNOWN_MISSING.has(n),
    );
    expect(undeclared, `tools missing a TOOL_CAPABILITY entry: ${undeclared.join(", ")}`).toEqual(
      [],
    );
  });

  it("the known-gap set is real — each is registered and still missing its row", async () => {
    // Guards the exemption itself: if P2 adds a row (or a tool is removed), the
    // KNOWN_MISSING entry is stale and this fails, forcing the exemption to shrink
    // in lockstep with the fix. A stale exemption can never silently widen the gate.
    const names = new Set(await registeredToolNames());
    const stillRegistered = [...KNOWN_MISSING].filter((n) => names.has(n));
    expect(stillRegistered.sort(), "every KNOWN_MISSING tool must still be registered").toEqual(
      [...KNOWN_MISSING].sort(),
    );
    const stillMissing = [...KNOWN_MISSING].filter((n) => !(n in TOOL_CAPABILITY));
    expect(
      stillMissing.sort(),
      "a KNOWN_MISSING tool gained a TOOL_CAPABILITY row — remove it from the exemption (P2)",
    ).toEqual([...KNOWN_MISSING].sort());
  });

  it("no stale TOOL_CAPABILITY entry survives a removed tool", async () => {
    const names = new Set(await registeredToolNames());
    const stale = Object.keys(TOOL_CAPABILITY).filter((n) => !names.has(n));
    expect(stale, `stale capability rows: ${stale.join(", ")}`).toEqual([]);
  });
});
