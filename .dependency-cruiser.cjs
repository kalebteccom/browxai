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
      name: "no-circular",
      comment:
        "No RUNTIME import cycles — they defeat levelization and make load order load-bearing. " +
        "TYPE-ONLY cycles (`import type` both ways) are erased at compile and carry no load-order " +
        "hazard, so `viaOnly.dependencyTypesNot: [\"type-only\"]` reports a cycle ONLY when its path " +
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
