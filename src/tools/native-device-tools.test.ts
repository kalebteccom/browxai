// `app_install` reads its bundle from under $BROWX_WORKSPACE only.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppBundlePath } from "./native-device-tools.js";

let tmp: string;
let ws: string;
let outside: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "browxai-app-install-"));
  ws = join(tmp, "ws");
  outside = join(tmp, "outside");
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(outside, "real.apk"), "x");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** The refusal with the caller's input swapped out, so two refusals compare. */
const refusal = (p: string): string => {
  try {
    resolveAppBundlePath(ws, p);
  } catch (err) {
    return (err as Error).message.replace(`"${p}"`, '"<p>"');
  }
  throw new Error(`expected "${p}" to be refused`);
};

describe("resolveAppBundlePath", () => {
  it("resolves a workspace-relative bundle to its absolute path", () => {
    mkdirSync(join(ws, "apps"));
    writeFileSync(join(ws, "apps", "a.apk"), "x");
    expect(resolveAppBundlePath(ws, "apps/a.apk")).toBe(join(ws, "apps", "a.apk"));
  });

  it("refuses a path that starts with a dash", () => {
    expect(() => resolveAppBundlePath(ws, "-r")).toThrow(/inside \$BROWX_WORKSPACE/);
    expect(() => resolveAppBundlePath(ws, "--user=0")).toThrow(/inside \$BROWX_WORKSPACE/);
  });

  it("refuses an absolute path and a ../ path outside the workspace", () => {
    expect(() => resolveAppBundlePath(ws, join(outside, "real.apk"))).toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
    expect(() => resolveAppBundlePath(ws, "../outside/real.apk")).toThrow(
      /inside \$BROWX_WORKSPACE/,
    );
  });

  it("refuses a symlink inside the workspace that leads out of it", () => {
    symlinkSync(outside, join(ws, "link"));
    expect(() => resolveAppBundlePath(ws, "link/real.apk")).toThrow(/inside \$BROWX_WORKSPACE/);
  });

  it("words the refusal the same whether the outside path exists or not", () => {
    expect(refusal(join(outside, "real.apk"))).toBe(refusal(join(outside, "missing.apk")));
    expect(refusal("../outside/real.apk")).toBe(refusal("../outside/missing.apk"));
    symlinkSync(outside, join(ws, "link"));
    expect(refusal("link/real.apk")).toBe(refusal("link/missing.apk"));
  });
});
