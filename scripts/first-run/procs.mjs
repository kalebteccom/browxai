// The Linux process table, read from /proc, for the first-run checks that count Chrome main processes and look for orphans.
// No `ps` dependency (a slim image may lack procps). `readTable()` returns null where /proc is not readable (a Mac dry run),
// and every caller then skips its process assertions instead of reporting a difference.
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";

/** [{ pid, ppid, state, argv, cmd }] for every readable process, or null when /proc is unavailable. */
export function readTable() {
  let names;
  try {
    names = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  const rows = [];
  for (const name of names) {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      // "pid (comm) state ppid ...": comm may hold spaces and parentheses, so cut at the last ")".
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const argv = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").filter(Boolean);
      rows.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        state: fields[0],
        argv,
        cmd: argv.join(" "),
      });
    } catch {
      /* the process exited while the table was read */
    }
  }
  return rows;
}

const CHROME_BINARY = /^(chrome|chrome-headless-shell|headless_shell)(\.real)?$/;

/** Chrome browser processes started from this run's throwaway directory: the binary is Chrome or its headless shell,
 *  the command line has no --type= (renderers, the GPU process and the zygote all have one), and it is not a zombie. */
export function chromeMains(rows, work) {
  return rows.filter(
    (p) =>
      p.state !== "Z" &&
      p.argv.length > 0 &&
      CHROME_BINARY.test(basename(p.argv[0])) &&
      !p.argv.some((a) => a.startsWith("--type=")) &&
      p.cmd.includes(work),
  );
}

/** The browxai server a spawn of `browxai` makes: node running the bin or dist/cli.js. */
export const isBrowxaiProcess = (p) =>
  p.state !== "Z" &&
  /^node/.test(basename(p.argv[0] ?? "")) &&
  p.argv.slice(1).some((a) => /(^|\/)browxai$/.test(a) || /browxai\/dist\/cli\.js$/.test(a));

/** Every live process whose command line mentions the throwaway directory, apart from `except` pids. */
export const inWork = (rows, work, except = []) =>
  rows.filter((p) => p.state !== "Z" && p.cmd.includes(work) && !except.includes(p.pid));

/** Short label for a process in a report: pid, binary name and parent. */
export const label = (p) => `${p.pid} ${basename(p.argv[0] ?? "?")} (parent ${p.ppid})`;

/** Poll `fn` every `step` ms until it returns a truthy value or `ms` passes. Resolves { ok, ms, value }. */
export async function waitUntil(fn, ms, step = 250) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return { ok: true, ms: Date.now() - started, value };
    if (Date.now() - started >= ms) return { ok: false, ms: Date.now() - started, value };
    await new Promise((r) => setTimeout(r, step));
  }
}
