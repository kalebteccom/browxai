// The README's stdio-child transport: `createBrowxai({ transport: "stdio-child" })` spawns the `browxai` bin as a subprocess,
// `close()` ends it. This script navigates, takes a snapshot, closes, then looks at the process table for the child and for any
// Chrome it started. Run by paths-stdio-child.mjs from the throwaway project (copied next to procs.mjs); .depcheckrc.json
// ignores it like sdk-quickstart.mjs. Env: FR_URL (loopback page), FR_WORK (throwaway directory), plus the clean environment
// (PATH with the project's .bin, HOME, TMPDIR, BROWX_WORKSPACE, BROWX_HEADLESS), which is also handed to the child.
// Prints one `FR_PATHS {json}` line of facts.
import { createBrowxai } from "browxai";
import { chromeMains, inWork, isBrowxaiProcess, label, readTable, waitUntil } from "./procs.mjs";

const { FR_URL: url, FR_WORK: work } = process.env;
const KEEP = /^(PATH|HOME|TMPDIR|NO_UPDATE_NOTIFIER|DO_NOT_TRACK|npm_config_cache|BROWX_.*)$/;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => KEEP.test(k)));
const text = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");
const out = {};
let client;

try {
  // What already runs, so a process left by an earlier check is not blamed on this transport.
  const startRows = readTable();
  const startPids = new Set((startRows ?? []).map((p) => p.pid));
  out.chromeStart = startRows ? chromeMains(startRows, work).length : null;
  const t0 = Date.now();
  client = await createBrowxai({ transport: "stdio-child", env });
  out.createMs = Date.now() - t0;
  const nav = await client.navigate({ url });
  out.navigateOk = nav.data?.ok !== false;
  if (!out.navigateOk) out.navigateError = text(nav).slice(0, 200);
  const snap = await client.snapshot();
  out.snapshotOk = /\[ref=e\d+\]/.test(text(snap)) && text(snap).includes("Subscribe");

  const rows = readTable();
  out.procs = rows !== null;
  if (rows) {
    const kids = rows.filter((p) => p.ppid === process.pid && isBrowxaiProcess(p));
    out.childPid = kids[0]?.pid ?? null;
    out.children = kids.length;
    out.chromeBefore = chromeMains(rows, work).length;
  }

  const t1 = Date.now();
  await client.close();
  out.closeMs = Date.now() - t1;
  if (rows) {
    const gone = await waitUntil(() => {
      const now = readTable() ?? [];
      const childUp = out.childPid !== null && now.some((p) => p.pid === out.childPid);
      return !childUp && chromeMains(now, work).length <= out.chromeStart;
    }, 15_000);
    out.goneMs = gone.ok ? out.closeMs + gone.ms : null;
    const now = readTable() ?? [];
    out.chromeAfter = chromeMains(now, work).length;
    out.childAlive = out.childPid !== null && now.some((p) => p.pid === out.childPid);
    out.leftover = inWork(now, work, [process.pid])
      .filter((p) => !startPids.has(p.pid))
      .filter((p) => isBrowxaiProcess(p) || chromeMains([p], work).length > 0)
      .slice(0, 6)
      .map(label);
  }
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String(e?.message ?? e).slice(0, 300);
} finally {
  await client?.close().catch(() => {});
}
console.log(`FR_PATHS ${JSON.stringify(out)}`);
process.exit(out.ok ? 0 : 1);
