// L2 (single source of truth) — DERIVED TOOL_CAPABILITY ≡ the registration set.
//
// RFC 0004 P2 (D2) colocated each tool's capability at its `host.register` call;
// `TOOL_CAPABILITY` (src/util/capabilities.ts) is now DERIVED from those
// registrations, not hand-maintained. This suite flipped from a FREEZE (P0) to a
// DERIVATION check: it asserts the derived map equals the registration set — a
// stronger invariant that cannot be satisfied by hand-editing one side.
//
// The 7-tool gate gap the P0 freeze tracked (plugins_list / plugins_info /
// workers_list / worker_messages_read → `read`; worker_message_send /
// sw_intercept_fetch / sw_unintercept_fetch → `action`) is CLOSED: each now
// self-declares its capability at registration, so the derived map GAINS its row
// and the tool is capability-gated where it silently defaulted to `human` before.
// `KNOWN_MISSING` is therefore empty and the exemption is gone.

import { describe, it, expect } from "vitest";
// Load the tools-layer bootstrap so the derived `TOOL_CAPABILITY` Proxy is
// populated for the synchronous reads below (the D2 iteration assertion reads it
// directly, not via `registeredToolNames`).
import "../../src/tools/tool-metadata.js";
import { TOOL_CAPABILITY, type Capability } from "../../src/util/capabilities.js";
import { registeredToolNames } from "./_surface.js";

// The 10 control-plane coordination primitives that legitimately have NO browser
// capability and default to `human`: session lifecycle, batch orchestration,
// config, and the approval workflow. These are the SANCTIONED human-defaults —
// they declare no `capability` at registration on purpose.
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

describe("L2 — every registered tool declares a capability (derived)", () => {
  it("no tool silently falls back to the human default (only the sanctioned allowlist)", async () => {
    const names = await registeredToolNames();
    const undeclared = names.filter(
      (n) => !(n in TOOL_CAPABILITY) && !HUMAN_DEFAULT_ALLOWLIST.has(n),
    );
    expect(undeclared, `tools missing a TOOL_CAPABILITY entry: ${undeclared.join(", ")}`).toEqual(
      [],
    );
  });

  it("the 7 former gate-gap tools now carry a derived capability row (P2 gap-closure)", async () => {
    // These declared their capability in their description but had NO row before
    // P2, so isToolEnabled silently passed them through the human default. P2's
    // colocated metadata closes the gap: each now has a derived row and is gated.
    const expected: Record<string, string> = {
      plugins_list: "read",
      plugins_info: "read",
      workers_list: "read",
      worker_messages_read: "read",
      worker_message_send: "action",
      sw_intercept_fetch: "action",
      sw_unintercept_fetch: "action",
    };
    const names = new Set(await registeredToolNames());
    for (const [tool, cap] of Object.entries(expected)) {
      expect(names.has(tool), `${tool} should still be registered`).toBe(true);
      expect(TOOL_CAPABILITY[tool], `${tool} should now gate under "${cap}"`).toBe(cap);
    }
  });

  it("the TOOL_CAPABILITY Proxy has Map-parity iteration (D2 — Symbol.iterator)", async () => {
    // RFC 0004 P2 / D2: the back-compat Record Proxy now exposes Symbol.iterator
    // delegating to the backing Map, so `for..of` / spread work like a Map (not
    // just `Object.entries`). The entry view must match the by-key/ownKeys views.
    const iterable = TOOL_CAPABILITY as unknown as Iterable<[string, Capability]>;
    const spread = [...iterable];
    // Spread yields [tool, capability] pairs and matches the key enumeration.
    const keysFromSpread = new Set(spread.map(([name]) => name));
    expect(keysFromSpread).toEqual(new Set(Object.keys(TOOL_CAPABILITY)));
    // for..of sees the same entries, and each capability matches the by-key read.
    let count = 0;
    for (const [tool, cap] of iterable) {
      expect(TOOL_CAPABILITY[tool]).toBe(cap);
      count++;
    }
    expect(count).toBe(Object.keys(TOOL_CAPABILITY).length);
    // A concrete spot-check: eval_js is present in the iteration under `eval`.
    expect(spread.find(([name]) => name === "eval_js")?.[1]).toBe("eval");
  });

  it("no stale TOOL_CAPABILITY entry survives a removed tool (every derived row is real)", async () => {
    const names = new Set(await registeredToolNames());
    const stale = Object.keys(TOOL_CAPABILITY).filter((n) => !names.has(n));
    expect(stale, `stale capability rows: ${stale.join(", ")}`).toEqual([]);
  });

  it("the derived map and the registration set partition every tool exactly", async () => {
    // The strong derivation invariant: every registered tool is EITHER in the
    // derived capability map OR a sanctioned human-default — never neither (a
    // silent gap) and never an orphan row with no tool (covered above).
    const names = await registeredToolNames();
    const partitioned = names.every((n) => n in TOOL_CAPABILITY || HUMAN_DEFAULT_ALLOWLIST.has(n));
    expect(partitioned, "every tool is gated or a sanctioned human-default").toBe(true);
    // and the derived map is exactly the registered, capability-carrying tools.
    const derivedKeys = new Set(Object.keys(TOOL_CAPABILITY));
    const registeredWithCap = names.filter((n) => !HUMAN_DEFAULT_ALLOWLIST.has(n));
    const onlyInDerived = [...derivedKeys].filter((n) => !names.includes(n));
    expect(onlyInDerived, "derived rows with no registration").toEqual([]);
    expect(
      registeredWithCap.filter((n) => !derivedKeys.has(n)),
      "registered non-human tools missing a derived row",
    ).toEqual([]);
  });
});
