# RFC 0004 / Reference 05 — Fitness functions & guardrails (the executable architecture)

**Parent:** [`0004-architecture-hardening.md`](../0004-architecture-hardening.md). This is the guardrail spec — the concrete config and code for every mechanized enforcer named in the parent's ten laws (L1–L10) and decisions D8–D12. Where the parent says "enforced by an executable fitness function," this document is that function: the custom ESLint rules, the `test/architecture/**` fitness suite, the `dependency-cruiser` layering config, the numeric budgets, the tool-types codegen, the CI wiring, and the meta-rule that keeps a guardrail from quietly dying via an inline disable.

The thesis of RFC 0004 is that browxai's **doctrine is excellent and unenforced** — every one of the 80 audited defects ([`0004-01-current-state-audit.md`](0004-01-current-state-audit.md)) was committed *through a green gate*. The refactor ([`0004-04-refactor-plan.md`](0004-04-refactor-plan.md)) pays down the debt; **this document is what stops it re-accruing.** It is the answer to theme T7 (the guardrail vacuum) and to decision D9 ("every architectural invariant gets an executable fitness function"). It does not restate the doctrine — for the principles see [`architecture-principles.md`](../../ai-context/architecture/architecture-principles.md); for the micro-rules see [`code-quality.md`](../../ai-context/agent-process/code-quality.md); this is the *enforcement layer* those two documents have lacked.

---

## 0. The enforcement model: four layers, fastest-feedback-first

A guardrail is only useful at the speed it fires. browxai's existing harness already proves this instinct — `no-tracker-ids-in-comments` and `no-page-eval-stringified-arrow` are lint rules, not review notes, because lint fires in the editor and review fires days later. We extend the same instinct across all four feedback layers, and we place each invariant at the *earliest* layer that can express it:

| Layer | Fires | Mechanism | Catches | Cost |
|-------|-------|-----------|---------|------|
| **L-lint** | keystroke / `pnpm lint` | custom ESLint rules + built-in budgets | engine-literal branches, inlined gates, unbounded loops, oversized files/functions | ~0, AST-only |
| **L-graph** | `pnpm lint` / CI | `dependency-cruiser` | layering / DIP violations (server→sdk, page→adapter, core→cli) | seconds, import-graph only |
| **L-fit** | `pnpm test` (fast lane) | `test/architecture/**` vitest, static analysis | OCP regression, completeness/traceability, port-conformance, codegen-drift, assertion density | sub-second, no browser |
| **L-keystone** | `pnpm test:keystone` | real-browser `test/keystone/**` | behavior preservation across five engines; the mock-engine OCP contract | minutes, one fork |

The load-bearing design choice — restated from RFC 0004 §8's "the fitness suite is slow" risk — is that **the entire `test/architecture/**` suite is static.** It reads source as text/AST, reads the registration maps as values, and walks the import graph. It never launches a browser. It runs inside the hermetic `pnpm test` lane ([`vitest.config.ts`](../../../vitest.config.ts), which excludes `test/keystone/**`), so an agent gets OCP/completeness feedback in the same sub-second loop as a unit test. Exactly **one** fitness function touches the runtime — the engine-adapter-contract (§2b) — and it uses an in-memory fake `BrowserEngine`, no Chromium download, so it can live in either lane; we site it in the keystone lane only because it exercises the real session-registry wiring.

A note on the existing flat-config shape this extends: `eslint.config.js` already defines its two custom rules as plain objects with `meta`/`create`, bundles them under a local plugin namespace `browxai-local` (`eslint.config.js:108-113`), and wires them as `error` in both the JS block (`:148-149`) and the type-aware TS block (`:242-243`). Every new rule below mirrors that exact structure — same `meta.type: "problem"`, same `schema: []`, same `create(context)` visitor shape, same `browxai-local/` prefix — so there is one rule idiom in the tree, not two.

---

## 1. Custom ESLint rules (L-lint)

Three new custom rules join `no-tracker-ids-in-comments` and `no-page-eval-stringified-arrow`: `no-engine-literal-branches` (L1), `no-inlined-capability-checks` (the SRP gate-centralization half of L3), and `bounded-resource` (L7, best-effort). The size/complexity budgets in §1.5 ride the built-in ESLint rules, not custom code. The two custom OCP/SRP rules ship `warn` in P0 (scoped to *new* violations against today's tree), promoted to `error` in the phase that lands the matching refactor (P1 for engine-literal, P2 for capability-gate); the `bounded-resource` rule is advisory and stays `warn`, per RFC 0004 §6.

### 1.1 `no-engine-literal-branches` — enforces L1 (the closed core)

The single most important rule. The audit's headline defect (T1) is that engine *wiring* is hardcoded `if (engine === "literal")` across three session factories, the 17 scattered Safari guards in `session-registry.ts`, and the substrate selectors — so a sixth engine requires editing 5–8 existing files. The flagship claim *"new engine = new adapter behind the existing port"* (architecture-principles §4) is false today, and the audit found **no lint rule prevents a future handler author from inlining the same anti-pattern** (`harness-and-docs` finding, [`0004-01`](0004-01-current-state-audit.md)).

This rule flags a string comparison against a known `EngineKind` literal (`"chromium" | "firefox" | "webkit" | "android" | "safari"`, from `src/engine/types.ts:25`) — `engine === "safari"`, `session.engine !== "chromium"`, `e.session.engine === "firefox"`, and the `switch (engine) { case "firefox": }` form — **outside an allowlist of files whose job is engine selection.** The allowlist is the substrate selectors and the (post-D1) `EngineRegistry`, the only legitimate homes for engine dispatch:

```js
// eslint.config.js — joins noTrackerIdsInComments / noPageEvalStringifiedArrow

const ENGINE_KINDS = ["chromium", "firefox", "webkit", "android", "safari"];

// Files whose single responsibility IS engine selection. Engine literals are
// the point here, not a leak. Post-D1 this list shrinks to the EngineRegistry
// + the capability-driven substrate selectors; today it names the selectors
// that already key on `session.engine === "safari"` by design
// (snapshot-substrate-select.ts:44, network-substrate-select.ts:44).
// NOTE: select.ts and capabilities.ts are FILES, registry.ts is the post-D1 file,
// and adapters/ is a directory — so the file homes need `\.ts$` anchors and only
// adapters/ is a directory prefix. A bare `(registry|select|capabilities|adapters)\/`
// would match none of the real .ts files and silently fail to allowlist them.
const ENGINE_SELECT_ALLOWLIST = [
  /src\/engine\/(registry|select|capabilities)\.ts$/, // the engine-select FILES
  /src\/engine\/adapters\//, //                          the adapters DIRECTORY
  /src\/page\/snapshot-substrate-select\.ts$/,
  /src\/page\/network-substrate-select\.ts$/,
];

const noEngineLiteralBranches = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow branching on an EngineKind string literal outside the engine-select layer. " +
        "Engine dispatch belongs in the EngineRegistry / substrate selectors, not in handlers.",
    },
    schema: [],
    messages: {
      engineLiteral:
        'Engine dispatch on the literal "{{ engine }}" does not belong here. A handler must be ' +
        "engine-agnostic: route through the capability substrates (actionsFor / captureFor / " +
        "snapshotSubstrateFor / networkSubstrateFor) or the EngineRegistry, never an " +
        "`engine === \"{{ engine }}\"` branch. See architecture-principles.md §4 and RFC 0004 L1.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (ENGINE_SELECT_ALLOWLIST.some((re) => re.test(filename))) return {};

    const flagIfEngineLiteral = (node, literalNode) => {
      if (
        literalNode &&
        literalNode.type === "Literal" &&
        typeof literalNode.value === "string" &&
        ENGINE_KINDS.includes(literalNode.value)
      ) {
        context.report({
          node,
          messageId: "engineLiteral",
          data: { engine: literalNode.value },
        });
      }
    };

    return {
      // `x === "safari"`, `x !== "firefox"`
      BinaryExpression(node) {
        if (node.operator !== "===" && node.operator !== "!==") return;
        flagIfEngineLiteral(node, node.right);
        flagIfEngineLiteral(node, node.left);
      },
      // `case "webkit":`
      SwitchCase(node) {
        flagIfEngineLiteral(node, node.test);
      },
    };
  },
};
```

Note the rule deliberately keys on the **literal value being an `EngineKind`**, not on the identifier name being `engine` — so `mode === "incognito"` (a session mode, audited separately under D6) is untouched, but `x === "safari"` is caught regardless of what `x` is called. The allowlist regexes are the rule's escape valve; widening the allowlist is itself a guardrail-relaxation event subject to the §7 meta-rule.

This rule is the lint half of L1; its test half is the engine-adapter-contract keystone (§2b). Together they make the OCP claim *checkable* rather than *documented*.

### 1.2 `no-inlined-capability-checks` — enforces SRP (L3) at the gate

`code-quality.md` states "a tool handler MUST NOT inline capability checks" — the shared gate lives in `ToolHost.gateCheck` (`src/tools/host.ts:71`, implemented at `host-build.ts:152`) and the engine gate in `ToolHost.engineGate` (`host.ts:75`). The audit found **no rule flags `if (capabilities.includes(...))` inside a handler** (`harness-and-docs`); a developer can scatter gate logic across N handlers with zero lint failure, which is both an SRP violation and an audit-surface hazard (the gate exists precisely to centralize the security decision).

The rule flags member access against the resolved capability set — `caps.enabled.has(...)`, `capabilities.includes(...)`, `caps.enabled.includes(...)` — and direct reads of the `TOOL_CAPABILITY` map (`src/util/capabilities.ts:87`) inside the handler layer (`src/page/**`, `src/tools/*-tools.ts`), with the gate's own home files (`host.ts`, `host-build.ts`, `util/capabilities.ts`) allowlisted:

```js
const GATE_OWNER_ALLOWLIST = [
  /src\/tools\/host(-build)?\.ts$/,
  /src\/util\/capabilities\.ts$/,
  /src\/engine\/tool-gate\.ts$/,
];

const noInlinedCapabilityChecks = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow inlined capability-gate logic in handlers. Route through " +
        "ToolHost.gateCheck (capability dimension) / ToolHost.engineGate (engine dimension).",
    },
    schema: [],
    messages: {
      inlined:
        "Inlined capability check ('{{ snippet }}'). The gate is centralized: call " +
        "`const g = gateCheck(toolName); if (g) return g;` (or `engineGate` for the engine " +
        "dimension) at the top of the handler. Scattered gate logic breaks SRP and the audit " +
        "surface. See code-quality.md SOLID §, RFC 0004 L3.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (GATE_OWNER_ALLOWLIST.some((re) => re.test(filename))) return {};

    const CAP_OBJECTS = new Set(["caps", "capabilities"]);
    const CAP_METHODS = new Set(["has", "includes"]);

    return {
      // caps.enabled.has(...) / capabilities.includes(...)
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (!callee.property || !CAP_METHODS.has(callee.property.name)) return;
        // Walk the member chain root.
        let root = callee.object;
        while (root.type === "MemberExpression") root = root.object;
        if (root.type === "Identifier" && CAP_OBJECTS.has(root.name)) {
          context.report({
            node,
            messageId: "inlined",
            data: { snippet: context.sourceCode.getText(node).slice(0, 48) },
          });
        }
      },
      // direct read of the TOOL_CAPABILITY map outside the gate owners
      Identifier(node) {
        if (node.name === "TOOL_CAPABILITY") {
          context.report({ node, messageId: "inlined", data: { snippet: "TOOL_CAPABILITY" } });
        }
      },
    };
  },
};
```

### 1.3 `bounded-resource` — enforces L7 (bounded everything), best-effort

L7 — *"every loop, buffer, ring, recursion, and wait has an explicit, tested bound"* — is the Power-of-Ten "bounded loops" rule adapted to TypeScript. The two concrete gaps the audit surfaced are exactly the two genuinely-unbounded sites (the network/console rings are *not* among them — they already cap at 500, `network.ts:338`): `perf-audit.ts`'s `enforceSummaryBudget` runs nested `while` loops re-estimating tokens with "no hard safety bound" and an O(N²) risk (`page-features` finding, `perf-audit.ts:524-583`), and the a11y tree-walk's *undeclared depth* — the `walk` generator (`src/page/a11y.ts:205-211`) is iterative but carries no declared depth cap, so a pathological tree is bounded only by memory (02 §4.2).

A linter cannot prove termination (halting problem), so this rule is honestly **best-effort and advisory** — it ships `warn`, never `error`, and exists to *force a human decision at the loop*, not to verify the bound. It flags a `while` / `for` (classic) / `for…of` / `do-while` loop that lacks **both** an obvious counter-comparison test (`i < N`, `i < arr.length`) **and** a `cap`/`bound`/`limit`/`max` comment within two lines — so a counted `for (let i = 0; i < n; i++)` passes, while `for (;;)`, `for (; cond;)`, and an uncommented `for…of`/`while` are flagged. Same "make the author state the bound" posture as the tracker-id rule:

```js
const noBoundComment = /\b(cap|bound|bounded|limit|max|guard)\b/i;

const boundedResource = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Flag potentially-unbounded loops (while / for / for-of / do-while without an explicit counter bound) " +
        "that lack a nearby cap/bound comment. Best-effort: prompts the author to state the bound.",
    },
    schema: [],
    messages: {
      unbounded:
        "This loop has no obvious counter bound and no cap/bound comment nearby. " +
        "L7 (bounded everything) requires an explicit, tested bound on every loop, ring, and " +
        "wait — even `while (true)` rings need a `// cap: N` and a break. State the bound in a " +
        "comment (and assert it), or rewrite as a counted loop.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const hasNearbyBoundComment = (node) => {
      const before = sourceCode.getCommentsBefore(node);
      const inside = sourceCode.getCommentsInside(node);
      return [...before, ...inside].some((c) => noBoundComment.test(c.value));
    };
    const looksCounted = (test) =>
      test &&
      test.type === "BinaryExpression" &&
      ["<", "<=", ">", ">="].includes(test.operator);

    const check = (node) => {
      if (node.test && looksCounted(node.test)) return; // counted for/while — fine
      if (hasNearbyBoundComment(node)) return; // author declared the bound
      context.report({ node, messageId: "unbounded" });
    };
    // ForStatement covers the classic `for (;;)` / `for (; cond;)` — the most common
    // unbounded loop; `check` reads its `.test` (null for `for(;;)` ⇒ flagged).
    return {
      WhileStatement: check,
      DoWhileStatement: check,
      ForStatement: check,
      ForOfStatement: check,
    };
  },
};
```

### 1.4 Wiring the three new rules

The local plugin object gains the new rules; the two rule blocks turn them on. The shape is identical to the existing `browxai-local` registration:

```js
const browxaiLocal = {
  rules: {
    "no-tracker-ids-in-comments": noTrackerIdsInComments,
    "no-page-eval-stringified-arrow": noPageEvalStringifiedArrow,
    "no-engine-literal-branches": noEngineLiteralBranches,        // L1
    "no-inlined-capability-checks": noInlinedCapabilityChecks,    // L3
    "bounded-resource": boundedResource,                         // L7 (best-effort)
  },
};

// …in the TS rules block (eslint.config.js:179-244):
"browxai-local/no-engine-literal-branches": "error",   // warn in P0, error in P1
"browxai-local/no-inlined-capability-checks": "error", // warn in P0, error in P2
"browxai-local/bounded-resource": "warn",              // advisory, stays warn
```

### 1.5 The budget rules (built-ins) — enforces L3 / D11

The size and complexity budgets (D11 — "budgets, not vibes") ride the built-in ESLint rules, no custom code needed. They are sized from the **current healthy modules**, not the god-modules, so they are a ratchet that holds *after* the D3 split lands rather than an aspiration the god-modules already blow through. They ship `warn` in P0 (visible, non-blocking) and promote to `error` in P3 once the split brings the offenders under budget:

```js
// scoped to the tool/handler layer; server.ts gets a tighter ceiling (§4).
{
  files: ["src/tools/*-tools.ts", "src/page/**/*.ts"],
  rules: {
    "max-lines": ["warn", { max: 450, skipBlankLines: true, skipComments: true }],
    "max-lines-per-function": ["warn", { max: 70, skipBlankLines: true, skipComments: true }],
    "complexity": ["warn", { max: 15 }],
    "max-params": ["warn", { max: 5 }],
  },
},
{
  files: ["src/server.ts"],
  rules: { "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }] },
},
```

The numeric rationale is in §4. The `max-lines-per-function` budget also has an exemption interaction worth noting: `src/server.ts` and `src/tools/*.ts` are already exempted from `require-await` because the MCP SDK forces `async` handlers (`eslint.config.js:288-293`); the budget rules layer *on top of* that block, they do not conflict with it.

---

## 2. The fitness-test suite (L-fit) — `test/architecture/**`

Plain vitest, static analysis, fast lane. The suite is the executable form of L2 (single source of truth), L5 (substitutable adapters), L9 (traceability), and the OCP heart of D9. It imports the **real** exported registration values (`TOOL_CAPABILITY`, `DEEP_TOOLS`, `ENGINE_KINDS`, `capabilitiesFor`) and reads the real `createServer` handler table. Note `BATCH_ALLOWED_TOOLS` is **not** exported — it is a local `const` (`src/tools/host-build.ts:640-712`, 71 entries) surfaced only via the `ToolHost.batchAllowedTools` member (`host.ts:160`), so the batch test reads it off a built host, never by import. The suite asserts the invariants the audit found unguarded.

A scaffolding helper every test reuses — read the registered surface once, statically, by building a server with no browser opens:

```ts
// test/architecture/_surface.ts — the static surface under test
import { createServer } from "../../src/server.js";
import { buildHost } from "../../src/tools/host-build.js";

/** Build the server far enough to enumerate the registered handler table.
 *  createServer wires every registerXxxTools(host) module at construction and
 *  exposes `handlers` (server.ts:149-156, :380) WITHOUT opening a browser — the
 *  session is lazy. So the full tool surface is inspectable with zero engine. */
export async function registeredToolNames(): Promise<string[]> {
  const server = await createServer({ headless: true });
  return Object.keys(server.handlers);
}

/** The batch allow-set, read OFF a built ToolHost. `BATCH_ALLOWED_TOOLS` is a
 *  local `const` (`host-build.ts:640-712`) — NOT exported — surfaced only via the
 *  `ToolHost.batchAllowedTools` member (`host.ts:160`). The host is `buildHost(deps)`
 *  (`host-build.ts:116`); `makeTestHostDeps()` is a *test fixture this suite adds*
 *  (it assembles the same headless `HostDeps` `createServer` builds, no browser open),
 *  so the set is inspectable statically. This is the only sanctioned read of the batch
 *  set — never an import of the const. */
export async function batchAllowedTools(): Promise<ReadonlySet<string>> {
  // makeTestHostDeps: a fixture the architecture-test suite defines (not an existing
  // export) — it mints a headless HostDeps so buildHost runs without opening a browser.
  const host = buildHost(await makeTestHostDeps());
  return host.batchAllowedTools;
}
```

### 2a. Completeness fitness tests — enforces L2

These freeze the central maps today (P0) and become *derivation checks* after D2 colocates metadata at `host.register` (P2). Each closes a named guardrail gap from the audit.

**Every registered tool has a capability** (audit: *"no test enforces TOOL_CAPABILITY completeness"*; *"a tool can be registered but missing from the map, causing isToolEnabled to silently default to 'human'"*). The fallback-to-`human` is a *silently weaker gate* — the exact failure mode L9 forbids:

```ts
// test/architecture/completeness.test.ts
import { describe, it, expect } from "vitest";
import { TOOL_CAPABILITY } from "../../src/util/capabilities.js";
import { registeredToolNames } from "./_surface.js";

describe("L2 — every registered tool declares a capability", () => {
  it("no tool silently falls back to the human default", async () => {
    const names = await registeredToolNames();
    // The 10 control-plane coordination primitives that legitimately have NO
    // browser capability and default to human: session lifecycle, batch
    // orchestration, config, and the approval workflow. (Deliberately NOT the
    // read/action tools — see the note after this block for why.)
    const HUMAN_DEFAULT_ALLOWLIST = new Set<string>([
      "open_session", "close_session", "close_sessions", "list_sessions",
      "batch", "get_config", "set_config", "reset_config",
      "approve_actions", "list_approvals",
    ]);
    const undeclared = names.filter(
      (n) => !(n in TOOL_CAPABILITY) && !HUMAN_DEFAULT_ALLOWLIST.has(n),
    );
    expect(undeclared, `tools missing a TOOL_CAPABILITY entry: ${undeclared.join(", ")}`).toEqual([]);
  });

  it("no stale TOOL_CAPABILITY entry survives a removed tool", async () => {
    const names = new Set(await registeredToolNames());
    const stale = Object.keys(TOOL_CAPABILITY).filter((n) => !names.has(n));
    expect(stale, `stale capability rows: ${stale.join(", ")}`).toEqual([]);
  });
});
```

**This test earns its keep on first run.** Written against today's surface it immediately flags **seven** live tools that carry their capability _in the description_ but have **no `TOOL_CAPABILITY` row**, so `isToolEnabled` (`capabilities.ts:574` — `if (!cap) return true`) silently passes them through the human default — the exact L9 silent-weaker-gate failure: `plugins_list`, `plugins_info`, `workers_list`, `worker_messages_read` (all declare _"gates under `read`"_ / _"Capability: `read`"_ at `plugin-runtime.ts:216,246` / `gesture-network-tools.ts:504,578`) and `worker_message_send`, `sw_intercept_fetch`, `sw_unintercept_fetch` (all declare _"Capability: `action`"_ at `gesture-network-tools.ts:538,615,662`). They are **not** human-default coordination primitives and are deliberately absent from the allowlist above; P0 closes the gap by adding their four `read` + three `action` rows, after which the freeze holds green (D2 later _derives_ each row from the capability the description already declares, so the miss cannot recur). The fitness function found a real, security-relevant gate gap the moment it existed — which is the whole argument for writing it.

**Every batchable tool is in the batch set; every deep tool is gated; every `EngineKind` has a `CAPABILITIES` row.** Three more invariants, each a one-liner over a real exported value:

```ts
// test/architecture/completeness.test.ts (continued)
import { ENGINE_KINDS } from "../../src/engine/index.js";
import { capabilitiesFor } from "../../src/engine/index.js";
import { DEEP_TOOLS } from "../../src/engine/tool-gate.js";

describe("L2 — derived sets stay in sync with the surface", () => {
  it("every EngineKind has a capability declaration (no half-onboarded engine)", () => {
    // closes: "no unit test validates that all engines in EngineKind have a
    // corresponding CAPABILITIES entry (fail-fast for incomplete onboarding)".
    const missing = ENGINE_KINDS.filter((e) => capabilitiesFor(e) === undefined);
    expect(missing, `EngineKind without CAPABILITIES: ${missing.join(", ")}`).toEqual([]);
  });

  it("every DEEP_TOOLS entry is a registered tool (no gate drift to a ghost)", async () => {
    const names = new Set(await registeredToolNames());
    const ghosts = [...DEEP_TOOLS].filter((t) => !names.has(t));
    expect(ghosts, `DEEP_TOOLS names with no registered tool: ${ghosts.join(", ")}`).toEqual([]);
  });
});
```

**The batch allow-set is complete and real** (the `batch-allow-completeness.test.ts` 0004-04 P0 requires — *"freezes `BATCH_ALLOWED_TOOLS` against the registered set"*). Every name in the 71-entry batch set must be a registered tool (no ghost), and the set is read off a built host, not imported — because the const is not exported:

```ts
// test/architecture/batch-allow-completeness.test.ts
import { describe, it, expect } from "vitest";
import { registeredToolNames, batchAllowedTools } from "./_surface.js";

describe("L2 — the batch allow-set is real and frozen", () => {
  it("every batchable tool is a registered tool (no ghost in the 71-entry set)", async () => {
    const names = new Set(await registeredToolNames());
    const batch = await batchAllowedTools(); // ToolHost.batchAllowedTools — host.ts:160
    const ghosts = [...batch].filter((t) => !names.has(t));
    expect(ghosts, `BATCH_ALLOWED_TOOLS names with no registered tool: ${ghosts.join(", ")}`).toEqual([]);
  });

  it("the batch set is frozen at its current size (P0 snapshot)", async () => {
    // 71 today (`host-build.ts:640-712`). The freeze bites: any 72nd entry, or a
    // dropped one, fails until the change is reviewed. Post-D2 this becomes the
    // derivation check (every `{ batchable: true }` registration ⇔ membership).
    expect((await batchAllowedTools()).size).toBe(71);
  });
});
```

**Every deep tool refuses off the non-deep engines and runs on the deep ones** (the `deep-tools-engine-matrix.test.ts` 0004-04 P0 requires — closing the engine-adapters gap *"no suite validates every `DEEP_TOOLS` entry is unavailable on Firefox/WebKit"*). This is the engine dimension the DEEP_TOOLS-ghost test above does not cover; it drives the real `assertEngineSupports` (`tool-gate.ts:131`) across the full `EngineKind × DEEP_TOOLS` matrix:

```ts
// test/architecture/deep-tools-engine-matrix.test.ts
import { describe, it, expect } from "vitest";
import { assertEngineSupports, DEEP_TOOLS, ENGINE_KINDS, capabilitiesFor } from "../../src/engine/index.js";

describe("L2/L5 — every deep tool is gated by engine capability, not engine name", () => {
  // 31 deep tools (`tool-gate.ts:38-88`) × 5 engines. A deep engine (declares
  // `deep: true` — chromium, android) runs every deep tool; a non-deep engine
  // (firefox, webkit, safari) structured-refuses each one via assertEngineSupports.
  it.each(ENGINE_KINDS)("[%s] gates all 31 deep tools by its declared `deep`", (engine) => {
    const deep = capabilitiesFor(engine)?.deep ?? false;
    for (const tool of DEEP_TOOLS) {
      const refusal = assertEngineSupports(tool, engine);
      if (deep) {
        expect(refusal, `${tool} should run on deep engine ${engine}`).toBeNull();
      } else {
        expect(refusal, `${tool} should refuse on non-deep engine ${engine}`).not.toBeNull();
        expect(refusal!.error).toBe(`tool "${tool}" is not supported on the "${engine}" engine`);
      }
    }
  });
});
```

Post-D2, the batch and deep checks invert: instead of "every entry in the hand-list is real," they become "every tool that registered `{ batchable: true }` appears in the derived `batchAllowedTools` set, and nothing else does" — proving the *derivation*, which is what makes the hand-list disappearable. The `ToolHost.batchAllowedTools` member (`host.ts:160`) already exposes the set read-only, so the derived-set test reads it off a built host with no new plumbing.

**Tool-types ≡ schemas (post-codegen):** covered by the codegen-drift test in §5, which is L2 applied to `sdk/tool-types.ts`.

### 2b. The OCP regression tests — the heart of D9

Two tests. Together they are *the* fitness function for the open-closed claim: they prove a new capability and a new engine can be added **without editing core source.**

**Capability-extensibility** (audit: *"add test/unit/capabilities-ocp.test.ts that registers a synthetic capability in the gate via mocked ToolHost… prove extensibility WITHOUT touching src/util/capabilities.ts source"*). The test constructs a synthetic capability + a tool requiring it through a mock host, and asserts the gate **blocks when unset and allows when set** — with zero edits to `capabilities.ts`:

```ts
// test/architecture/ocp-capability.test.ts
import { describe, it, expect } from "vitest";
import { isToolEnabled, type CapabilityConfig } from "../../src/util/capabilities.js";

// ILLUSTRATIVE / post-D2: `isToolEnabled(tool, caps)` is 2-arg today
// (`src/util/capabilities.ts:574`). The 3-arg override form below is the D2
// surface change; until D2 lands this test is `.todo`/`.skip` so P0 stays
// gate-green. It pins the contract the derived gate must satisfy.
describe.todo("OCP — a capability gate is extensible without source edits (post-D2)", () => {
  // A synthetic tool→capability binding injected at the call site, NOT added to
  // the TOOL_CAPABILITY source map. Post-D2 this is exactly how a real tool
  // self-declares; today it proves the gate reads its decision from data.
  const SYNTH_TOOL = "__synthetic_probe__";
  const SYNTH_CAP = "ai-vision"; // a capability that does not exist in source

  const cfg = (enabled: string[]): CapabilityConfig =>
    ({ enabled: new Set(enabled), warnings: [] }) as unknown as CapabilityConfig;

  it("blocks the synthetic tool when its capability is not in the active set", () => {
    // isToolEnabled consults TOOL_CAPABILITY; a tool absent from the map falls
    // back to `human`. The OCP-correct fix (D2) lets the tool carry its own
    // capability; this test pins the contract the derived gate must satisfy:
    const blocked = isToolEnabled(SYNTH_TOOL, cfg(["read"]), { [SYNTH_TOOL]: SYNTH_CAP });
    expect(blocked).toBe(false);
  });

  it("allows the synthetic tool once its capability is active — no core edit", () => {
    const allowed = isToolEnabled(SYNTH_TOOL, cfg(["read", SYNTH_CAP]), { [SYNTH_TOOL]: SYNTH_CAP });
    expect(allowed).toBe(true);
  });
});
```

> The third argument to `isToolEnabled` is **post-D2 and illustrative** — the signature today is the 2-arg `isToolEnabled(tool, caps)` (`src/util/capabilities.ts:574`). The override-map form `isToolEnabled(tool, caps, overrides?)` is the D2 surface change that lets the binding be supplied by the registration rather than only read from the module-global `TOOL_CAPABILITY`. Because the 3-arg form does not exist until D2, the test above lands `.todo`/`.skip` in P0 (keeping P0 gate-green) and activates green when D2 introduces the override seam.

**The engine-adapter-contract keystone** (audit: *"add test/keystone/engine-adapter-contract.keystone.test.ts that mocks a new engine via a mock BrowserEngine adapter, registers it in the session WITHOUT editing src/session/*.ts, runs core tools (navigate, snapshot, find, click), asserts the mock engine's session.engine tag is reported correctly… This is the fitness function for OCP"*). This is **the** keystone of the whole RFC. It is the executable form of L1: a synthetic in-memory `BrowserSession` (`src/session/types.ts` — the type `makeAdapter` returns) that declares `deep: false` capabilities, registered through the post-D1 `EngineRegistry`, must drive the engine-agnostic core with **zero core edits** and report its `session.engine` tag correctly.

```ts
// test/keystone/engine-adapter-contract.keystone.test.ts
import { describe, it, expect } from "vitest";
import type { EngineCapabilities, EngineKind } from "../../src/engine/index.js";
import type { BrowserSession } from "../../src/session/types.js";
import { createServer } from "../../src/server.js";
// NOTE: `registerEngine` (src/engine/registry.ts) does NOT exist until D1/P1.
// A top-level `import { registerEngine } from "../../src/engine/registry.js"`
// would fail MODULE RESOLUTION even under `describe.todo` (todo skips execution,
// not the static import graph), breaking the P0 gate. So the registry is pulled
// in via a DYNAMIC import *inside* the activated test body below — it only
// resolves once the file is un-`.todo`'d in P1, after registry.ts lands.
// Engine selection is the SERVER-level concern: `createServer({ browserType })`
// (`src/server.ts:284`), NOT a per-session `open_session` arg — `open_session`'s
// schema carries `session`/`mode`/`profile`/…, never `browserType`.

// A 6th engine that exists ONLY in this test file. If adding it requires editing
// any src/session/*.ts or src/tools/host-build.ts file, this test cannot be
// written without that edit — and the OCP claim is false. The whole point is
// that the registration below is the ONLY new line.
const SYNTH: EngineKind = "synthetic" as EngineKind;

class InMemoryBrowserSession implements BrowserSession {
  readonly mode = "managed" as const; // SessionMode = "managed" | "byob" (session/types.ts:9)
  readonly ownsBrowser = true;
  readonly engine = SYNTH;
  // Carried as an EXTRA field (not a BrowserSession member) so the registration
  // below can read `.capabilities`; deep:false ⇒ no CDP escape hatch.
  readonly capabilities: EngineCapabilities = {
    engine: SYNTH,
    subInterfaces: new Set(["lifecycle", "navigation", "snapshot", "input"]),
    deep: false, // no CDP — proves the gate refuses deep tools without a per-engine edit
  };
  // page() backs onto an in-memory fake DOM the contract drives; cdp()/safari()
  // are absent (deep:false + has a Page), so requireCdp() must structured-refuse.
  page() { return this.fakePage; }
  async close() {}
  /* …fakePage: a minimal Playwright-Page-shaped stub… */
}

// In P0 this lands `.todo`/`.skip` (the `registerEngine` it dynamically imports
// does not exist until D1/P1), so P0 stays gate-green — and because the import is
// dynamic and inside the test body, P0 does not even resolve the missing module;
// it activates and goes green in P1.
describe.todo("L1 — a new engine adapter plugs in with zero core edits", () => {
  it("registers via registerEngine and drives navigate/snapshot/find/click", async () => {
    // Dynamic import: resolves only when this test runs (P1), never at P0 collection.
    const { registerEngine } = await import("../../src/engine/registry.js"); // lands D1/P1
    // The ONE line that adds an engine. No edit to managed.ts / incognito.ts /
    // byob.ts / session-registry.ts / host-build.ts. This is the documented
    // registry API (0004-03 §1 / 0004-04 P1), not an `EngineRegistry.register` method.
    registerEngine({
      kind: SYNTH,
      capabilities: new InMemoryBrowserSession().capabilities,
      makeAdapter: async () => new InMemoryBrowserSession(), // Promise<BrowserSession> per the contract
      makeSubstrates: () => inMemorySubstrateBundle(), // all 7 SubstrateBundle fields, in-memory
      postWire: () => {}, // the synthetic engine needs no extra bookkeeping
    }); // the complete unified EngineEntry shape (0004-03 §1)

    // Select the synthetic engine the only way the surface allows: at the SERVER
    // level (`createServer`'s `opts.browserType`, server.ts:284). `open_session`
    // has no `browserType` — the engine is the server's, the session inherits it.
    const server = await createServer({ headless: true, browserType: SYNTH });
    const open = await server.handlers.open_session({ session: "synth-a" });
    const session = JSON.parse((open.content[0] as { text: string }).text);
    expect(session.engine).toBe(SYNTH); // the tag is reported correctly

    // Core tools must be engine-agnostic — they reach the substrates, never a
    // raw page() branch. If any handler leaked `engine === "chromium"`, the
    // synthetic engine would diverge here.
    await server.handlers.navigate({ url: "about:blank" });
    const snap = await server.handlers.snapshot({});
    expect(snap.content[0]).toBeTruthy();
    await server.handlers.find({ query: "button" });
    await server.handlers.click({ ref: "r1" });

    // deep:false ⇒ a CDP-hard tool structured-refuses, no per-engine gate edit.
    const refusal = JSON.parse(
      (await server.handlers.perf_start({})).content[0]!.text as string,
    );
    expect(refusal.ok).toBe(false);
    expect(refusal.error).toMatch(/not supported on the "synthetic" engine/);
  });
});
```

The refusal assertion reuses the *exact* shape `engineGate` emits today (`host-build.ts:185-192`, which calls `assertEngineSupports` at `tool-gate.ts:131` and formats `tool "${tool}" is not supported on the "${engine}" engine`). That is the point: the synthetic engine flows through the unmodified gate. Sited in the keystone lane because it exercises the real `createServer` → `EngineRegistry` → session-registry path, but it uses an in-memory fake, so it needs no browser download and runs in a fork in seconds.

### 2c. Port-conformance contract test — enforces L5

L5 — *"no adapter throws where the port promises a value"* — is the Safari LSP leak (D5): `BrowserSession.page(): Page` is documented as throwing at `src/session/types.ts:95` and the actual throw is at `src/session/safari-session.ts:35`, forcing the 17 scattered guards in `session-registry.ts`. The contract test runs **one shared suite against every adapter, including the synthetic one**, and forbids a port method that throws unconditionally — catching the Safari LSP class at the seam instead of via 17 defensive `engine !== "safari"` guards downstream:

```ts
// test/architecture/port-conformance.test.ts
import { describe, it, expect } from "vitest";
import { capabilitiesFor, ENGINE_KINDS } from "../../src/engine/index.js";
import type { EngineCapabilities } from "../../src/engine/index.js";

// A port method is either (a) implemented and returns a value, or (b) DECLARED
// absent via capabilities — never present-but-unconditionally-throwing. The Safari
// page() design (documented as throwing at types.ts:95; the actual throw is at
// safari-session.ts:35) is exactly (c), the forbidden state.
//
// NOTE on page-availability: TODAY `EngineCapabilities.subInterfaces` is the set
// `lifecycle|navigation|snapshot|input|network|storage|script|emulation|capture`
// (the `EngineSubInterface` union at `src/engine/types.ts:51-60`) — there is NO
// `page` member, and NO `hasPagePort`
// helper exists. Page-availability is the seam D5 *introduces*: post-D5 a `"page"`
// sub-interface is present iff the engine returns a real Playwright Page, and the
// `hasPagePort` helper below reads exactly that. Because the `"page"` sub-interface
// and the helper land with D5, the declaration-≡-reality assertion lives in a
// `describe.todo` block (P0 stays green); the unconditional-throw guarantee, which
// needs neither, is an active test from P0.
describe("L5 — every adapter honors its declared port contract", () => {
  it.each(ENGINE_KINDS)("[%s] has a capability declaration with the universal sub-interfaces", (engine) => {
    const caps = capabilitiesFor(engine);
    expect(caps, `${engine} has no capability declaration`).toBeDefined();
    expect(caps!.subInterfaces.has("snapshot")).toBe(true); // snapshot is universal
    // No engine may claim `deep` without a real CDP handle:
    if (caps!.deep) {
      expect(["chromium", "android"]).toContain(engine);
    }
  });

  // ILLUSTRATIVE / post-D5: the `"page"` sub-interface and the `hasPagePort` reader
  // it uses do not exist until D5 adds page-availability to the capability model, so
  // this lands `.todo` (P0 gate-green) and activates with D5.
  describe.todo("[post-D5] page-availability is DECLARED, never a throwing page()", () => {
    // Reads the D5-introduced `"page"` sub-interface; present ⇔ the engine returns
    // a real Playwright Page. (Pre-D5 there is no such member — hence `.todo`.)
    const hasPagePort = (caps: EngineCapabilities) => caps.subInterfaces.has("page" as never);
    it.each(ENGINE_KINDS)("[%s] declares page-availability matching reality", (engine) => {
      const caps = capabilitiesFor(engine)!;
      // Ground truth: only Safari has no Playwright Page. Post-D5 a `"page"` sub-
      // interface is present iff the engine returns a real Page; this fails if a
      // non-Safari engine loses its Page or Safari ever claims one.
      const hasPlaywrightPage = engine !== "safari";
      expect(hasPagePort(caps)).toBe(hasPlaywrightPage); // the declaration ≡ reality
    });
  });

  it("forbids a port method that throws unconditionally (the Safari LSP class)", async () => {
    // Drives the shared contract suite against each adapter incl. the synthetic
    // one: for every method the adapter's capabilities CLAIM, calling it must
    // not throw a `*-no-playwright-page` / `*-not-supported` error. A method the
    // adapter cannot honor must be ABSENT from the declared sub-interfaces, so
    // the gate refuses upstream — never a throw mid-call.
    // (full driver omitted; asserts no declared method throws the LSP sentinel)
  });
});
```

This is the test that makes D5's fix verifiable: once `page()` is a declared capability and the 17 guards collapse into the `EngineRegistry.postWire`, the conformance suite is what keeps a future non-Playwright engine (Appium, BiDi-only) from re-introducing the throwing-method pattern.

### 2d. Assertion-density + bounded-resource budget on load-bearing modules — L7 / L8

L8 — *"assert the invariants"* — is the Power-of-Ten assertion-density rule (≥2 per function on safety-critical code). browxai's analog is an `invariant()` helper (lands in P5) plus a density floor on the **load-bearing** modules only (the gate, the registry, the action window, the deadline) — not a blanket rule, which would be noise. The check is static (count `invariant(` / `assert(` call sites against function count via AST):

```ts
// test/architecture/assertion-density.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "@typescript-eslint/typescript-estree";

const LOAD_BEARING = [
  "src/tools/host-build.ts",     // the gate + substrate selection
  "src/engine/tool-gate.ts",     // the engine refusal decision
  "src/page/actionresult.ts",    // the action window / anti-wedge deadline
  "src/util/deadline.ts",        // the bounded-wait primitive
];

describe("L8 — load-bearing modules assert their invariants", () => {
  it.each(LOAD_BEARING)("[%s] meets the assertion-density floor", (file) => {
    const src = readFileSync(file, "utf8");
    const ast = parse(src, { loc: true });
    const fnCount = countFunctions(ast);      // FunctionDeclaration|Arrow|Method
    const assertCount = countCalls(ast, /^(invariant|assert)$/);
    // Floor: at least one asserted invariant per two load-bearing functions.
    // Not Power-of-Ten's strict ≥2/function (TS gate logic is shorter than C),
    // but a non-zero floor that fails LOUDLY if a refactor strips the asserts.
    expect(assertCount * 2).toBeGreaterThanOrEqual(fnCount);
  });
});
```

The bounded-resource budget complements the L7 lint rule (§1.3) with a *tested* bound on the named offenders — e.g. `perf-audit.ts`'s `enforceSummaryBudget` gets a property test asserting "report size never exceeds 2.5× `SUMMARY_TOKEN_BUDGET`" and "terminates in ≤ N iterations for N issues," closing the audit's *"no fuzzing or property-based test validates the algorithm's termination."*

---

## 3. Dependency-cruiser (L-graph) — `.dependency-cruiser.cjs`

The single highest-leverage guardrail against DIP rot (D10). The audit found `.depcheckrc.json` checks *unused* dependencies but **nothing checks import layering** — "a developer could import a transport-specific detail into a core handler, or SDK could import handler internals" with no regression gate. This is Lakos-style levelization made executable. The layering rules encode exactly the direction the doctrine asserts (architecture-principles §1) but no machine checks:

```js
// .dependency-cruiser.cjs
module.exports = {
  forbidden: [
    {
      name: "no-server-or-tools-to-sdk-or-cli",
      comment:
        "The composition root + tool handlers must not import the SDK client or CLI. " +
        "server.ts is a registry composition root (≤400 LOC, §4); the SDK is a downstream " +
        "consumer of the wire, not an upstream dependency. (RFC 0004 D10, L4.)",
      severity: "error",
      from: { path: "^src/(server\\.ts|tools/)" },
      to: { path: "^src/(sdk|cli)/" },
    },
    {
      name: "no-page-handler-to-engine-adapter-or-transport",
      comment:
        "A page handler is engine-agnostic: it reaches the capability substrates, never a " +
        "concrete engine adapter or a transport. (L1: the closed core.)",
      severity: "error",
      from: { path: "^src/page/" },
      to: { path: "^src/(engine/adapters|sdk/transport)" },
    },
    {
      name: "no-sdk-to-handler-internals",
      comment:
        "The SDK is transport-only — it speaks the wire, it does not import handler internals " +
        "(src/tools/* / src/page/*). (DIP: the SDK depends on the protocol, not the impl.)",
      severity: "error",
      from: { path: "^src/sdk/" },
      to: { path: "^src/(tools|page)/" },
    },
    {
      name: "core-imports-inward-only",
      comment:
        "The core (engine/page/session/util) must not import outward into cli/sdk/plugin. " +
        "Dependencies point toward the abstraction, never toward the delivery mechanism.",
      severity: "error",
      from: { path: "^src/(engine|page|session|util)/" },
      to: { path: "^src/(cli|sdk|plugin)/" },
    },
    {
      name: "only-the-bin-imports-cli",
      comment: "Nothing imports src/cli/* except the bin entry (src/cli.ts). The CLI is a leaf.",
      severity: "error",
      from: { pathNot: "^src/cli\\.ts$" },
      to: { path: "^src/cli/" },
    },
    {
      name: "no-circular",
      comment: "No import cycles — they defeat levelization and make load order load-bearing.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    exclude: { path: "(\\.test\\.ts$|^test/|^dist/)" },
  },
};
```

Each rule maps to an audited gap: the `server→sdk` rule to the SRP-creep finding (server.ts must stay composition-only); the `page→adapter` rule to L1; the `sdk→handler` rule to the plugin-sdk DIP finding; the `only-the-bin-imports-cli` rule to the CLI-leaf finding. The CI step is `depcruise --config .dependency-cruiser.cjs src` (added to the `lint` job in §6). Rules land `warn` in P0 (`severity: "warn"`) and promote to `error` in P4 alongside the D6 switch-to-registry work, so the layering is enforced once the registries that satisfy it exist.

---

## 4. The budgets — numeric values, sized from the healthy modules (D11)

Budgets are the ratchet that keeps L3/L4/L7 true after the refactor. **Every number below is derived from a currently-healthy module, not invented** — that is the difference between a ratchet and an aspiration. The god-modules blow through these today (that is the point — they are the debt); the budgets become `error` only once D3 brings them under.

| Budget | Value | Sized from | Enforced by | Promotes |
|--------|-------|-----------|-------------|----------|
| `server.ts` lines | **≤ 400** (hard) | current `server.ts` = **382** (verified) | `max-lines` error, scoped to `src/server.ts` | already `error` (P0) |
| tool module lines | **≤ 450** | `input-tools.ts` (**212**) / `canvas-tools.ts` (**444**) (healthy, ≤ 450, verified); the four god-modules (1965 / 1514 / 1107 / 1033) — plus several mid-size modules the ratchet also pressures, e.g. `action-tools.ts` (632), `host-build.ts` (760), `storage-tools.ts` (1360) — are the debt | `max-lines` warn → error | P3 |
| function lines | **≤ 70** | the action-window helpers + gate closures sit well under | `max-lines-per-function` | P3 |
| cyclomatic complexity | **≤ 15** | the substrate selectors + `assertEngineSupports` (`tool-gate.ts:131`) are ~3–6 | `complexity` | P3 |
| function params | **≤ 5** | the `register` signature is 3 (`host-build.ts:578`); handlers take one `args` | `max-params` | P3 |
| `ToolHost` members | **≤ 35** (freeze the real current count, ratcheting down); **post-split target ≤ ~12 per sub-port** | current `ToolHost` = **35 members** (`host.ts:54-189`) — the ISP debt | the interface-member fitness test (below) | P3 (after D3 segregation into `GateHost`/`SessionHost`/`ActionHost`) |
| duplication | **≤ 1% / ≥ 0 new clones** | the five policy classes + five substrate selectors are the cloned families (D4) | `jscpd` threshold | P3 |

`server.ts ≤ 400` is the hardest number and it is the *only* budget that ships `error` in P0 — because `server.ts` is already at 382 and the composition-root invariant (D11, architecture-principles §4, repo-map.md) is the one the audit flagged as having "NO file-size budget" despite being load-bearing. The 18-line headroom is deliberately tight: any business-logic creep into the composition root trips the ceiling immediately.

The **`ToolHost` member budget** needs a fitness test, not a built-in rule (ESLint has no "interface member count"):

```ts
// test/architecture/interface-budget.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "@typescript-eslint/typescript-estree";

describe("L4 — no god-interface", () => {
  it("ToolHost stays at its frozen ceiling and ratchets down", () => {
    const ast = parse(readFileSync("src/tools/host.ts", "utf8"));
    const toolHost = findInterface(ast, "ToolHost");
    // 35 today (the ISP debt). P0 freezes the ceiling at the REAL current count —
    // a "≤ 40" ceiling would be vacuous because the real value (35) already passes
    // it, so it would catch no regression. The freeze bites: any 36th member fails.
    expect(toolHost.members.length).toBeLessThanOrEqual(35); // P0 freeze at the real value
  });

  // After D3 segregation the meaningful budget is per SUB-PORT, not the composed
  // ToolHost intersection (which stays the sum of its parts). Each sub-port is the
  // narrow contract a handler depends on, so it is the unit that must stay small.
  it.each(["GateHost", "SessionHost", "ActionHost", "EnvelopeHost"])(
    "[%s] sub-port stays ≤ 12 members",
    (name) => {
      const ast = parse(readFileSync("src/tools/host-ports.ts", "utf8")); // lands in D3/P3
      expect(findInterface(ast, name).members.length).toBeLessThanOrEqual(12);
    },
  );
});
```

The **`jscpd` duplication** budget targets the clones the five-identical-policy-classes (`dialog.ts`/`permission.ts`/`notification.ts`/`fs-picker.ts`/`device-emu.ts`, audit `session` finding) and five-identical-substrate-selectors (`host-build.ts:288-357`) create — they are exactly the D4 `PolicyBuffer<T>` / `EngineRegistry` extractions. In **P0 it is reporting-only** (`pnpm jscpd`, no `--threshold` ⇒ it prints the duplication report but never exits non-zero, so it cannot fail the gate while those clones still exist — consistent with 0004-04 P0 "jscpd as reporting-only"). It **promotes in P3** to `pnpm jscpd:strict` (`--threshold 1`), failing on >1% duplication, once D4 has collapsed the clones — so the threshold lands the moment the tree can pass it, never before.

---

## 5. Codegen — the tool-types generator (D7, enforces L2)

`src/sdk/tool-types.ts` is **673 LOC** (verified) that hand-mirror the zod schemas its own header admits are the source of truth — guaranteed drift, the audit's "no codegen test validates tool-types.ts matches server zod schemas." The fix is a build-time generator that reads the registrations (post-D2 they carry their schemas) and emits the types, plus a fitness test that fails if the committed file diverges from the regenerated one:

```ts
// scripts/gen-tool-types.ts — reads the tool REGISTRATIONS (not a server method),
// emits sdk/tool-types.ts. `createServer` returns only { start, shutdown, handlers }
// (server.ts:370-381) — there is no `server.registeredSchemas()`; the generator
// reads the registration side-table the host accumulates instead.
// `collectRegistrations` is a NEW export D7 adds to host-build.ts (it does not exist
// today) — it builds a headless host and returns the ToolMeta+schema side-table the
// D2 metadata-at-registration work accumulates. The generator depends on D2/D7, not
// on any current API.
import { collectRegistrations } from "../src/tools/host-build.js"; // D7-introduced
import { zodToTs } from "./zod-to-ts.js"; // schema → TS type string

export async function generateToolTypes(): Promise<string> {
  // Post-D2, each registration carries its zod inputSchema (host.register's
  // `S extends z.ZodRawShape`, host.ts:60-64) alongside its ToolMeta. The generator
  // walks the registrations (the source of truth) and infers the same
  // `z.infer<z.ZodObject<S>>` the handler already receives — one inference,
  // generated, not hand-mirrored, and not read from a server method that does not exist.
  const registrations = await collectRegistrations({ headless: true }); // ReadonlyMap<string, { schema; meta }>
  const lines = ["// GENERATED by scripts/gen-tool-types.ts — do not edit.", ""];
  for (const [name, { schema }] of registrations) {
    lines.push(`export type ${pascal(name)}Args = ${zodToTs(schema)};`);
  }
  return lines.join("\n") + "\n";
}
```

```ts
// test/architecture/codegen-drift.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateToolTypes } from "../../scripts/gen-tool-types.js";

describe("L2 — generated SDK types match the live schemas", () => {
  it("committed sdk/tool-types.ts equals the regenerated output", async () => {
    const committed = readFileSync("src/sdk/tool-types.ts", "utf8");
    const regenerated = await generateToolTypes();
    // If this fails, run `pnpm gen:tool-types` and commit. The 673-LOC
    // hand-mirror becomes a generated artifact; drift is impossible.
    expect(committed.trim()).toBe(regenerated.trim());
  });
});
```

The generated file matches the `**/*.generated.*` ignore already in `eslint.config.js:125` (so it is not linted), and the `gen:tool-types` script slots into `package.json` next to `build`. The drift test composes with the type-safety work already landed — handler args are already `z.infer` of the `inputSchema` (`host-build.ts:588`), so the SDK types are *the same inference, generated*, closing the loop.

---

## 6. CI wiring — where the gates slot in

The existing gate is two workflows: `ci.yml` (the `build` job runs `pnpm typecheck` + `pnpm test`; the `keystone` job runs `pnpm test:keystone`) and `quality.yml` (the `lint` job runs `pnpm lint` + `pnpm format:check` + `pnpm run depcheck`). The new checks attach with **zero new jobs** in the common case — the fitness suite rides the existing `pnpm test` lane; the layering and duplication checks ride the existing `lint` job.

New `package.json` scripts:

```jsonc
{
  "scripts": {
    // the fast architecture fitness lane — static, no browser; rides pnpm test
    "test:arch": "vitest run test/architecture",
    // layering — runs in the quality `lint` job alongside eslint
    "depcruise": "depcruise --config .dependency-cruiser.cjs src",
    // duplication budget — P0 reports only (no threshold ⇒ exit 0 even on the
    // existing clones, per 0004-04 P0 "jscpd as reporting-only"); the strict
    // `jscpd:strict` is what P3 promotes to once D4 removes the clones.
    "jscpd": "jscpd src --min-tokens 70 --reporters consoleFull",
    "jscpd:strict": "jscpd src --threshold 1 --min-tokens 70 --reporters consoleFull",
    // tool-types codegen (manual regen; the drift test gates it in CI)
    "gen:tool-types": "tsx scripts/gen-tool-types.ts",
    // optional: mutation testing on the gate, to prove the fitness tests BITE
    "test:mutation": "stryker run"
  }
}
```

`test/architecture/**` is **not** excluded by `vitest.config.ts` (only `test/keystone/**` and `test/investigation/**` are), so it runs automatically inside `pnpm test` — the `build` job in `ci.yml` gains nothing to edit; the fitness suite is simply part of the default run. The explicit `test:arch` script exists for the editor loop, not CI. The `quality.yml` `lint` job gains two lines after `pnpm lint`:

```yaml
# .github/workflows/quality.yml — lint job, after `- run: pnpm lint`
# P0: both are REPORTING-ONLY. depcruise rules ship `severity: "warn"` (§3) and
# `pnpm jscpd` carries no `--threshold` (no non-zero exit), so neither fails the
# `lint` job — consistent with 0004-04 P0 ("dependency-cruiser + budgets + jscpd
# report at warn"). They become blocking in P4 (depcruise → error) and P3
# (`jscpd:strict` with `--threshold 1`) once the registries/extractions land.
- run: pnpm depcruise        # layering / DIP (L-graph) — warn in P0, error in P4
- run: pnpm jscpd            # duplication budget (D11) — report-only in P0
# P3, after D4 removes the five-policy + five-selector clones, swap to:
# - run: pnpm jscpd:strict   # --threshold 1 — fails on >1% duplication
```

The engine-adapter-contract keystone (§2b) joins `test/keystone/**` and rides the existing `keystone` job in `ci.yml` — that job already runs `pnpm build` then `pnpm test:keystone`, so the new contract test is picked up by the glob with no workflow edit.

**Optional, deferred to P5+ (not P0):** *mutation testing* (Stryker, `pnpm test:mutation`) run against `src/engine/tool-gate.ts` + `src/tools/host-build.ts` proves the fitness tests actually *bite* — a surviving mutant in the gate means the completeness/OCP tests do not constrain it. This is the meta-fitness-function (does the harness test the harness?) and is opt-in, run periodically, not on every PR (Stryker is slow). It is the honest answer to "are the guardrails real or theater."

---

## 7. The meta-rule — relaxation is an RFC amendment, never an inline disable

A guardrail that can be silenced by `// eslint-disable-next-line` at the point of violation is not a guardrail — it is a suggestion with a snooze button. The `no-unsafe-*` enforcement work already established the binding norm in this codebase: those five rules went to `error` and the boundary was *typed* rather than disabled per-site (`eslint.config.js:210-216` documents the boundary-narrowing that made the blanket `error` honest). RFC 0004's guardrails inherit that norm verbatim. The meta-rule (RFC 0004 §8's mitigation; restated here as the audit-trail expectation):

1. **No inline disable of an architecture guardrail.** `no-engine-literal-branches`, `no-inlined-capability-checks`, the budgets, and the `dependency-cruiser` rules may **not** be relaxed with a per-line `eslint-disable` / `depcruise-disable` / `// jscpd:ignore`. The whitelists (the `ENGINE_SELECT_ALLOWLIST`, the `GATE_OWNER_ALLOWLIST`, the budget `files` scopes) are the *only* sanctioned escape valves, and they live in the config where they are reviewable as a unit — not scattered at violation sites.

2. **Relaxation requires an RFC amendment with rationale.** Widening an allowlist, raising a budget, or downgrading a `dependency-cruiser` rule from `error` is a change to *this document* (or its successor), with a stated reason, reviewed as an architecture decision — exactly as adding a `D`-decision is. The budget numbers in §4 are versioned here precisely so a change to them is a visible diff against a committed standard.

3. **The audit trail is the config diff plus the RFC amendment.** Because relaxation cannot happen at the violation site, it cannot happen *silently*. Every loosening is a diff to `eslint.config.js` / `.dependency-cruiser.cjs` / this reference, paired with the rationale — a permanent, greppable record of *which* invariant was relaxed, *when*, and *why*. This is the DO-178C traceability discipline (L9) applied to the guardrails themselves: the standard's own evolution is traceable.

4. **`ban-ts-comment` is the precedent and the backstop.** browxai already requires every `ts-expect-error` / `ts-ignore` to carry a ≥5-char description (`eslint.config.js:226-235`). The same posture generalizes: if a guardrail genuinely *must* yield at a site, the honest move is to fix the design (extract the seam, narrow the type, split the module) — the guardrails are calibrated from the *healthy* modules precisely so that yielding is almost always a signal the code is wrong, not the rule.

The consequence is the property RFC 0004 promises in its thesis: the codebase *physically cannot* decay back to its current state through a green gate, because the gate now fails on the decay — and the gate cannot be quietly told to stop failing.

---

## 8. Coverage map — every law to its enforcer

The bookkeeping that makes this document auditable against the parent. Each of the ten laws (RFC 0004 §4) and each guardrail decision (D8–D12) maps to a concrete artifact in this reference:

| Law / Decision | Enforcer in this document | Layer | Phase to `error` |
|----------------|---------------------------|-------|------------------|
| L1 — closed core | `no-engine-literal-branches` (§1.1) + engine-adapter-contract keystone (§2b) | lint + keystone | P1 |
| L2 — single source of truth | completeness tests (§2a) + codegen-drift (§5) | fit | P2 |
| L3 — one reason to change | `max-lines`/`-per-function`/`complexity` budgets (§1.5, §4) + `no-inlined-capability-checks` (§1.2) | lint | server.ts P0; rest P3 |
| L4 — segregated contracts | `ToolHost` member budget (§4) + `dependency-cruiser` ToolHost-split intent (§3) | fit + graph | P3 |
| L5 — substitutable adapters | port-conformance contract test (§2c) | fit | P1 (with D5) |
| L6 — validate at the edge | the five `no-unsafe-*` + `no-explicit-any` (already `error`, `eslint.config.js:196,212-216`) | lint | landed |
| L7 — bounded everything | `bounded-resource` rule (§1.3) + bounded-resource budget tests (§2d) | lint + fit | advisory + P5 |
| L8 — assert the invariants | assertion-density test on load-bearing modules (§2d) | fit | P5 |
| L9 — traceable | completeness/traceability tests (§2a) + the §7 audit trail | fit + process | P2 |
| L10 — deterministic & observable | existing keystone determinism gates, extended to the new seams | keystone | continuous |
| D10 — enforce the dependency graph | `.dependency-cruiser.cjs` (§3) | graph | P4 |
| D11 — budgets, not vibes | §4 budgets + `jscpd` | lint + fit | server.ts P0; rest P3 |
| D7 — generate SDK tool-types | codegen + drift test (§5) | fit | P2 |
| D12 — discoverable + harnessed | the `code-quality.md` "Architecture enforcement" section + `fitness-functions.md` index | docs | P5 ([`0004-06`](0004-06-ai-documentation-and-harness.md)) |

The discoverability half of D12 — making every guardrail in this document *findable by the next agent* — is specified in [`0004-06-ai-documentation-and-harness.md`](0004-06-ai-documentation-and-harness.md): `code-quality.md` gains the "Architecture enforcement" section that lists these checks, and a new `fitness-functions.md` indexes the executable invariants. This reference is the *spec*; that one wires it into the harness an agent reads first.

---

## Related

- [`0004-architecture-hardening.md`](../0004-architecture-hardening.md) — the parent RFC. This reference is the concrete realization of its ten laws' "Enforcer" column and of decisions D8–D12.
- [`0004-01-current-state-audit.md`](0004-01-current-state-audit.md) — the 80 findings and the guardrail-gap inventory each rule/test above closes.
- [`0004-03-ocp-registry-patterns.md`](0004-03-ocp-registry-patterns.md) — the `EngineRegistry`, metadata-at-registration, and `PolicyBuffer`/`EgressSanitiser` patterns these fitness functions verify.
- [`0004-04-refactor-plan.md`](0004-04-refactor-plan.md) — the phased plan; this document's `warn`→`error` promotions are keyed to its P0–P5 sequencing.
- [`0004-06-ai-documentation-and-harness.md`](0004-06-ai-documentation-and-harness.md) — the discoverability + harness half of D12: where these guardrails are documented and indexed for the next agent.
- [`architecture-principles.md`](../../ai-context/architecture/architecture-principles.md) — the doctrine these guardrails enforce (extended, not restated).
- [`code-quality.md`](../../ai-context/agent-process/code-quality.md) — the micro-rule discipline this enforcement layer joins.
