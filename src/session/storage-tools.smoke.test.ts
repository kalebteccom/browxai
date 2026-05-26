// Smoke check: every storage-state tool is registered by createServer().
// Catches regressions in the for-loop wiring without launching a browser
// (each handler is reachable; we don't invoke them).

import { describe, it, expect } from "vitest";
import { createServer } from "../server.js";

const STORAGE_TOOLS = [
  // layer 1
  "dump_storage_state",
  "inject_storage_state",
  // layer 2 — cookies
  "cookies_get",
  "cookies_list",
  "cookies_set",
  "cookies_delete",
  "cookies_clear",
  // layer 2 — localStorage
  "localstorage_get",
  "localstorage_list",
  "localstorage_set",
  "localstorage_delete",
  "localstorage_clear",
  // layer 2 — sessionStorage
  "sessionstorage_get",
  "sessionstorage_list",
  "sessionstorage_set",
  "sessionstorage_delete",
  "sessionstorage_clear",
  // layer 3 — named auth-states
  "auth_save",
  "auth_load",
  "auth_list",
  "auth_delete",
];

describe("storage tools — registration smoke", () => {
  it("every storage tool is reachable through the handler map", async () => {
    const { handlers, shutdown } = await createServer({});
    try {
      const missing = STORAGE_TOOLS.filter((t) => typeof handlers[t] !== "function");
      expect(missing).toEqual([]);
    } finally {
      await shutdown();
    }
  });
});
