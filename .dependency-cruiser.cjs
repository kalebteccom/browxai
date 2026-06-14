// dependency-cruiser layering rules (RFC 0004 D10, L4) — the import-graph half of
// the architecture guardrail. Lakos-style levelization made executable: the core
// depends inward, never toward a delivery mechanism.
//
// P0 stance: every rule ships `severity: "warn"`, so `pnpm depcruise` REPORTS
// layering drift but exits 0 — it cannot fail the gate while the tree still has
// the cross-layer imports the later phases remove. The rules promote to `error`
// in P4 (alongside the D6 switch-to-registry work), once the registries that
// satisfy them exist. Promotion is a one-line `severity` change per rule, and —
// per the §7 meta-rule — a reviewable RFC-amendment diff, never an inline disable.

module.exports = {
  forbidden: [
    {
      name: "no-server-or-tools-to-sdk-or-cli",
      comment:
        "The composition root + tool handlers must not import the SDK client or CLI. " +
        "server.ts is a registry composition root (<=400 LOC); the SDK is a downstream " +
        "consumer of the wire, not an upstream dependency. (RFC 0004 D10, L4.)",
      severity: "warn",
      from: { path: "^src/(server\\.ts|tools/)" },
      to: { path: "^src/(sdk|cli)/" },
    },
    {
      name: "no-page-handler-to-engine-adapter-or-transport",
      comment:
        "A page handler is engine-agnostic: it reaches the capability substrates, never a " +
        "concrete engine adapter or a transport. (RFC 0004 L1: the closed core.)",
      severity: "warn",
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
      severity: "warn",
      from: { path: "^src/sdk/" },
      to: { path: "^src/(tools|page)/", pathNot: "^src/tools/tool-metadata\\.ts$" },
    },
    {
      name: "core-imports-inward-only",
      comment:
        "The core (engine/page/session/util) must not import outward into cli/sdk/plugin. " +
        "Dependencies point toward the abstraction, never toward the delivery mechanism.",
      severity: "warn",
      from: { path: "^src/(engine|page|session|util)/" },
      to: { path: "^src/(cli|sdk|plugin)/" },
    },
    {
      name: "only-the-bin-imports-cli",
      comment: "Nothing imports src/cli/* except the bin entry (src/cli.ts). The CLI is a leaf.",
      severity: "warn",
      from: { pathNot: "^src/cli\\.ts$" },
      to: { path: "^src/cli/" },
    },
    {
      name: "no-circular",
      comment: "No import cycles — they defeat levelization and make load order load-bearing.",
      severity: "warn",
      from: {},
      to: { circular: true },
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
