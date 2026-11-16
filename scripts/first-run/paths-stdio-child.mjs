// Path 2: the SDK's stdio-child transport (README: "Spawns the `browxai` bin as a subprocess ... `close()` ends the child").
// Navigate, snapshot, close, then look for the child and for any Chrome it started. The script runs in the throwaway project.
import { secs } from "./block.mjs";
import { runAsync } from "./proc.mjs";
import { stageClient } from "./paths-socket.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const first = (t, n = 200) =>
  String(t ?? "")
    .replace(/\s+/g, " ")
    .slice(0, n);

export async function stdioChildPart({ rec, env, proj, WORK, ROOT, fixture }) {
  const ws = join(WORK, "ws-stdio-child");
  mkdirSync(ws, { recursive: true });
  const script = stageClient(proj, ROOT, "sdk-stdio-child.mjs");
  const run = await runAsync("node", [script], {
    cwd: proj,
    env: { ...env, BROWX_WORKSPACE: ws, BROWX_HEADLESS: "1", FR_URL: fixture.url, FR_WORK: WORK },
    timeoutMs: 240_000,
  });
  const line = /^FR_PATHS (.*)$/m.exec(run.stdout)?.[1];
  const res = line ? JSON.parse(line) : undefined;
  if (!res) {
    rec.line(
      `[stdio-child] navigate, snapshot, close | no result | exit ${run.code} | ${secs(run.ms)}`,
      run.stderr.slice(-400),
    );
    rec.diff(
      `the stdio-child script printed no result (exit ${run.code}${run.timedOut ? ", timed out" : ""}): ${first(run.stderr.slice(-400), 300)}`,
    );
    return;
  }
  if (!res.ok) {
    rec.line(`[stdio-child] navigate, snapshot, close | FAILED | ${secs(run.ms)}`, res.error);
    rec.diff(`createBrowxai({ transport: "stdio-child" }) flow failed: ${res.error}`);
    return;
  }
  const gone = res.goneMs === null || res.goneMs === undefined ? "n/a" : secs(res.goneMs);
  const chrome = res.procs
    ? `Chrome mains ${res.chromeStart} at start, ${res.chromeBefore} open, ${res.chromeAfter} after close`
    : "process table not readable";
  rec.line(
    `[stdio-child] navigate ${res.navigateOk ? "ok" : "FAILED"}, snapshot ${res.snapshotOk ? "ok" : "FAILED"}, close ${secs(res.closeMs)}, child gone after ${gone} | ${chrome}`,
  );
  if (!res.navigateOk) rec.diff(`stdio-child navigate failed: ${res.navigateError}`);
  if (!res.snapshotOk)
    rec.diff("stdio-child snapshot has no refs, or no Subscribe button, in the tree");
  if (!res.procs) {
    rec.note("the process table is not readable here, so the child and orphan checks were skipped");
    return;
  }
  if (res.childPid === null)
    rec.diff(
      `the README says stdio-child spawns the browxai bin as a subprocess, no such child was found (${res.children} browxai children of the script)`,
    );
  if (res.childAlive)
    rec.diff(
      `close() left the browxai child (pid ${res.childPid}) running after 15 s, the README says it ends the child`,
    );
  if (res.leftover.length > 0)
    rec.diff(
      `close() left ${res.leftover.length} process(es) behind: ${res.leftover.join(", ").slice(0, 160)}`,
    );
}
