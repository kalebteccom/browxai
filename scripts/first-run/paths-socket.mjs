// Path 1: `browxai serve --socket <path>` plus two SDK clients attached by `endpoint: "unix://<path>"` (README: "Share one browser
// across agents" and the socket-attached transport). Asserts what those lines promise: a session client A opened is visible in
// list_sessions from client B and B can read its page, closing B (its own session and its connection) leaves A working, and the
// socket is owner-only as docs/tool-reference.md says. Records how many Chrome main processes run at each point.
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { secs } from "./block.mjs";
import { runAsync } from "./proc.mjs";
import { chromeMains, inWork, label, readTable, waitUntil } from "./procs.mjs";

const first = (t, n = 200) =>
  String(t ?? "")
    .replace(/\s+/g, " ")
    .slice(0, n);
const yn = (v) => (v ? "yes" : "NO");
const accepts = (path) =>
  new Promise((resolve) => {
    const s = connect(path);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });

/** Copy a client script and procs.mjs into the project so `import "browxai"` resolves to the installed package. */
export function stageClient(proj, ROOT, file) {
  const dir = join(proj, "fr-paths");
  mkdirSync(dir, { recursive: true });
  for (const f of [file, "procs.mjs"])
    copyFileSync(join(ROOT, "scripts/first-run", f), join(dir, f));
  return join(dir, file);
}

export async function socketPart({ rec, env, proj, WORK, ROOT, fixture, facts }) {
  const sock = join(WORK, "s.sock");
  const ws = join(WORK, "ws-socket");
  mkdirSync(ws, { recursive: true });
  const serverEnv = { ...env, BROWX_WORKSPACE: ws, BROWX_HEADLESS: "1" };
  const started = Date.now();
  const server = spawn("browxai", ["serve", "--socket", sock], {
    cwd: proj,
    env: serverEnv,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (d) => (stderr = (stderr + d).slice(-1500)));
  let exited = null;
  server.on("exit", (code, signal) => (exited = { code, signal }));
  server.on("error", (e) => (exited = { code: -1, signal: null, error: e.message }));

  try {
    const up = await waitUntil(
      async () => exited !== null || (existsSync(sock) && (await accepts(sock))),
      60_000,
    );
    if (exited !== null || !up.ok) {
      rec.line(
        `[socket] browxai serve --socket | FAILED | ${secs(Date.now() - started)}`,
        first(stderr, 400),
      );
      rec.diff(
        `browxai serve --socket ${exited ? `exited (code ${exited.code}) before it listened` : "did not listen within 60 s"}: ${first(stderr, 240)}`,
      );
      return;
    }
    const mode = (statSync(sock).mode & 0o777).toString(8).padStart(4, "0");
    if (facts.cli.socketMode && mode !== facts.cli.socketMode.slice(-4))
      rec.diff(
        `the socket mode is ${mode}, docs/tool-reference.md says owner-only (${facts.cli.socketMode})`,
      );

    const script = stageClient(proj, ROOT, "sdk-socket-clients.mjs");
    // Asynchronous: the loopback page is served by this process, and the server's Chrome loads it.
    const run = await runAsync("node", [script], {
      cwd: proj,
      env: { ...env, FR_SOCKET: sock, FR_URL: fixture.url, FR_WORK: WORK },
      timeoutMs: 240_000,
    });
    const line = /^FR_PATHS (.*)$/m.exec(run.stdout)?.[1];
    const res = line ? JSON.parse(line) : undefined;
    const upMs = secs(up.ms);
    if (!res) {
      rec.line(
        `[socket] two clients | no result | exit ${run.code}`,
        `${first(run.stdout, 200)} ${run.stderr.slice(-400)}`,
      );
      rec.diff(
        `the two-client script printed no result (exit ${run.code}${run.timedOut ? ", timed out" : ""}): ${first(run.stderr.slice(-400), 300)}`,
      );
      return;
    }
    const c = res.counts;
    const shown = (v) => (v === null || v === undefined ? "n/a" : v);
    rec.line(
      `[socket] serve --socket up in ${upMs}, mode ${mode}; clients A and B attached, A opened a session | ${res.ok ? "ok" : "FAILED"}`,
      res.ok ? "" : res.error,
    );
    if (!res.ok) {
      rec.diff(`the two-client flow stopped: ${res.error}`);
      return;
    }
    rec.line(
      `[socket] B lists A's session: ${yn(res.bSees)}, B reads its page: ${yn(res.bReadsPage)} | Chrome mains: start ${shown(c.start)}, A open ${shown(c.afterA)}, B read ${shown(c.afterBRead)}`,
    );
    rec.line(
      `[socket] B opens its own session, then closes it and itself | Chrome mains ${shown(c.afterBOpen)}, then ${shown(c.afterBClose)} | A listed: ${yn(res.aStillListed)}, A works: ${yn(res.aStillWorks)}`,
    );
    if (!res.bSees)
      rec.diff(
        `client B's list_sessions does not list session fr-a, opened by client A (it lists: ${res.bSessionIds.join(", ") || "nothing"})`,
      );
    else if (res.bSeesUrl !== fixture.url)
      rec.note(
        `B sees A's session with url ${first(res.bSeesUrl, 80)}, A navigated to ${fixture.url}`,
      );
    if (!res.bReadsPage)
      rec.diff("client B could not read the page client A opened (snapshot of session fr-a)");
    if (!res.aStillListed || !res.aStillWorks)
      rec.diff(
        `closing client B ended client A's session (listed ${res.aStillListed}, snapshot works ${res.aStillWorks})`,
      );
    if (c.afterA !== null) {
      if (c.afterA - c.start !== 1)
        rec.note(
          `client A's one session started ${c.afterA - c.start} Chrome main process(es), not 1`,
        );
      if (c.afterBRead > c.afterA)
        rec.diff(
          `client B reading A's session started another Chrome (${c.afterA} -> ${c.afterBRead}), the README says the clients share one`,
        );
      if (c.afterBOpen > c.afterBRead)
        rec.note(
          `B's own incognito session started a second Chrome (${c.afterBRead} -> ${c.afterBOpen}): clients share one Chrome only on a session they share, as in the README example`,
        );
      if (c.afterBClose !== c.afterA)
        rec.note(
          `after B closed its session and connection, ${c.afterBClose} Chrome main process(es) run, expected ${c.afterA}`,
        );
      if (c.afterAClose !== 0)
        rec.note(`after A closed its session, ${c.afterAClose} Chrome main process(es) still run`);
    } else
      rec.note(
        "the process table is not readable here, so the Chrome process counts are not recorded",
      );
  } finally {
    await stop(server, () => exited, sock, WORK, rec);
  }
}

/** SIGTERM the server, wait, then say what it left behind and kill it. */
async function stop(server, exitOf, sock, WORK, rec) {
  if (exitOf() === null) server.kill("SIGTERM");
  const done = await waitUntil(() => exitOf() !== null, 20_000);
  if (!done.ok) {
    server.kill("SIGKILL");
    rec.note("browxai serve did not stop within 20 s of SIGTERM and was killed");
  } else if (exitOf().code !== 0 && exitOf().signal === null) {
    rec.note(`browxai serve exited ${exitOf().code} after SIGTERM`);
  }
  const rows = readTable();
  if (rows === null) return;
  const left = inWork(rows, WORK).filter(
    (p) => chromeMains([p], WORK).length > 0 || p.pid === server.pid,
  );
  if (left.length > 0) {
    rec.note(
      `after serve stopped, ${left.length} process(es) remain: ${left.map(label).join(", ").slice(0, 160)}`,
    );
    for (const p of left) {
      try {
        process.kill(p.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  if (existsSync(sock)) rec.note("the socket file is still there after serve stopped");
}
