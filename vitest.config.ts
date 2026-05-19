import { defineConfig, configDefaults } from "vitest/config";

// Default suite: the hermetic, browser-free unit tests (co-located in src/).
// The headless-CI keystone lives under test/keystone/ and is excluded here so
// `pnpm test` never downloads or launches a browser; it runs via its own
// config (`pnpm test:keystone`, vitest.keystone.config.ts) in a separate CI job.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/keystone/**"],
  },
});
