// Package-manager adapters (RFC 0004 P4 / D6) — the add-only registry that
// replaces the `PM_VERBS` record (`Record<PackageManager, Record<PmOperation,
// string>>`). Each supported manager is ONE `PackageManagerAdapter`: its CLI
// name, its probe priority (lower wins when several are on PATH), and the verb
// it uses for each browxai plugin operation. Adding `yarn` is one adapter
// registered here — no edit to `pmArgs` / `detectPackageManager` / the CLI.
//
// Behavior-preservation: the pnpm/npm adapters carry the EXACT verb strings the
// old `PM_VERBS` did, and the probe priority preserves the old
// "pnpm wins, npm is the fallback" order — so `pmArgs(...)` and
// `detectPackageManager(...)` return identical results.

/** Package managers the plugin CLI can drive. */
export type PackageManager = "pnpm" | "npm";

/** The pnpm-flavoured operations the CLI performs, mapped per manager. */
export type PmOperation = "add" | "remove" | "update" | "install";

/** One package manager's integration surface. */
export interface PackageManagerAdapter {
  /** The CLI binary name (also the probe target and the spawn command). */
  readonly name: PackageManager;
  /** Probe order — the lowest priority that is on PATH wins. pnpm (0) is the
   *  project's declared manager; npm (1) is the adopter fallback. */
  readonly priority: number;
  /** The manager's verb for each browxai plugin operation. */
  readonly verbs: Record<PmOperation, string>;
}

const ADAPTERS = new Map<PackageManager, PackageManagerAdapter>();

/** Register a package-manager adapter. Add-only: a new manager is one
 *  `registerPackageManager(...)` call. */
export function registerPackageManager(adapter: PackageManagerAdapter): void {
  ADAPTERS.set(adapter.name, adapter);
}

/** The registered adapter for a manager, or `undefined` when none is registered. */
export function packageManagerAdapter(name: PackageManager): PackageManagerAdapter | undefined {
  return ADAPTERS.get(name);
}

/** All registered adapters, in ascending probe priority — the order
 *  `detectPackageManager` walks when probing PATH. */
export function packageManagerAdaptersByPriority(): PackageManagerAdapter[] {
  return [...ADAPTERS.values()].sort((a, b) => a.priority - b.priority);
}

// pnpm — the project's native manager (wins detection). Verbs are the canonical
// pnpm spelling the CLI was written against.
registerPackageManager({
  name: "pnpm",
  priority: 0,
  verbs: { add: "add", remove: "remove", update: "update", install: "install" },
});

// npm — the fallback for `npm install -g browxai` adopters with no pnpm on PATH.
// `add`→`install`, `remove`→`uninstall`; `update`/`install` keep their names.
registerPackageManager({
  name: "npm",
  priority: 1,
  verbs: { add: "install", remove: "uninstall", update: "update", install: "install" },
});
