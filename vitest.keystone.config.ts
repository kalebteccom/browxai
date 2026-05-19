import { defineConfig } from "vitest/config";

// Headless-CI keystone only — a real headless Chromium drives the actual MCP
// tool handlers end-to-end. Slow + heavyweight by nature, so it is isolated
// from the unit run and given generous timeouts. Single-threaded: it owns a
// browser + a fixture http server and asserts cross-session isolation.
export default defineConfig({
  test: {
    include: ["test/keystone/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
