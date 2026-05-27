import { defineConfig } from "vitest/config";

// Live-network investigation suite — exercises screenshot_marks against
// public targets (example.com / developer.mozilla.org / en.wikipedia.org).
// Not part of `pnpm test`; run with `pnpm test:investigation` when you
// need fresh wall-clock numbers or artifacts.
export default defineConfig({
  test: {
    include: ["test/investigation/**/*.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
