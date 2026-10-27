import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInit } from "./init.js";

let dir: string;
let out = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browxai-init-"));
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const ARGS = ["--no-write", "--test-attrs", "data-testid"];

describe("browxai init", () => {
  it("keeps the node and dist/cli.js entry as the default snippet", async () => {
    expect(await runInit([dir, ...ARGS])).toBe(0);
    expect(out).toContain('"command": "node"');
    expect(out).toMatch(/"args": \[\s*"[^"]*cli\.js"\s*\]/);
  });

  it("prints the npx entry as the portable alternative", async () => {
    expect(await runInit([dir, ...ARGS])).toBe(0);
    expect(out).toContain('{ "command": "npx", "args": ["-y", "browxai"] }');
  });

  it("puts the workspace on the chrome commands so logins reach the MCP profile", async () => {
    expect(await runInit([dir, ...ARGS])).toBe(0);
    expect(out).toContain(`BROWX_WORKSPACE=${join(dir, ".browxai")} browxai chrome login`);
    expect(out).toContain(`BROWX_WORKSPACE=${join(dir, ".browxai")} browxai chrome start`);
  });
});
