// Section 4, DOCUMENTED PATHS NOT YET EXERCISED: what the README, the getting-started page, the guides and docs/tool-reference.md
// promise beyond the first flow, followed against the published package. Six parts, each in its own try block so a difference
// or a crash in one does not stop the others:
//   help        `browxai --help` and `browxai chrome start --help` show every flag the docs name        (paths-cli.mjs)
//   doctor      BROWX_ATTACH_CDP at a closed port prints the attach area and its next step              (paths-cli.mjs)
//   plugin      `browxai plugin` help, list, sync, install, info, upgrade, remove, plugins_list         (paths-plugin.mjs)
//   refusal     eval_js refused by default as the troubleshooting page quotes, then run once widened   (paths-refusal.mjs)
//   socket      `browxai serve --socket` with two SDK clients sharing one browser                       (paths-socket.mjs)
//   stdio-child the SDK's stdio-child transport: navigate, snapshot, close, no orphan                   (paths-stdio-child.mjs)
// Chrome starts only in the last three parts and only through the fenced binaries (install.mjs wrapped them and wrote
// fence.ok); without that proof they are skipped and the section exits 2. The only page loaded is the fixture on 127.0.0.1.
// Env: FR_ROOT, FR_WORK, FR_OUT. Exit: 0 as documented, 1 a documented path failed or differs, 2 a tool error.
import "./crash.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BUDGETS, emit, layout } from "./block.mjs";
import { startFixture } from "./fixture.mjs";
import { doctorAttachPart, helpPart } from "./paths-cli.mjs";
import { cliFacts, pluginFacts, refusalFacts } from "./path-facts.mjs";
import { pluginPart } from "./paths-plugin.mjs";
import { refusalPart } from "./paths-refusal.mjs";
import { socketPart } from "./paths-socket.mjs";
import { stdioChildPart } from "./paths-stdio-child.mjs";
import { cleanEnv } from "./proc.mjs";
import { recorder } from "./recorder.mjs";

const { FR_ROOT: ROOT, FR_WORK: WORK, FR_OUT: OUT } = process.env;
if (!ROOT || !WORK || !OUT) {
  console.error("paths: FR_ROOT, FR_WORK and FR_OUT must be set (run.sh does that)");
  process.exit(2);
}
const proj = join(WORK, "project");
const rec = recorder(join(OUT, "first-run", "paths"));
const headers = [
  "section: documented-paths (serve --socket with two clients, stdio-child, plugin CLI, capability refusal, doctor attach, help flags)",
];
let toolErrors = 0;
const toolError = (text) => {
  toolErrors += 1;
  rec.diff(text);
};
const finish = (code) => {
  emit("FRPATHS", layout(headers, rec.entries, rec.tail(code), BUDGETS.paths, 2));
  process.exit(code);
};
if (!existsSync(join(proj, "node_modules/.bin/browxai"))) {
  toolError("stopped: browxai is not installed");
  finish(2);
}

const first = (t, n = 160) =>
  String(t ?? "")
    .replace(/\s+/g, " ")
    .slice(0, n);
const browsersOk = existsSync(join(WORK, "fence.ok"));
const env = cleanEnv(WORK);
const fixture = await startFixture();
const ctx = {
  rec,
  env,
  proj,
  WORK,
  ROOT,
  fixture,
  browsersOk,
  toolError,
  facts: { refusal: refusalFacts(ROOT), cli: cliFacts(ROOT), plugin: pluginFacts(ROOT) },
};
headers.push(
  `page ${fixture.url}; Chrome ${browsersOk ? "fenced to loopback" : "NOT started (no fence proof)"}; stdio-child exit status is not visible in the SDK, so "clean" = child and its Chrome gone from /proc`,
);

async function part(name, fn, needsBrowser = false) {
  if (needsBrowser && !browsersOk) {
    toolError(`${name} skipped: the fence check did not pass, so no browser may start`);
    return;
  }
  try {
    await fn(ctx);
  } catch (e) {
    toolError(`${name}: stopped on a tool error: ${first(e?.stack ?? e, 300)}`);
  }
}

await part("help", helpPart);
await part("doctor", doctorAttachPart);
await part("plugin", pluginPart);
// The refusal part runs its first two servers without a browser and skips only the last step when there is no fence proof.
await part("refusal", refusalPart);
await part("socket", socketPart, true);
await part("stdio-child", stdioChildPart, true);

await fixture.close();
finish(toolErrors > 0 ? 2 : rec.diffs.length > 0 ? 1 : 0);
