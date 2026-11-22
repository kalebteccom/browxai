// Section 2, FIRST SNAPSHOT: browxai started over stdio the way an MCP client config starts it (command "browxai"), driven by
// a small stdio client against a static page with a form on 127.0.0.1. Records the result size and the elapsed time of every
// call. Also the README's SDK quickstart against the same page. No network beyond loopback; Chrome starts only through the
// fenced binaries (install.mjs wrapped them and wrote fence.ok).
// Env: FR_ROOT, FR_WORK, FR_OUT. Exit: 0 the flow worked, 1 a documented call failed or differs, 2 a tool error.
import "./crash.mjs";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BUDGETS, emit, estTokens, layout, secs } from "./block.mjs";
import { DONE_TEXT, EMAIL, PAGE_TITLE, startFixture } from "./fixture.mjs";
import { startMcp } from "./mcp-client.mjs";
import { cleanEnv, runAsync } from "./proc.mjs";
import { recorder } from "./recorder.mjs";

const { FR_ROOT: ROOT, FR_WORK: WORK, FR_OUT: OUT } = process.env;
if (!ROOT || !WORK || !OUT) {
  console.error("snapshot: FR_ROOT, FR_WORK and FR_OUT must be set (run.sh does that)");
  process.exit(2);
}
const BUDGET = BUDGETS.snapshot;
const proj = join(WORK, "project");
const rec = recorder(join(OUT, "first-run", "snapshot"));
const headers = ["section: first-snapshot (stdio client, static form page on 127.0.0.1)"];
const finish = (code) => {
  emit("FRSNAP", layout(headers, rec.entries, rec.tail(code), BUDGET, 4));
  process.exit(code);
};
if (!existsSync(join(WORK, "fence.ok")) || !existsSync(join(proj, "node_modules/.bin/browxai"))) {
  rec.diff(
    "stopped: the fence check did not pass or browxai is not installed, so no browser may start",
  );
  finish(2);
}

const env = cleanEnv(WORK, { BROWX_WORKSPACE: join(WORK, "ws-snapshot") });
mkdirSync(env.BROWX_WORKSPACE, { recursive: true });
const fixture = await startFixture();
const S = "fr";
const first = (t, n = 160) =>
  String(t ?? "")
    .replace(/\s+/g, " ")
    .slice(0, n);

/** One tool call, recorded as one row: ok or FAILED, time, result size on the wire, estimated tokens. */
async function call(client, label, tool, args, verify) {
  const r = await client.callTool(tool, { session: S, ...args }, 90_000);
  let why = r.isError ? `the call returned an error: ${first(r.text)}` : undefined;
  if (!why && verify) why = verify(r);
  const size = `${r.wireChars} chars (~${estTokens(r.wireChars)} tok, estimate)`;
  rec.line(
    `${label} | ${why ? "FAILED" : "ok"} | ${secs(r.ms)} | ${size}`,
    why ? first(r.text, 400) : "",
  );
  if (why) rec.diff(`${label}: ${why}`);
  return { ...r, failed: Boolean(why) };
}

try {
  // The documented default is a headed browser. With no display (DISPLAY is not passed) the page says the first session fails
  // until BROWX_HEADLESS=1 is set. Record what happens.
  const headed = startMcp({ command: "browxai", env, cwd: proj });
  try {
    await headed.initialize();
    const r = await headed.callTool(
      "open_session",
      { session: "fr-headed", mode: "incognito" },
      90_000,
    );
    if (r.isError) {
      rec.line(
        `open_session without BROWX_HEADLESS and no display | error as the page says | ${secs(r.ms)}`,
        first(r.text, 300),
      );
      if (!/BROWX_HEADLESS/.test(r.text))
        rec.note("the headed-launch error does not mention BROWX_HEADLESS");
    } else {
      rec.line(`open_session without BROWX_HEADLESS and no display | opened | ${secs(r.ms)}`);
      rec.note("a headed session opened with no DISPLAY set, the page says it fails");
    }
  } finally {
    await headed.close();
  }

  // The flow, headless.
  const client = startMcp({ command: "browxai", env: { ...env, BROWX_HEADLESS: "1" }, cwd: proj });
  try {
    const init = await client.initialize();
    headers.push(
      `server ${init.serverInfo?.name} ${init.serverInfo?.version}, initialize ${secs(init.ms)}, page ${fixture.url}`,
    );
    const t0 = Date.now();
    await call(client, "open_session (incognito)", "open_session", { mode: "incognito" });
    await call(client, "navigate", "navigate", { url: fixture.url });
    await call(client, "snapshot", "snapshot", {}, (r) =>
      /\[ref=e\d+\]/.test(r.text) && r.text.includes("Subscribe")
        ? undefined
        : "no refs, or no Subscribe button, in the tree",
    );
    headers.push(
      `open_session + navigate + snapshot: ${secs(Date.now() - t0)} (the page's "first snapshot")`,
    );
    const ask = async (query) => {
      const r = await call(client, `find "${query}"`, "find", { query }, (x) =>
        x.data?.candidates?.[0]?.ref ? undefined : "no candidate with a ref",
      );
      return r.data?.candidates?.[0]?.ref;
    };
    const emailRef = await ask("the Email field");
    if (emailRef)
      await call(client, "fill", "fill", { ref: emailRef, value: EMAIL }, (r) =>
        r.data?.element?.value === EMAIL
          ? undefined
          : `element.value is "${r.data?.element?.value}", expected "${EMAIL}"`,
      );
    const buttonRef = await ask("the Subscribe button");
    if (buttonRef) await call(client, "click", "click", { ref: buttonRef });
    await call(client, "snapshot (after click)", "snapshot", {}, (r) =>
      r.text.includes(DONE_TEXT) ? undefined : `the page does not show "${DONE_TEXT}"`,
    );
    await call(client, "close_session", "close_session", {});
  } finally {
    await client.close();
  }

  // The README quickstart: createBrowxai(), navigate, extract, close, from the installed package.
  const sdkFile = join(proj, "sdk-quickstart.mjs");
  copyFileSync(join(ROOT, "scripts/first-run/sdk-quickstart.mjs"), sdkFile);
  // Asynchronous on purpose: the fixture page is served by this process, so a blocking spawn would leave the child's navigate
  // waiting for a response this process cannot send until its timeout killed it.
  const sdk = await runAsync("node", [sdkFile, fixture.url], {
    cwd: proj,
    env: { ...env, BROWX_HEADLESS: "1", BROWX_WORKSPACE: join(WORK, "ws-sdk") },
    timeoutMs: 180_000,
  });
  const line = /^FR_SDK (.*)$/m.exec(sdk.stdout)?.[1];
  const res = line ? JSON.parse(line) : undefined;
  if (!res) {
    rec.line(
      `SDK quickstart (createBrowxai, navigate, extract) | exit ${sdk.code} | ${secs(sdk.ms)}`,
      `${first(sdk.stdout, 300)} stderr tail: ${sdk.stderr.slice(-600)}`.trim(),
    );
    rec.diff(
      `the README SDK quickstart printed no result (exit ${sdk.code}, signal ${sdk.signal ?? "none"}${sdk.timedOut ? ", timed out" : ""}): ${first(sdk.stderr.slice(-600), 600)}`,
    );
  } else {
    rec.line(
      `SDK quickstart | ${res.ok ? "ok" : "FAILED"} | create ${res.createMs} ms, navigate ${res.navigateMs} ms (${res.navigateChars} chars), extract ${res.extractMs} ms (${res.extractChars} chars)`,
      res.ok ? "" : res.error,
    );
    if (!res.ok) rec.diff(`the README SDK quickstart failed: ${res.error}`);
    else if (res.title !== PAGE_TITLE)
      rec.diff(
        `SDK extract: result.data.title is "${res.title}", the page's h1 is "${PAGE_TITLE}"${res.raw ? `. The README reads result.data.title from the resolved value. The result, first 600 characters: ${res.raw}` : ""}`,
      );
    else if (res.warnings?.length)
      rec.note(`SDK extract warnings: ${first(JSON.stringify(res.warnings))}`);
  }
} catch (e) {
  rec.diff(`stopped on a tool error: ${first(e?.message ?? e, 300)}`);
  await fixture.close();
  finish(2);
}
await fixture.close();
finish(rec.diffs.length ? 1 : 0);
