// Paths 5 and 6: `browxai doctor` with BROWX_ATTACH_CDP at a closed port, and the help text against the flags the docs name.
// Neither starts a browser.
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { secs } from "./block.mjs";
import { run } from "./proc.mjs";

const lines = (r) => r.output.split("\n").filter((l) => l.trim());
const words = (text) => new Set(text.match(/--[a-z][a-z-]*/g) ?? []);

/** A loopback port nothing listens on: bind port 0, read the number, close. */
const closedPort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** Path 5: the attach area of doctor, and the next step under it. */
export async function doctorAttachPart({ rec, env, proj, WORK, facts }) {
  const ws = join(WORK, "ws-doctor");
  mkdirSync(ws, { recursive: true });
  const port = await closedPort();
  const url = `http://127.0.0.1:${port}`;
  const sh = { cwd: proj, env: { ...env, BROWX_WORKSPACE: ws, BROWX_ATTACH_CDP: url } };
  const brief = run("browxai", ["doctor"], sh);
  const verbose = run("browxai", ["doctor", "--verbose"], sh);
  const area = lines(brief).find((l) => /^\s+✗ attach\b/.test(l));
  const next = lines(brief)[lines(brief).indexOf(area) + 1] ?? "";
  rec.line(
    `[doctor] BROWX_ATTACH_CDP=${url} (closed) | exit ${brief.code} | ${area ? "attach: " : "NO attach row: "}${(area ?? "").replace(/^\s*✗ attach\s*/, "").slice(0, 90)} | ${secs(brief.ms)}`,
    area ? next : brief.output,
  );
  if (facts.cli.doctorAreas.length && !facts.cli.doctorAreas.includes("attach"))
    rec.note(
      `docs/tool-reference.md lists the doctor areas as ${facts.cli.doctorAreas.join(", ")}: no attach area`,
    );
  if (brief.code === 0)
    rec.diff(
      "doctor exited 0 with BROWX_ATTACH_CDP pointing at a closed port, the docs say it exits 1 when an area fails",
    );
  if (!area) {
    rec.diff("doctor printed no failing `attach` area for an unreachable BROWX_ATTACH_CDP");
  } else {
    if (!area.includes(String(port))) rec.note(`the attach row does not name the endpoint ${url}`);
    if (!/^\s+next: /.test(next))
      rec.diff("doctor printed no `next:` step under the failing attach area");
    else if (!/browxai chrome start/.test(next))
      rec.diff(
        `the attach next step is "${next.trim().slice(0, 120)}", the docs say \`browxai chrome start\` launches a Chrome to attach to`,
      );
  }
  const row = lines(verbose).find((l) => /^\s+✗ cdp-attach\b/.test(l));
  if (!row) rec.diff("doctor --verbose printed no failing `cdp-attach` row");
  else if (!lines(verbose)[lines(verbose).indexOf(row) + 1]?.includes("fix:"))
    rec.diff("doctor --verbose printed no `fix:` line under the cdp-attach row");
  if (verbose.code !== brief.code)
    rec.diff(`doctor --verbose exited ${verbose.code}, doctor exited ${brief.code}`);
}

/** Path 6: every flag the docs name appears in `--help`, and `chrome start --help` shows the chrome start flags. */
export function helpPart({ rec, env, proj, facts }) {
  const sh = { cwd: proj, env };
  const top = run("browxai", ["--help"], sh);
  const start = run("browxai", ["chrome", "start", "--help"], sh);
  const { flags, chromeStartFlags, signatures } = facts.cli;
  const missing = flags.filter((f) => !words(top.output).has(f));
  const missingStart = chromeStartFlags.filter((f) => !words(start.output).has(f));
  const commands = [...new Set(signatures.map((s) => s.path).filter(Boolean))];
  const unlisted = commands.filter((p) => !top.output.includes(`browxai ${p}`));
  rec.line(
    `[help] browxai --help | exit ${top.code} | ${flags.length - missing.length} of ${flags.length} documented flags shown, ${commands.length - unlisted.length} of ${commands.length} commands`,
  );
  rec.line(
    `[help] browxai chrome start --help | exit ${start.code} | ${chromeStartFlags.length - missingStart.length} of ${chromeStartFlags.length} chrome start flags shown`,
  );
  for (const [label, r] of [
    ["browxai --help", top],
    ["browxai chrome start --help", start],
  ])
    if (r.code !== 0) rec.diff(`${label} exited ${r.code}, help should exit 0`);
  if (flags.length === 0) rec.diff("no flags were read from the docs, so none were compared");
  if (missing.length)
    rec.diff(`the docs name flags that browxai --help does not show: ${missing.join(", ")}`);
  if (missingStart.length)
    rec.diff(`browxai chrome start --help does not show: ${missingStart.join(", ")}`);
  if (unlisted.length)
    rec.diff(`browxai --help does not list the documented command(s): ${unlisted.join(", ")}`);
  const undocumented = [...words(top.output)].filter((f) => !flags.includes(f));
  if (undocumented.length)
    rec.note(`browxai --help shows flags the docs do not name: ${undocumented.join(", ")}`);
  if (start.output === top.output)
    rec.note("browxai chrome start --help prints the same text as browxai --help");
}
