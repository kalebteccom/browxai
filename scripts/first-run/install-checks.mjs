// The comparisons of section 1 against what the getting-started page says, as DIFF lines on the recorder.
// A DIFF is a documented command that failed or printed something the page does not say. Anything else is a NOTE.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const lines = (r) => r.output.split("\n").filter((l) => l.trim());
const AREA = /^\s{2}(✓|✗|⚠) /;
const CROSS = "✗";

/** doctor and doctor --verbose. phase "bare": no browser yet, the page says doctor fails. phase "ready": it must pass. */
export function checkDoctor(rec, brief, verbose, { phase, facts }) {
  const tag = phase === "bare" ? "no browser" : "browser installed";
  const areas = lines(brief).filter((l) => AREA.test(l));
  const crosses = areas.filter((l) => l.includes(CROSS));
  const nexts = lines(brief).filter((l) => /^\s+next:/.test(l)).length;
  if (areas.length === 0) rec.diff(`doctor (${tag}) printed no tick or cross area lines`);
  if (brief.code === 0 && crosses.length) rec.diff(`doctor (${tag}) exited 0 and printed a cross`);
  if (brief.code !== 0 && crosses.length === 0)
    rec.diff(`doctor (${tag}) exited ${brief.code} and printed no cross`);
  if (crosses.length && nexts < crosses.length) {
    rec.diff(
      `doctor (${tag}): ${crosses.length} failing area(s) but ${nexts} next step(s) under them`,
    );
  }
  if (verbose.code !== brief.code)
    rec.diff(`doctor --verbose (${tag}) exited ${verbose.code}, doctor exited ${brief.code}`);
  if (lines(verbose).length <= lines(brief).length)
    rec.diff(`doctor --verbose (${tag}) printed no more lines than doctor`);
  if (phase === "ready" && brief.code !== 0)
    rec.diff(`doctor still exits ${brief.code} after the documented browser install`);
  if (phase !== "bare") return;
  const browser = areas.find((l) => /browser/.test(l));
  if (brief.code === 0) {
    rec.diff("doctor passed with no browser downloaded, the page says it fails until you add one");
  } else if (!browser?.includes(CROSS)) {
    rec.diff("doctor failed with no browser, but not on the browser area");
  } else {
    const hint = /npx playwright-core\S* install chromium/.exec(brief.output)?.[0];
    if (!hint) rec.diff("doctor's browser step does not name the install command");
    else if (facts.installCmd && hint !== facts.installCmd)
      rec.diff(`doctor says \`${hint}\`, the page says \`${facts.installCmd}\``);
  }
}

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);
const json = (p) => {
  try {
    return JSON.parse(read(p) ?? "");
  } catch {
    return undefined;
  }
};

/** browxai init with each flag the page mentions. Only the run in `main` starts a browser (init's own smoke test). */
export function checkInit(rec, { run, env, WORK, proj, cursorCfg, facts }) {
  const at = (cwd) => ({ cwd, env, timeoutMs: 240_000 });
  const before = read(cursorCfg);
  const bak = facts.bakSuffix ? `${cursorCfg}${facts.bakSuffix}` : `${cursorCfg}.browxai-bak`;

  // --no-write: print everything, write nothing, no smoke test.
  const a = join(WORK, "init-no-write");
  const ra = rec.add(
    "browxai init --no-write <dir>",
    run("browxai", ["init", "--no-write", a], at(proj)),
  );
  if (ra.code !== 0) rec.diff(`init --no-write exited ${ra.code}`);
  if (existsSync(join(a, ".mcp.json")) || existsSync(join(a, ".browxai")))
    rec.diff("init --no-write wrote files");
  if (read(cursorCfg) !== before) rec.diff("init --no-write changed the user-level Cursor config");
  if (facts.smokeRe?.test(ra.output)) rec.diff("init --no-write ran the smoke check");

  // --no-write-user-config: the project file only, user-level configs alone.
  const b = join(WORK, "init-no-user-config");
  const rb = rec.add(
    "browxai init <dir> --no-write-user-config --no-smoke",
    run("browxai", ["init", b, "--no-write-user-config", "--no-smoke"], at(proj)),
  );
  if (rb.code !== 0) rec.diff(`init --no-write-user-config exited ${rb.code}`);
  if (!json(join(b, ".mcp.json"))?.mcpServers?.browxai)
    rec.diff("init did not write .mcp.json with a browxai entry");
  if (read(cursorCfg) !== before || existsSync(bak))
    rec.diff("init --no-write-user-config touched the user-level Cursor config");
  if (facts.smokeRe?.test(rb.output)) rec.diff("init --no-smoke printed the first-snapshot line");

  // The command as the page shows it: `browxai init .` in the project, with the smoke test.
  const c = join(WORK, "init-main");
  mkdirSync(c, { recursive: true });
  const rc = rec.add("browxai init . (the page's command)", run("browxai", ["init", "."], at(c)));
  if (rc.code !== 0) rec.diff(`init . exited ${rc.code}`);
  const entry = json(join(c, ".mcp.json"))?.mcpServers?.browxai;
  if (!entry) rec.diff("init . wrote no .mcp.json with a browxai entry");
  if (facts.smokeRe && !facts.smokeRe.test(rc.output)) {
    const last = lines(rc).at(-1) ?? "(no output)";
    rec.diff(`init . did not print "${facts.quotedSmoke}"; last line: ${last.slice(0, 120)}`);
  }
  const ms = /first snapshot in (\d+) ms/.exec(rc.output)?.[1];
  if (ms) rec.note(`init's first snapshot took ${ms} ms`);
  const merged = json(cursorCfg);
  if (!merged?.mcpServers?.browxai || !merged.mcpServers.other)
    rec.diff("init . did not merge browxai into the existing Cursor config");
  if (read(bak) !== before)
    rec.diff(`init . did not keep the old Cursor config as ${bak.split("/").pop()}`);
  if (entry && facts.cursorSnippetCommand && entry.command !== facts.cursorSnippetCommand) {
    rec.note(
      `the printed entry runs "${entry.command} ${(entry.args ?? []).join(" ").slice(0, 60)}", the page's client examples use "${facts.cursorSnippetCommand}"`,
    );
  }

  // --write-user-config still works and does nothing extra; a config that already has an entry is left alone.
  const afterMain = read(cursorCfg);
  const d = join(WORK, "init-legacy-flag");
  const rd = rec.add(
    "browxai init <dir> --write-user-config --no-smoke",
    run("browxai", ["init", d, "--write-user-config", "--no-smoke"], at(proj)),
  );
  if (rd.code !== 0) rec.diff(`init --write-user-config exited ${rd.code}`);
  if (read(cursorCfg) !== afterMain)
    rec.diff("init changed a Cursor config that already had a browxai entry");
}
