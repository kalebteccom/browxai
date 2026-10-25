// `browxai init` smoke test: start the server over stdio the way an MCP client
// would, open a headless incognito session on about:blank, take one snapshot,
// close. No network and no real profile: the child gets an empty temp workspace
// and a minimal environment, so no attach setting, engine choice or capability
// list from the user's shell reaches it.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseEnvelope } from "../sdk/envelope.js";
import type { BrowxaiContentItem } from "../sdk/types.js";

export interface SmokeResult {
  ok: boolean;
  /** The line to print: `ok: first snapshot in N ms`, or what went wrong and what to do. */
  message: string;
}

export interface SmokeOptions {
  /** The built `cli.js` to start. */
  distCli: string;
  /** Per-call limit in ms. Opening a session includes launching the browser. */
  timeoutMs?: number;
}

const SESSION = "init-smoke";
const NEXT = "Run `browxai doctor` to see what is missing, or skip this check with --no-smoke.";

export async function runSmoke(opts: SmokeOptions): Promise<SmokeResult> {
  if (!existsSync(opts.distCli)) {
    return {
      ok: false,
      message: `error: ${opts.distCli} does not exist. Reinstall browxai, or run \`pnpm build\` in a source checkout. ${NEXT}`,
    };
  }
  const timeout = opts.timeoutMs ?? 60_000;
  const workspace = mkdtempSync(join(tmpdir(), "browxai-smoke-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [opts.distCli],
    env: { BROWX_WORKSPACE: workspace, BROWX_HEADLESS: "1" },
    stderr: "pipe",
  });
  // Ctrl+C while the check runs: stop the server and remove the temp workspace.
  const offSignal = onInterrupt(() => {
    const pid = transport.pid;
    if (pid !== null) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    removeDir(workspace);
  });
  let stderrTail = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1500);
  });
  const client = new Client({ name: "browxai-init", version: "0" }, { capabilities: {} });

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
    const parsed = parseEnvelope((res.content as BrowxaiContentItem[] | undefined) ?? []);
    const data = parsed.data as { ok?: boolean; error?: unknown; hint?: unknown } | undefined;
    const failed = res.isError === true || data?.ok === false;
    return { failed, why: failed ? describeFailure(data, parsed.content) : "" };
  };

  try {
    try {
      await client.connect(transport, { timeout });
    } catch (e) {
      return {
        ok: false,
        message: `error: the server did not start (${firstLine(stderrTail) || errText(e)}). ${NEXT}`,
      };
    }
    const started = Date.now();
    const opened = await call("open_session", { session: SESSION, mode: "incognito" });
    if (opened.failed) {
      return {
        ok: false,
        message: `error: could not open a browser session: ${opened.why} ${NEXT}`,
      };
    }
    try {
      const snap = await call("snapshot", { session: SESSION });
      if (snap.failed) {
        return { ok: false, message: `error: the snapshot failed: ${snap.why} ${NEXT}` };
      }
      return { ok: true, message: `ok: first snapshot in ${Date.now() - started} ms` };
    } finally {
      await call("close_session", { session: SESSION }).catch(() => undefined);
    }
  } catch (e) {
    return { ok: false, message: `error: ${errText(e)}. ${NEXT}` };
  } finally {
    offSignal();
    await client.close().catch(() => undefined);
    removeDir(workspace);
  }
}

/** The part of `process` that `onInterrupt` uses, so a test can supply its own. */
export interface SignalHost {
  on(event: "SIGINT" | "SIGTERM", listener: (signal: NodeJS.Signals) => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
}

/** Run `cleanup` and exit on SIGINT or SIGTERM until the returned function is
 *  called. Exits 130 for SIGINT and 143 for SIGTERM, as a shell would. */
export function onInterrupt(cleanup: () => void, host: SignalHost = process): () => void {
  const off = () => {
    host.off("SIGINT", handler);
    host.off("SIGTERM", handler);
  };
  const handler = (signal: NodeJS.Signals) => {
    off();
    try {
      cleanup();
    } finally {
      host.exit(signal === "SIGINT" ? 130 : 143);
    }
  };
  host.on("SIGINT", handler);
  host.on("SIGTERM", handler);
  return off;
}

/** Remove a temp dir. A dir still held open (EBUSY or EPERM on Windows while the
 *  child exits) is left for the OS to clear. */
export function removeDir(dir: string, rm: typeof rmSync = rmSync): void {
  try {
    rm(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw e;
  }
}

function describeFailure(
  data: { error?: unknown; hint?: unknown } | undefined,
  content: ReadonlyArray<BrowxaiContentItem>,
): string {
  const parts = [data?.error, data?.hint].filter(
    (x): x is string => typeof x === "string" && x !== "",
  );
  if (parts.length) return parts.map((p) => firstLine(p).replace(/[.\s]+$/, "") + ".").join(" ");
  const text = content.find((c) => c.type === "text");
  return text && "text" in text ? firstLine(String(text.text)) : "no detail from the server.";
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim().slice(0, 300);
}

function errText(e: unknown): string {
  return firstLine(e instanceof Error ? e.message : String(e));
}
