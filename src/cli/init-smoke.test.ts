import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runSmoke } from "./init-smoke.js";

describe("runSmoke", () => {
  it("says what to do when the built cli is missing, without starting anything", async () => {
    const res = await runSmoke({ distCli: join(tmpdir(), "browxai-no-such-dir", "cli.js") });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/^error: /);
    expect(res.message).toContain("pnpm build");
    expect(res.message).toContain("--no-smoke");
  });
});
