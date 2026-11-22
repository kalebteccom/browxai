// Path 7: the shell route (`browxai tools`, `browxai call`) against a `browxai serve --socket` daemon, as the "Drive browxai from a
// shell" guide and docs/tool-reference.md describe it: the commands as separate processes, the JSON document on standard output,
// the exit codes, the session and the refs that live in the daemon, the secret-safe standard input form, `--out`, `--max-chars` and
// the usage text. It runs against the PUBLISHED package, so while the docs lead a release it is skipped with a NOTE when the
// installed browxai has no `call` subcommand (hasShellRoute). Also records what one command costs, the number RFC 0011 left open.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { secs } from "./block.mjs";
import { DONE_TEXT, EMAIL } from "./fixture.mjs";
import { accepts, stop } from "./paths-socket.mjs";
import { run, runAsync } from "./proc.mjs";
import { waitUntil } from "./procs.mjs";

const first = (t, n = 200) =>
  String(t ?? "")
    .replace(/\s+/g, " ")
    .slice(0, n);
const SESSION = "fr-sh";

/** True when the installed browxai has the shell route: `browxai call` with no arguments prints its own usage, where an older
 *  build prints "unknown subcommand". */
export function hasShellRoute({ env, proj }) {
  const r = run("browxai", ["call"], { cwd: proj, env, timeoutMs: 60_000 });
  return /usage: browxai call/.test(r.output);
}

const parse = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
};

export async function shellPart({ rec, env, proj, WORK, fixture, facts, hasShell }) {
  if (!hasShell) {
    rec.note(
      "[shell] skipped: the installed browxai has no `call` subcommand, so the shell route in the docs is not compared until a release ships it",
    );
    return;
  }
  const { codes, fields } = facts.shell;
  if (codes.join() !== "0,1,2,3,4")
    rec.diff(`the docs list the shell exit codes as ${codes.join(", ") || "nothing"}, not 0 to 4`);
  const missingFields = ["isError", "data", "text", "images", "truncated"].filter(
    (f) => !fields.includes(f),
  );
  if (missingFields.length)
    rec.diff(`the docs do not describe these output fields: ${missingFields.join(", ")}`);

  const sock = join(WORK, "sh.sock");
  const ws = join(WORK, "ws-shell");
  mkdirSync(ws, { recursive: true });
  const server = spawn("browxai", ["serve", "--socket", sock], {
    cwd: proj,
    env: { ...env, BROWX_WORKSPACE: ws, BROWX_HEADLESS: "1" },
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
      rec.diff(`browxai serve --socket did not start for the shell route: ${first(stderr, 240)}`);
      return;
    }
    const times = [];
    const sh = async (args, opts = {}) => {
      const r = await runAsync("browxai", args, {
        cwd: proj,
        env: { ...env, ...opts.env },
        input: opts.input,
        timeoutMs: 120_000,
      });
      times.push(r.ms);
      return { r, doc: parse(r) };
    };
    const call = (tool, args, ...flags) =>
      sh(["call", tool, JSON.stringify(args), "--socket", sock, ...flags]);
    const wants = (what, ok, detail = "") => {
      if (!ok) rec.diff(`shell route: ${what}${detail ? ` (${first(detail, 160)})` : ""}`);
      return ok;
    };

    // tools: the daemon's list, then one tool's schema with no daemon.
    const list = await sh(["tools", "--socket", sock]);
    const snapshotRow = list.r.stdout.split("\n").find((l) => l.startsWith("snapshot "));
    wants("`browxai tools` exits 0", list.r.code === 0, list.r.stderr);
    wants(
      "`browxai tools` has a `snapshot` line with its capability and a description",
      /^snapshot\s+read\s+\S/.test(snapshotRow ?? ""),
      snapshotRow,
    );
    wants(
      "`browxai tools` still shows a placeholder description for some tool",
      !/\s+browxai\/\w+$/m.test(list.r.stdout),
    );
    const one = await sh(["tools", "click"]);
    wants(
      "`browxai tools click` prints a description and an input schema",
      one.r.code === 0 && one.r.stdout.includes("input schema:"),
      one.r.stderr,
    );

    // The flow: refs and the session live in the daemon, each command is its own process.
    const opened = await call("open_session", { session: SESSION, mode: "incognito" });
    const nav = await call("navigate", { session: SESSION, url: fixture.url });
    const snap = await call("snapshot", { session: SESSION });
    const refOk = /\[ref=e\d+\]/.test(snap.doc?.text ?? "") && snap.doc.text.includes("Subscribe");
    const filled = await sh(["call", "fill", "-", "--socket", sock], {
      input: JSON.stringify({ session: SESSION, selector: "#email", value: EMAIL }),
    });
    const clicked = await call("click", { session: SESSION, selector: "button" });
    const after = await sh(["call", "snapshot", "--socket", sock], {
      env: { BROWX_SESSION: SESSION },
    });
    const flow = [opened, nav, snap, filled, clicked, after];
    const shown = (after.doc?.text ?? "").includes(DONE_TEXT);
    rec.line(
      `[shell] tools, open, navigate, snapshot, fill (stdin), click, snapshot (BROWX_SESSION) | exits ${flow.map((f) => f.r.code).join(",")} | page shows "${DONE_TEXT}": ${shown ? "yes" : "NO"}`,
    );
    wants(
      "the open, navigate, snapshot, fill, click and snapshot commands exit 0",
      flow.every((f) => f.r.code === 0 && f.doc),
      flow.map((f) => first(f.r.stderr, 60)).join(" "),
    );
    wants(
      "the snapshot is `text` with refs, `data` is absent",
      refOk && snap.doc?.data === undefined,
    );
    wants(
      "a result has `isError` false and an `images` array",
      flow.every((f) => f.doc?.isError === false && Array.isArray(f.doc?.images)),
    );
    wants("fill took its arguments from standard input", filled.doc?.data?.ok === true);
    wants(`the page shows "${DONE_TEXT}" after the click`, shown);

    // The other exit codes.
    const missing = await call("click", { session: SESSION, selector: "#nope", timeoutMs: 1500 });
    const refused = await call("eval_js", { session: SESSION, expression: "1 + 1" });
    const noSocket = await sh(["call", "list_sessions"]);
    const noTool = await sh(["call"]);
    rec.line(
      `[shell] not found ${missing.r.code}, refused ${refused.r.code}, no socket ${noSocket.r.code}, no tool ${noTool.r.code} | one command: ${secs(Math.min(...times))} fastest, ${secs([...times].sort((a, b) => a - b)[Math.floor(times.length / 2)])} median`,
    );
    wants(
      "an element that is not there exits 1 with data.ok false",
      missing.r.code === 1 && missing.doc?.data?.ok === false,
    );
    wants(
      "a gated tool exits 4 with requiredCapability and a BROWX_CAPABILITIES hint",
      refused.r.code === 4 &&
        refused.doc?.data?.requiredCapability === "eval" &&
        String(refused.doc?.data?.hint).includes("BROWX_CAPABILITIES"),
      refused.r.stdout,
    );
    wants(
      "no socket path exits 3 with nothing on standard output",
      noSocket.r.code === 3 && noSocket.r.stdout === "",
    );
    wants(
      "a missing tool name exits 2 with the usage",
      noTool.r.code === 2 && /usage: browxai call/.test(noTool.r.stderr),
    );

    // --max-chars and --out.
    const cut = await sh(["call", "snapshot", "--socket", sock, "--max-chars", "50"], {
      env: { BROWX_SESSION: SESSION },
    });
    wants(
      "--max-chars cuts the result, sets truncated and still exits 0",
      cut.r.code === 0 && cut.doc?.truncated?.maxChars === 50 && cut.doc?.data === undefined,
    );
    const png = join(WORK, "fr-shot.png");
    const shot = await call("screenshot", { session: SESSION }, "--out", png);
    wants(
      "--out writes the first image and the document names it without pixels",
      shot.r.code === 0 &&
        existsSync(png) &&
        shot.doc?.images?.[0]?.path === png &&
        shot.r.stdout.length < 2000,
      shot.r.stderr,
    );
    const again = await call("screenshot", { session: SESSION }, "--out", png);
    wants("--out refuses to overwrite a file without --force (exit 2)", again.r.code === 2);

    // Help.
    for (const name of ["call", "tools"]) {
      const h = await sh([name, "--help"]);
      wants(
        `browxai ${name} --help prints its own usage`,
        h.r.code === 0 && h.r.stdout.startsWith(`usage: browxai ${name}`),
        h.r.stdout,
      );
    }
    await call("close_session", { session: SESSION });
  } finally {
    await stop(server, () => exited, sock, WORK, rec);
  }
}
