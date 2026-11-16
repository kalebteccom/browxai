// Section 1, CLEAN INSTALL: an empty directory, `npm init -y`, `npm install browxai@latest` from the registry, then the
// getting-started page step by step with the commands it shows. Records exit code, wall time and the first 25 output lines
// per command, and every difference from what the page says.
// Env: FR_ROOT (repo checkout), FR_WORK (throwaway work dir), FR_OUT (log dir). Exit: 0 as documented, 1 a documented command
// failed or differs, 2 a tool error (registry, missing package, the fence). Writes FR_WORK/fence.ok once the browsers are fenced.
import "./crash.mjs";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { emit, layout, secs, size } from "./block.mjs";
import { docFacts, downloadedBytes } from "./doc-facts.mjs";
import { checkDoctor, checkInit } from "./install-checks.mjs";
import { cleanEnv, run } from "./proc.mjs";
import { recorder } from "./recorder.mjs";

const { FR_ROOT: ROOT, FR_WORK: WORK, FR_OUT: OUT } = process.env;
if (!ROOT || !WORK || !OUT) {
  console.error("install: FR_ROOT, FR_WORK and FR_OUT must be set (run.sh does that)");
  process.exit(2);
}
const BUDGET = 8000;
const HERE = new URL(".", import.meta.url).pathname;
const proj = join(WORK, "project");
// Playwright's default browser directory on Linux, under the throwaway HOME.
const BROWSERS = join(WORK, "home/.cache/ms-playwright");
for (const d of ["project", "home/.cursor", "tmp", "npm-cache"])
  mkdirSync(join(WORK, d), { recursive: true });
const cursorCfg = join(WORK, "home/.cursor/mcp.json");
// A client config that exists, so init has one to merge into and keep a copy of.
writeFileSync(
  cursorCfg,
  `${JSON.stringify({ mcpServers: { other: { command: "other" } } }, null, 2)}\n`,
);

const env = cleanEnv(WORK);
const facts = docFacts(ROOT);
const rec = recorder(join(OUT, "first-run", "install"));
const headers = [
  "section: clean-install (npm install browxai@latest, then the getting-started page)",
];
const kb = (path) => Number(/^(\d+)/.exec(run("du", ["-sk", path]).output)?.[1] ?? 0) * 1024;
const finish = (code) => {
  const text = layout(headers, rec.entries, rec.tail(code), BUDGET);
  emit("FRINSTALL", text);
  process.exit(code);
};
const fatal = (why) => {
  rec.diff(`stopped: ${why}`);
  finish(2);
};

// Node and npm on the pinned image, against the page's "Node 22 or newer".
const node = process.versions.node;
headers.push(`node v${node}, npm ${run("npm", ["--version"], { env }).output.trim()}`);
if (facts.nodeMin && Number(node.split(".")[0]) < facts.nodeMin)
  rec.note(`node v${node} is below the page's minimum ${facts.nodeMin}`);

// (1) The registry install, cold npm cache.
rec.add("npm init -y", run("npm", ["init", "-y"], { cwd: proj, env }));
const inst = rec.add(
  "npm install browxai@latest",
  run("npm", ["install", "browxai@latest"], { cwd: proj, env }),
);
const pkgFile = join(proj, "node_modules/browxai/package.json");
if (inst.code !== 0 || !existsSync(pkgFile))
  fatal("npm install browxai@latest failed, nothing to follow");
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
const pw = JSON.parse(
  readFileSync(join(proj, "node_modules/playwright-core/package.json"), "utf8"),
).version;
const added = /added (\d+) packages?/.exec(inst.output)?.[1] ?? "?";
const deprecated = (inst.output.match(/npm warn deprecated/gi) ?? []).length;
headers.push(
  `browxai@latest = ${pkg.version}, install ${secs(inst.ms)}, ${added} packages, node_modules ${size(kb(join(proj, "node_modules")))}, ${deprecated} deprecation warning(s), playwright-core ${pw}`,
);
if (facts.nodeMin && !new RegExp(`>=\\s*${facts.nodeMin}\\b`).test(pkg.engines?.node ?? "")) {
  rec.diff(
    `the page says Node ${facts.nodeMin} or newer, package engines.node is ${pkg.engines?.node ?? "unset"}`,
  );
}

// (2) `npx browxai --version`.
const ver = rec.add(
  "npx browxai --version",
  run("npx", ["browxai", "--version"], { cwd: proj, env }),
);
if (ver.code !== 0 || ver.output.trim() !== pkg.version) {
  rec.diff(
    `npx browxai --version printed "${ver.output.trim().slice(0, 60)}" (exit ${ver.code}), the installed version is ${pkg.version}`,
  );
}

// (3) doctor with no browser yet: the page says it fails until you add one, with the next step under the failing area.
const sh = { cwd: proj, env };
const bare = rec.add("browxai doctor (no browser yet)", run("browxai", ["doctor"], sh));
const bareV = rec.add(
  "browxai doctor --verbose (no browser yet)",
  run("browxai", ["doctor", "--verbose"], sh),
);
checkDoctor(rec, bare, bareV, { phase: "bare", facts });

// (4) The browser. The page's command, then its --with-deps variant for a bare Linux image.
if (!facts.tellsBrowser)
  rec.diff("the page gives a newcomer without Chrome no command to get a browser");
if (facts.pin && facts.pin !== pw) {
  rec.diff(
    `the page pins playwright-core@${facts.pin}, browxai@${pkg.version} depends on ${pw}: the page downloads a browser build the installed one will not launch`,
  );
}
if (facts.readmePin && facts.pin && facts.readmePin !== facts.pin)
  rec.diff(`README pins playwright-core@${facts.readmePin}, the page pins ${facts.pin}`);
const [pc, ...pa] = (facts.installCmd ?? `npx playwright-core@${pw} install chromium`).split(" ");
const dl = rec.add(
  facts.installCmd ?? "npx playwright-core install chromium (page quotes none)",
  run(pc, pa, { cwd: proj, env, timeoutMs: 900_000 }),
);
const wire = downloadedBytes(dl.output);
const disk = kb(BROWSERS);
headers.push(
  `browser download ${secs(dl.ms)}: ${wire ? `${size(wire)} downloaded` : "download size not printed"}, ${size(disk)} on disk`,
);
if (dl.code !== 0) rec.diff(`the page's browser command exited ${dl.code}`);
if (
  facts.sizeMb &&
  wire &&
  (wire / 1024 ** 2 > facts.sizeMb * 1.5 || wire / 1024 ** 2 < facts.sizeMb / 1.5)
) {
  rec.diff(`the page says about ${facts.sizeMb} MB, Playwright downloaded ${size(wire)}`);
}
if (facts.depsCmd) {
  const [dc, ...da] = facts.depsCmd.split(" ");
  const deps = rec.add(facts.depsCmd, run(dc, da, { cwd: proj, env, timeoutMs: 900_000 }));
  if (deps.code !== 0)
    rec.diff(
      `the page's --with-deps command exited ${deps.code} (needs root and the distro package mirrors)`,
    );
}
if (dl.code !== 0) fatal("no browser, so no browser may start");

// (5) The fence, before any browser starts.
const fenced = run("bash", [join(HERE, "fence-browsers.sh"), BROWSERS, join(WORK, "fence")], {
  env,
});
const check =
  fenced.code === 0
    ? run("node", [join(HERE, "fence-check.mjs"), BROWSERS, WORK, proj], { env })
    : fenced;
rec.add("fence: wrap Playwright's Chrome binaries, prove loopback only", {
  ...check,
  output: `${fenced.output}${check === fenced ? "" : check.output}`,
});
if (check.code !== 0 || !existsSync(join(WORK, "fence.ok")))
  fatal("the fence check failed, so no browser may start");

// (6) doctor with the browser in place.
const ready = rec.add("browxai doctor", run("browxai", ["doctor"], sh));
const readyV = rec.add("browxai doctor --verbose", run("browxai", ["doctor", "--verbose"], sh));
checkDoctor(rec, ready, readyV, { phase: "ready", facts });

// (7) init, with every flag the page mentions. The user-level Cursor config is the one init may merge into.
checkInit(rec, { run, env, WORK, proj, cursorCfg, facts });
finish(rec.diffs.length ? 1 : 0);
