// dependency-cruiser layering rules (RFC 0004 D10, L4) — the import-graph half of
// the architecture guardrail. Lakos-style levelization made executable: the core
// depends inward, never toward a delivery mechanism.
//
// P4 stance (PROMOTED): every layering rule below now ships `severity: "error"`,
// so `pnpm depcruise` FAILS the gate on any cross-layer import. The tree is clean
// of layering violations (P1–P3 removed the cross-layer imports the registries
// replaced), so promotion is safe per the §3.1 ratchet ("promote in the same
// phase that removes the last violation"). Relaxing a promoted rule is an
// RFC-amendment diff with rationale — never an inline disable (the §7 meta-rule).
//
// `no-circular` is `error` too, but FILTERED to runtime cycles: the ~93 cycles
// the tree carries are TYPE-ONLY (`import type` shared across the P2 bootstrap +
// P3 module splits), erased at compile and harmless to load order. The
// `viaOnly.dependencyTypesNot: ["type-only"]` clause reports a cycle ONLY when it
// has a real runtime edge — so a genuine runtime cycle still errors (the
// network.ts ↔ network-playwright.ts cycle P4 resolved would re-fire), while the
// type-only cycles do not. Suppression is by dependency KIND, not an allowlist of
// specific cycles, so a new runtime cycle is caught automatically.

module.exports = {
  forbidden: [
    {
      name: "no-server-or-tools-to-sdk-or-cli",
      comment:
        "The composition root + tool handlers must not import the SDK client or CLI. " +
        "server.ts is a registry composition root (<=400 LOC); the SDK is a downstream " +
        "consumer of the wire, not an upstream dependency. (RFC 0004 D10, L4.)",
      severity: "error",
      from: { path: "^src/(server\\.ts|tools/)" },
      to: { path: "^src/(sdk|cli)/" },
    },
    {
      name: "no-page-handler-to-engine-adapter-or-transport",
      comment:
        "A page handler is engine-agnostic: it reaches the capability substrates, never a " +
        "concrete engine adapter or a transport. (RFC 0004 L1: the closed core.)",
      severity: "error",
      from: { path: "^src/page/" },
      to: { path: "^src/(engine/adapters|sdk/transport)" },
    },
    {
      name: "no-sdk-to-handler-internals",
      comment:
        "The SDK is transport-only — it speaks the wire, it does not import handler internals " +
        "(src/tools/* / src/page/*). (DIP: the SDK depends on the protocol, not the impl.)" +
        " EXCEPTION (RFC 0004 P2 / D1, SECURITY-CRITICAL): the SDK entry side-effect-imports " +
        "src/tools/tool-metadata.ts — the composition-root bootstrap that eagerly populates the " +
        "derived TOOL_CAPABILITY gate the SDK's capability filter reads. The socket transport " +
        "never calls createServer, so without this the gate would read an empty map; the gate's " +
        "fail-safe makes that throw rather than fail OPEN, and this import keeps the throw from " +
        "firing on the legitimate path. It pulls a SIDE EFFECT (the bootstrap), not handler logic.",
      severity: "error",
      from: { path: "^src/sdk/" },
      to: { path: "^src/(tools|page)/", pathNot: "^src/tools/tool-metadata\\.ts$" },
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
      comment:
        "Nothing outside the CLI imports src/cli/* except the bin entry (src/cli.ts). The CLI is " +
        "a leaf of the delivery layer: the bin composes it, and CLI modules import each other " +
        "(e.g. doctor.ts → doctor-plugins.ts), but no CORE/SDK/plugin module may reach into it. " +
        "The `from.pathNot` excludes BOTH the bin entry AND sibling cli/ modules so an intra-CLI " +
        "import is not a violation — only an inward leak from outside the CLI is. (RFC 0004 D10.)",
      severity: "error",
      from: { pathNot: "^src/(cli\\.ts$|cli/)" },
      to: { path: "^src/cli/" },
    },
    {
      name: "ports-name-no-vendor-type",
      comment:
        "A capability port declares an interface over plain data. It must not REACH " +
        "playwright-core: a port that names a vendor type is not a port, and no engine " +
        "without Playwright could implement it. The Playwright implementation lives in the " +
        "sibling *-substrate-playwright.ts module, which is free to import whatever it " +
        "drives. (RFC 0009; L1, L5.)\n" +
        "REACHABLE, not direct. A direct-edge rule states something much weaker than its " +
        "own comment and six of the eight ports satisfied it while reaching playwright-core " +
        "in one or two hops — `action-substrate-types` → `actionresult.ts`, " +
        "`snapshot-substrate-types` → `a11y.ts`, and so on. Worse, the action port took its " +
        "whole argument vocabulary from `actions.ts`, which IS its own Playwright adapter. " +
        "`to.reachable` is what makes the rule mean what it says; RFC 0009 P1 split the " +
        "plain-data leaves out of all six so the last violation and the promotion to `error` " +
        "ship together (the §3.1 ratchet).\n" +
        "SELECTOR. `^src/.+-substrate-types\\.ts$` — anywhere under src (a port in a " +
        "subdirectory is still a port), any name including digits. The `*-substrate.ts` " +
        "BARRELS are deliberately out: a barrel re-exports the Playwright adapter class at " +
        "runtime, so it reaches playwright-core by construction and always will. It passed " +
        "the direct-edge version of this rule only vacuously. A port that dodges the " +
        "selector by living somewhere else is caught by the companion fitness test " +
        "(test/architecture/port-module-naming.test.ts), which asserts every `*Substrate` " +
        "port interface in the tree is declared in a file this pattern matches.",
      severity: "error",
      from: { path: "^src/.+-substrate-types\\.ts$" },
      to: { path: "node_modules/playwright-core|^playwright-core$", reachable: true },
    },
    {
      name: "no-tools-or-replay-to-playwright-core",
      comment:
        "A tool handler and the replay orchestrator are engine-agnostic: they reach the " +
        "capability substrates, never a Playwright type. This is a FLOOR, not the whole " +
        "guard — src/tools imports the `Page` type zero times and still holds ~130 " +
        "`requirePage(...)` handles obtained by inference, which no import-graph rule can " +
        "see. The `requirePage` chokepoint (src/engine/session-page.ts) is what makes those " +
        "countable; this rule stops the type itself coming back. (RFC 0009; L1.)\n" +
        "WARN, not error: five modules violate it today, and every one belongs to a later " +
        "phase of RFC 0009, not P1. `Locator` in tools/target-resolve.ts + tools/host-build.ts " +
        "goes with ElementSubstrate (P2). `Page` / `BrowserContext` / `ConsoleMessage` / " +
        "`Frame` in replay/session.ts + replay/dom-capture.ts and `CDPSession` in " +
        "replay/session-network.ts go with EventSubstrate (P4) and the residue (P5). It " +
        "promotes to error in the phase that removes the last of the five — the §3.1 ratchet. " +
        "RFC 0009 asserts this rule passes today; it does not, and the five above are why.",
      severity: "warn",
      from: { path: "^src/(tools|replay)/" },
      to: { path: "node_modules/playwright-core|^playwright-core$" },
    },
    {
      name: "no-circular",
      comment:
        "No RUNTIME import cycles — they defeat levelization and make load order load-bearing. " +
        "TYPE-ONLY cycles (`import type` both ways) are erased at compile and carry no load-order " +
        'hazard, so `viaOnly.dependencyTypesNot: ["type-only"]` reports a cycle ONLY when its path ' +
        "has a real runtime edge. A genuine runtime cycle still errors; the ~93 type-only cycles " +
        "from the P2 bootstrap + P3 splits sharing types do not. (RFC 0004 D10, L4.)",
      severity: "error",
      from: {},
      to: { circular: true, viaOnly: { dependencyTypesNot: ["type-only"] } },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    // Architecture tests, the test tree, and build output are not part of the
    // layered runtime graph.
    exclude: { path: "(\\.test\\.ts$|^test/|^dist/)" },
  },
};
