// `browxai runtime`: the checks a staged version passes before it becomes
// `current` (RFC 0015, D9). Each runs the staged `cli.js` with the runtime's node,
// an empty temp workspace and no `BROWX_*` setting from the caller, and no check
// starts a browser:
//   1. `cli.js --version` prints exactly the version, within 10 seconds;
//   2. an MCP handshake over stdio reports that version and at least one tool,
//      within 20 seconds;
//   3. `doctor --json` shows no row failing that passes on `current`. Rows that
//      depend on the machine fail on both and don't count;
//   4. `runtime status --json` exits 0 and prints JSON, so a version whose
//      updater can't start never becomes `current` and can't strand the machine.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Runner } from "./runtime-exec.js";

export interface HandshakeResult {
  version?: string;
  tools: number;
}

/** Start `cli` as an MCP stdio server and list its tools. Throws on failure. */
export type Handshake = (
  node: string,
  cli: string,
  env: Record<string, string>,
) => Promise<HandshakeResult>;

export interface SmokeDeps {
  node: string;
  run: Runner;
  handshake?: Handshake;
  /** The base environment the checks start from, before `BROWX_*` is dropped. */
  env: NodeJS.ProcessEnv;
}

export type SmokeResult = { ok: true; notes: string[] } | { ok: false; reason: string };

/** The caller's environment minus every `BROWX_*` setting, plus a temp workspace. */
export function checkEnv(env: NodeJS.ProcessEnv, workspace: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !k.startsWith("BROWX_")) out[k] = v;
  }
  out.BROWX_WORKSPACE = workspace;
  return out;
}

export async function smokeCheck(
  staged: { cli: string; version: string },
  currentCli: string | undefined,
  deps: SmokeDeps,
): Promise<SmokeResult> {
  const workspace = mkdtempSync(join(tmpdir(), "browxai-runtime-check-"));
  try {
    const env = checkEnv(deps.env, workspace);
    const printed = await deps.run(deps.node, [staged.cli, "--version"], {
      env,
      timeoutMs: 10_000,
    });
    const got = printed.stdout.trim();
    if (printed.status !== 0 || got !== staged.version) {
      const what =
        printed.error ?? (printed.status !== 0 ? `exit ${printed.status}` : `printed "${got}"`);
      return { ok: false, reason: `cli.js --version: ${what}, expected ${staged.version}` };
    }
    const hs = await (deps.handshake ?? mcpHandshake)(deps.node, staged.cli, env).catch(
      (e: unknown) => e,
    );
    if (hs instanceof Error || !hs || typeof hs !== "object") {
      return {
        ok: false,
        reason: `MCP handshake: ${hs instanceof Error ? hs.message : String(hs)}`,
      };
    }
    const { version, tools } = hs as HandshakeResult;
    if (version !== staged.version) {
      return {
        ok: false,
        reason: `MCP handshake: the server reports ${version ?? "no version"}, expected ${staged.version}`,
      };
    }
    if (tools < 1) return { ok: false, reason: "MCP handshake: tools/list returned no tool" };
    const doctor = await doctorStep(staged, currentCli, env, deps);
    if (!doctor.ok) return doctor;
    const status = await statusStep(
      staged.cli,
      { ...env, BROWX_RUNTIME_DIR: `${workspace}-runtime` },
      deps,
    );
    return status ?? doctor;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Step 4: the staged updater reads a runtime directory and reports. The
 *  directory named here doesn't exist, so the check writes nothing. Undefined
 *  when it passes. */
async function statusStep(
  cli: string,
  env: Record<string, string>,
  deps: SmokeDeps,
): Promise<SmokeResult | undefined> {
  const r = await deps.run(deps.node, [cli, "runtime", "status", "--json"], {
    env,
    timeoutMs: 20_000,
  });
  if (r.status !== 0) {
    return { ok: false, reason: `runtime status --json: ${r.error ?? `exit ${r.status}`}` };
  }
  try {
    const parsed = JSON.parse(r.stdout) as { dir?: unknown };
    if (typeof parsed.dir !== "string") throw new Error("no dir");
  } catch {
    return { ok: false, reason: "runtime status --json: it printed no status" };
  }
  return undefined;
}

type DoctorReport = { checks: Array<{ name: string; ok: boolean }> };

async function doctorJson(
  cli: string,
  env: Record<string, string>,
  deps: SmokeDeps,
): Promise<DoctorReport | "unsupported" | { error: string }> {
  const r = await deps.run(deps.node, [cli, "doctor", "--json"], { env, timeoutMs: 60_000 });
  if (r.status === 2) return "unsupported";
  if (r.status !== 0 && r.status !== 1) return { error: r.error ?? `exit ${r.status}` };
  try {
    const parsed = JSON.parse(r.stdout) as { checks?: unknown };
    if (!Array.isArray(parsed.checks)) throw new Error("no checks");
    const checks = parsed.checks.filter(
      (c): c is { name: string; ok: boolean } =>
        !!c &&
        typeof (c as { name?: unknown }).name === "string" &&
        typeof (c as { ok?: unknown }).ok === "boolean",
    );
    return { checks };
  } catch {
    return { error: "it printed no doctor report" };
  }
}

/** Row names that pass everywhere on `current` and fail somewhere on `staged`. */
export function newFailures(current: DoctorReport, staged: DoctorReport): string[] {
  const failsOn = (r: DoctorReport) => new Set(r.checks.filter((c) => !c.ok).map((c) => c.name));
  const passedBefore = new Set(current.checks.map((c) => c.name));
  for (const name of failsOn(current)) passedBefore.delete(name);
  return [...failsOn(staged)].filter((n) => passedBefore.has(n));
}

async function doctorStep(
  staged: { cli: string; version: string },
  currentCli: string | undefined,
  env: Record<string, string>,
  deps: SmokeDeps,
): Promise<SmokeResult> {
  const after = await doctorJson(staged.cli, env, deps);
  if (after === "unsupported") {
    return {
      ok: true,
      notes: [`${staged.version} has no doctor --json, so its doctor rows were not compared`],
    };
  }
  if ("error" in after) return { ok: false, reason: `doctor --json: ${after.error}` };
  if (!currentCli) return { ok: true, notes: [] };
  const before = await doctorJson(currentCli, env, deps);
  if (before === "unsupported" || "error" in before) {
    return {
      ok: true,
      notes: ["current has no doctor --json, so the doctor rows were not compared"],
    };
  }
  const broken = newFailures(before, after);
  if (broken.length > 0) {
    return {
      ok: false,
      reason: `doctor rows that pass on current fail on ${staged.version}: ${broken.join(", ")}`,
    };
  }
  return { ok: true, notes: [] };
}

/** The real handshake: the MCP SDK client over stdio, 20 seconds in all. */
export const mcpHandshake: Handshake = async (node, cli, env) => {
  const transport = new StdioClientTransport({ command: node, args: [cli], env, stderr: "ignore" });
  const client = new Client({ name: "browxai-runtime-check", version: "0" }, { capabilities: {} });
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("no answer within 20 seconds")), 20_000);
  });
  try {
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        const listed = await client.listTools();
        return { version: client.getServerVersion()?.version, tools: listed.tools.length };
      })(),
      limit,
    ]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
};
