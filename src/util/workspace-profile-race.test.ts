// BROWX_DEFAULT_PROFILE creation race: something swaps the path for a symlink
// between the existence check and the mkdir. The resolver has to notice after
// creating, and must never chmod through the link.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plan: { target?: string; linkTo?: string } = {};

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: (p: realFs.PathLike, o?: realFs.MakeDirectoryOptions) => {
      if (plan.target && String(p) === plan.target && plan.linkTo) {
        actual.symlinkSync(plan.linkTo, plan.target);
        return undefined;
      }
      return actual.mkdirSync(p, o);
    },
  };
});

const { resolveDefaultProfileDir } = await import("./workspace.js");

let dir: string | undefined;
afterEach(() => {
  plan.target = plan.linkTo = undefined;
  if (dir) realFs.rmSync(dir, { recursive: true, force: true });
});

describe("BROWX_DEFAULT_PROFILE creation race", () => {
  it("refuses a path that became a symlink during creation and leaves the target's mode alone", () => {
    dir = realFs.mkdtempSync(join(tmpdir(), "browx-race-"));
    const victim = join(dir, "victim");
    realFs.mkdirSync(victim);
    realFs.chmodSync(victim, 0o755);
    plan.target = join(dir, "profile");
    plan.linkTo = victim;
    expect(() => resolveDefaultProfileDir({ BROWX_DEFAULT_PROFILE: plan.target })).toThrow(
      /became a symlink/,
    );
    expect(realFs.statSync(victim).mode & 0o777).toBe(0o755);
  });
});
