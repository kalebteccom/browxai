import { defineConfig, configDefaults } from "vitest/config";

// Default suite: the hermetic, browser-free unit tests (co-located in src/).
// The headless-CI keystone lives under test/keystone/ and is excluded here so
// `pnpm test` never downloads or launches a browser; it runs via its own
// config (`pnpm test:keystone`, vitest.keystone.config.ts) in a separate CI job.
// CI sets VITEST_MAX_WORKERS to cap the workers of one run, so two unit steps and
// the other gate commands do not oversubscribe the cores. Unset or not a positive
// integer: vitest keeps its own default (one worker per core).
const maxWorkers = Number.parseInt(process.env.VITEST_MAX_WORKERS ?? "", 10);

export default defineConfig({
  test: {
    // One timeout policy for the unit lane. A CI box runs several gate steps on
    // the same cores, and a test that touches a temp dir or spawns a process can
    // run past the 5 s default there. Local runs keep 5 s, so a slow test still
    // shows up on a quiet machine. A test that needs longer sets its own timeout.
    testTimeout: process.env.CI ? 15_000 : 5_000,
    ...(maxWorkers > 0 ? { maxWorkers } : {}),
    exclude: [
      ...configDefaults.exclude,
      "**/dist/**",
      "test/keystone/**",
      // The agentic capability-testbed is NOT part of CI — it is driven on
      // demand by the special test-suite workflow (Full Report > Diagnose >
      // Fix), with real browsers and every capability enabled. Never let
      // `pnpm test` pick up anything under it.
      "packages/capability-testbed/**",
      // Agent worktrees (AGENTS.md "Worktree conventions") are full checkouts.
      // Without this the default suite collects every test twice — once from
      // the main tree and once per live worktree — so a sibling agent's
      // in-progress edit fails the gate here for reasons unrelated to it.
      // eslint/prettier already ignore `.claude`; the keystone + investigation
      // configs are include-scoped to `test/` and unaffected.
      ".claude/**",
    ],
  },
});
