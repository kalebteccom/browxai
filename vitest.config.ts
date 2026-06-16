import { defineConfig, configDefaults } from "vitest/config";

// Default suite: the hermetic, browser-free unit tests (co-located in src/).
// The headless-CI keystone lives under test/keystone/ and is excluded here so
// `pnpm test` never downloads or launches a browser; it runs via its own
// config (`pnpm test:keystone`, vitest.keystone.config.ts) in a separate CI job.
// The live-network investigation suite (test/investigation/) is similarly
// excluded and runs via `vitest.investigation.config.ts`.
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "test/keystone/**",
      "test/investigation/**",
      // The agentic capability-testbed is NOT part of CI — it is driven on
      // demand by the special test-suite workflow (Full Report > Diagnose >
      // Fix), with real browsers and every capability enabled. Never let
      // `pnpm test` pick up anything under it.
      "packages/capability-testbed/**",
    ],
  },
});
