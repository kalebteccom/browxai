import { describe, expect, it } from "vitest";
import type { RunOptions, RunResult } from "./runtime-exec.js";
import { checkEnv, newFailures, smokeCheck, type Handshake } from "./runtime-smoke.js";

const STAGED = { cli: "/rt/staging/0.22.0-1/node_modules/browxai/dist/cli.js", version: "0.22.0" };
const CURRENT = "/rt/versions/0.21.0/node_modules/browxai/dist/cli.js";

type Doctor = Array<{ name: string; ok: boolean }> | "unsupported";

/** A runner that answers `--version` and `doctor --json` per cli path. */
function runner(opts: { version?: string; doctor?: Record<string, Doctor> } = {}) {
  const calls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const run = (_file: string, args: readonly string[], o?: RunOptions): Promise<RunResult> => {
    calls.push({ args: [...args], env: o?.env });
    const [cli, sub] = args;
    if (sub === "--version")
      return Promise.resolve({ status: 0, stdout: `${opts.version ?? "0.22.0"}\n`, stderr: "" });
    const d = opts.doctor?.[cli!] ?? [{ name: "node", ok: true }];
    if (d === "unsupported") return Promise.resolve({ status: 2, stdout: "", stderr: "usage" });
    const ok = d.every((c) => c.ok);
    return Promise.resolve({
      status: ok ? 0 : 1,
      stdout: JSON.stringify({ version: "x", ok, checks: d }),
      stderr: "",
    });
  };
  return Object.assign(run, { calls });
}

const handshake =
  (version = "0.22.0", tools = 150): Handshake =>
  () =>
    Promise.resolve({ version, tools });

const deps = (run: ReturnType<typeof runner>, hs: Handshake = handshake()) => ({
  node: "/usr/bin/node",
  run,
  handshake: hs,
  env: { PATH: "/usr/bin", BROWX_CAPABILITIES: "eval", BROWX_WORKSPACE: "/home/u/ws" },
});

describe("checkEnv", () => {
  it("drops every BROWX_ setting and sets a temp workspace", () => {
    expect(
      checkEnv({ PATH: "/bin", BROWX_ATTACH_CDP: "http://x", BROWX_WORKSPACE: "/w" }, "/tmp/ws"),
    ).toEqual({
      PATH: "/bin",
      BROWX_WORKSPACE: "/tmp/ws",
    });
  });
});

describe("smokeCheck", () => {
  it("passes a version that answers all three checks", async () => {
    const run = runner();
    await expect(smokeCheck(STAGED, CURRENT, deps(run))).resolves.toEqual({ ok: true, notes: [] });
    expect(run.calls.map((c) => c.args.slice(1))).toEqual([
      ["--version"],
      ["doctor", "--json"],
      ["doctor", "--json"],
    ]);
    for (const c of run.calls) {
      expect(c.env?.BROWX_CAPABILITIES).toBeUndefined();
      expect(c.env?.BROWX_WORKSPACE).toMatch(/browxai-runtime-check-/);
    }
  });

  it("fails a --version that prints another version", async () => {
    const r = await smokeCheck(STAGED, CURRENT, deps(runner({ version: "0.21.9" })));
    expect(r).toEqual({ ok: false, reason: 'cli.js --version: printed "0.21.9", expected 0.22.0' });
  });

  it("fails a handshake that reports another version, no tool, or no answer", async () => {
    await expect(smokeCheck(STAGED, CURRENT, deps(runner(), handshake("0.21.0")))).resolves.toEqual(
      {
        ok: false,
        reason: "MCP handshake: the server reports 0.21.0, expected 0.22.0",
      },
    );
    await expect(
      smokeCheck(STAGED, CURRENT, deps(runner(), handshake("0.22.0", 0))),
    ).resolves.toMatchObject({
      ok: false,
      reason: "MCP handshake: tools/list returned no tool",
    });
    const silent: Handshake = () => Promise.reject(new Error("no answer within 20 seconds"));
    await expect(smokeCheck(STAGED, CURRENT, deps(runner(), silent))).resolves.toEqual({
      ok: false,
      reason: "MCP handshake: no answer within 20 seconds",
    });
  });

  it("fails a doctor row that passes on current and fails on staging", async () => {
    const run = runner({
      doctor: {
        [CURRENT]: [
          { name: "workspace", ok: true },
          { name: "firefox", ok: false },
        ],
        [STAGED.cli]: [
          { name: "workspace", ok: false },
          { name: "firefox", ok: false },
          { name: "brand-new", ok: false },
        ],
      },
    });
    await expect(smokeCheck(STAGED, CURRENT, deps(run))).resolves.toEqual({
      ok: false,
      reason: "doctor rows that pass on current fail on 0.22.0: workspace",
    });
  });

  it("skips the comparison when either side has no doctor --json, and with no current", async () => {
    const old = runner({ doctor: { [CURRENT]: "unsupported" } });
    await expect(smokeCheck(STAGED, CURRENT, deps(old))).resolves.toEqual({
      ok: true,
      notes: ["current has no doctor --json, so the doctor rows were not compared"],
    });
    const staged = runner({ doctor: { [STAGED.cli]: "unsupported" } });
    await expect(smokeCheck(STAGED, CURRENT, deps(staged))).resolves.toMatchObject({ ok: true });
    const first = runner({ doctor: { [STAGED.cli]: [{ name: "chrome", ok: false }] } });
    await expect(smokeCheck(STAGED, undefined, deps(first))).resolves.toEqual({
      ok: true,
      notes: [],
    });
  });
});

describe("newFailures", () => {
  it("counts a row name that fails once on current as already failing", () => {
    const current = {
      checks: [
        { name: "plugins", ok: true },
        { name: "plugins", ok: false },
      ],
    };
    const staged = { checks: [{ name: "plugins", ok: false }] };
    expect(newFailures(current, staged)).toEqual([]);
  });
});
