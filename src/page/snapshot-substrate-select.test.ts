import { describe, it, expect } from "vitest";
import { snapshotSubstrateFor, type SubstrateCapableSession } from "./snapshot-substrate-select.js";
import { SafariClassicSnapshotSubstrate } from "./snapshot-substrate-safari.js";
import { RefRegistry } from "./refs.js";
import type { SafariSessionHandle } from "../engine/index.js";

// snapshotSubstrateFor selects by capability. These cover the Safari branch (the
// one engine whose page() throws — it MUST be picked before the Playwright path)
// without a browser: a fake handle whose execute/sync returns DomWalkEntry JSON.

describe("snapshotSubstrateFor — Safari branch", () => {
  it("picks the SafariClassicSnapshotSubstrate for a safari session and threads the sessionId", async () => {
    const execCalls: Array<{ sessionId: string; scriptBody: string }> = [];
    const handle = {
      sessionId: "SID-42",
      webDriver: {
        executeScript: async (sessionId: string, scriptBody: string) => {
          execCalls.push({ sessionId, scriptBody });
          return [
            {
              role: "button",
              name: "Go",
              testId: "go",
              testIdAttr: "data-testid",
              tag: "button",
              id: "",
              structuralPath: "body[0]/button[0]",
              cssPath: "body > button",
            },
          ];
        },
        currentUrl: async () => "https://example.com/",
      },
    } as unknown as SafariSessionHandle;

    const session: SubstrateCapableSession = {
      engine: "safari",
      page: () => {
        throw new Error("safari-no-playwright-page");
      },
      safari: () => handle,
    };

    const substrate = snapshotSubstrateFor(session);
    expect(substrate).toBeInstanceOf(SafariClassicSnapshotSubstrate);
    expect(substrate.engine).toBe("safari");

    // Driving it must route execute/sync through the handle's WebDriver with the
    // session's id — proving the IO bridge is wired, and never touch page().
    const snap = await substrate.compose(new RefRegistry(), ["data-testid"]);
    expect(snap.tree?.children).toHaveLength(1);
    expect(execCalls[0]?.sessionId).toBe("SID-42");
    expect(execCalls[0]?.scriptBody).toContain("arguments[0]");
  });

  it("does NOT call page() on a safari session (page would throw)", () => {
    let pageCalled = false;
    const session: SubstrateCapableSession = {
      engine: "safari",
      page: () => {
        pageCalled = true;
        throw new Error("safari-no-playwright-page");
      },
      safari: () =>
        ({
          sessionId: "S",
          webDriver: { executeScript: async () => [], currentUrl: async () => "" },
        }) as unknown as SafariSessionHandle,
    };
    snapshotSubstrateFor(session);
    expect(pageCalled).toBe(false);
  });
});
