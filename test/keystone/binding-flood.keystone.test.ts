// Binding-flood keystone. The `__browx_*` page bindings are callable by any
// script on the page, and each call is a CDP round trip answered by evaluating
// back into the page. A page that fires them in a tight loop used to stall its
// own session: the click's `Runtime.evaluate` and the snapshot's accessibility
// calls queued behind the flood for minutes.
//
// Real Chromium through the MCP handlers. A mocked context has no CDP queue, so
// it would pass whether or not the flood starves the session.
//
//   1. A bounded flood (about 400 calls/s for 3s across every page-reachable
//      binding) runs while a click and a snapshot go through, and both finish
//      inside their normal timeouts.
//   2. Under an `allow` permission policy, a call the budget sheds resolves to
//      `deny`, never to an approval, and the flood logs a coalesced counter
//      instead of a line per call.
//   3. A page inside the budget is untouched: a handful of permission checks all
//      get the policy's real answer, and so does a check after a flood ends.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createHttp, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";

const KEYSTONE_TIMEOUT = 120_000;
const FLOOD_MS = 3_000;
// A click or snapshot that is not starved takes well under a second; a stalled
// one takes minutes, so this separates the two with a wide margin.
const ACTION_BUDGET_MS = 20_000;

const stderrLog: string[] = [];
const realStderrWrite = process.stderr.write.bind(process.stderr);

// The BROWX_ variables found when this file loaded, and only those, so the next
// file in the shared keystone process sees the environment it would have seen
// without this one.
const originalEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith("BROWX_")),
);

function isolateEnv(prefix: string): string {
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  const ws = mkdtempSync(join(tmpdir(), prefix));
  process.env.BROWX_WORKSPACE = ws;
  return ws;
}

// `window.startFlood(ms)` fires 4 calls every 10ms (about 400/s) for a bounded
// time, rotating through every binding with a well-formed payload so each one
// takes its full handler path. Answers are tallied per binding and written to
// the page title once the flood ends.
const FLOOD_SCRIPT = `
  var tallies = { sent: 0 };
  var pending = 0;
  function tally(name, v) {
    var key = name.replace("__browx_", "") + "." + String(v).slice(0, 12);
    tallies[key] = (tallies[key] || 0) + 1;
  }
  var calls = [
    ["__browx_permission_check", function () { return JSON.stringify({ permission: "geolocation", origin: location.origin }); }],
    ["__browx_notification_check", function () { return JSON.stringify({ title: "t", origin: location.origin }); }],
    ["__browx_fs_picker_check", function () { return JSON.stringify({ api: "showSaveFilePicker", suggestedName: "a.txt" }); }],
    ["__browx_device_check", function () { return JSON.stringify({ api: "usb", filters: [] }); }],
    ["__browx_fs_picker_write", function () { return JSON.stringify({ handleId: "h-none", op: "write", data: "" }); }],
    ["__browx_permission_observe", function () { return "{}"; }],
  ];
  window.startFlood = function (ms) {
    var end = Date.now() + ms, n = 0;
    var t = setInterval(function () {
      if (Date.now() >= end) {
        clearInterval(t);
        // Calls the guard sheds never settle, so report after a short grace.
        setTimeout(function () {
          var parts = ["FLOOD-DONE", "unsettled=" + pending];
          Object.keys(tallies).forEach(function (k) { parts.push(k + "=" + tallies[k]); });
          document.title = parts.join(" ");
        }, 800);
        return;
      }
      for (var i = 0; i < 4; i++) {
        var c = calls[n++ % calls.length];
        if (typeof window[c[0]] !== "function") continue;
        tallies.sent++;
        pending++;
        (function (name, payload) {
          Promise.resolve(window[name](payload)).then(
            function (v) { pending--; tally(name, v); },
            function () { pending--; tally(name, "rejected"); });
        })(c[0], c[1]());
      }
    }, 10);
  };
`;

const PAGE_BODY = `<button data-testid="save-btn" onclick="this.textContent='Saved OK'">Save</button>
<button data-testid="ask-btn" onclick="ask(10)">Ask</button>
<button data-testid="ask-one-btn" onclick="ask(1)">Ask one</button>`;

// Common to both pages: `ask(n)` fires n permission checks and reports them.
const ASK_SCRIPT = `
  window.ask = function (n) {
    var all = [];
    for (var i = 0; i < n; i++)
      all.push(Promise.resolve(window.__browx_permission_check(JSON.stringify({ permission: "geolocation", origin: location.origin }))));
    Promise.all(all).then(function (r) { document.title = "ASKED " + r.join(","); });
  };
`;

const FLOOD_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>flood</title></head>
<body>${PAGE_BODY}<script>${FLOOD_SCRIPT}${ASK_SCRIPT}
window.addEventListener("load", function () { window.startFlood(${FLOOD_MS}); });</script></body></html>`;

const QUIET_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>quiet</title></head>
<body>${PAGE_BODY}<script>${ASK_SCRIPT}</script></body></html>`;

// A page that saves a file the way real code does: `writeLoop(n, awaitEach)`
// writes n 1 KiB chunks through `createWritable()`, either awaiting each chunk or
// firing them all and awaiting once, then closes. The outcome lands in the title.
const WRITER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>writer</title></head>
<body>
<button data-testid="w-await" onclick="writeLoop(300, true)">await 300</button>
<button data-testid="w-burst" onclick="writeLoop(900, false)">burst 900</button>
<button data-testid="w-over" onclick="writeLoop(1500, false)">burst 1500</button>
<script>
  async function writeLoop(n, awaitEach) {
    var h = await window.showSaveFilePicker({ suggestedName: "o.bin" });
    var w = await h.createWritable();
    var chunk = new Uint8Array(1024).fill(65);
    var ps = [];
    for (var i = 0; i < n; i++) {
      var p = w.write(chunk);
      if (awaitEach) await p; else ps.push(p);
    }
    ps.push(w.close());
    var outcome = await Promise.race([
      Promise.all(ps).then(function () { return "ok"; }, function (e) { return "rejected:" + e.name; }),
      new Promise(function (r) { setTimeout(function () { r("pending"); }, 3000); }),
    ]);
    document.title = "WRITE-" + outcome;
  }
</script></body></html>`;

let http: Server;
let base: string;

type Server_ = Awaited<ReturnType<typeof createServer>>;
function caller(server: Server_) {
  const text = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const fn = server.handlers[name];
    if (!fn) throw new Error(`binding-flood keystone: no handler "${name}"`);
    const res = await fn(args);
    return (res.content[0] as { text: string }).text;
  };
  const json = async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => JSON.parse(await text(name, args)) as T;
  return { json, text };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

async function pollSnapshot(
  snap: () => Promise<string>,
  marker: string,
  ms: number,
): Promise<string> {
  const end = Date.now() + ms;
  let out = "";
  while (Date.now() < end) {
    out = await snap();
    if (out.includes(marker)) return out;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`"${marker}" not seen in time; last snapshot:\n${out.slice(0, 800)}`);
}

beforeAll(async () => {
  process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
    stderrLog.push(String(chunk));
    return (realStderrWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  };
  http = createHttp((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    const url = req.url ?? "";
    res.end(
      url.startsWith("/quiet") ? QUIET_PAGE : url.startsWith("/writer") ? WRITER_PAGE : FLOOD_PAGE,
    );
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  process.stderr.write = realStderrWrite;
  await new Promise<void>((r) => http.close(() => r()));
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  Object.assign(process.env, originalEnv);
}, KEYSTONE_TIMEOUT);

describe("binding flood — managed Chromium", () => {
  let server: Server_;
  let workspace: string;

  beforeAll(async () => {
    workspace = isolateEnv("browx-binding-flood-");
    server = await createServer({ headless: true });
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it(
    "a click and a snapshot complete while a page floods every binding; shed calls deny",
    async () => {
      const { json, text } = caller(server);
      const session = "flood";
      await json("open_session", { session, mode: "incognito" });
      // `allow` makes a `deny` answer attributable to the budget, not the policy.
      await json("set_permission_policy", { session, mode: "allow" });
      // A raised picker flips ok:false on every action; deny keeps click's ok meaningful.
      await json("set_fs_picker_policy", { session, mode: "deny" });
      const logStart = stderrLog.length;

      const nav = await timed(() => json("navigate", { session, url: `${base}/flood` }));
      expect(nav.ms, "navigate under flood").toBeLessThan(ACTION_BUDGET_MS);
      // Let the flood build up before measuring.
      await new Promise((r) => setTimeout(r, 500));

      const click = await timed(() =>
        json<{ ok: boolean }>("click", { session, selector: '[data-testid="save-btn"]' }),
      );
      expect(click.value.ok, JSON.stringify(click.value)).toBe(true);
      expect(click.ms, "click under flood").toBeLessThan(ACTION_BUDGET_MS);

      const snap = await timed(() => text("snapshot", { session }));
      expect(snap.ms, "snapshot under flood").toBeLessThan(ACTION_BUDGET_MS);
      expect(snap.value).toContain("Saved OK");
      console.info(`binding-flood: navigate ${nav.ms}ms click ${click.ms}ms snapshot ${snap.ms}ms`);

      const done = await pollSnapshot(
        () => text("snapshot", { session }),
        "FLOOD-DONE",
        ACTION_BUDGET_MS,
      );
      const stats = new Map<string, number>();
      for (const m of done.matchAll(/([a-z_]+(?:\.[a-z]+)?)=(\d+)/g))
        stats.set(m[1]!, Number(m[2]));
      expect(stats.get("sent") ?? 0, "the flood actually ran").toBeGreaterThan(300);

      // Calls over the budget either deny at once or never settle.
      expect(stats.get("unsettled") ?? 0, "most of the flood is dropped silently").toBeGreaterThan(
        100,
      );
      // A `deny` here is a shed call (the policy says allow); none became an
      // approval beyond what the policy grants inside the budget.
      const allowed = stats.get("permission_check.allow") ?? 0;
      const denied = stats.get("permission_check.deny") ?? 0;
      expect(denied, "permission checks over the budget deny").toBeGreaterThan(0);
      expect(allowed, "permission checks inside the budget still allow").toBeGreaterThan(0);

      const shedLogs = stderrLog.slice(logStart).filter((l) => l.includes("binding calls shed"));
      expect(shedLogs.length, "a coalesced counter was logged").toBeGreaterThan(0);
      expect(shedLogs.length, "no per-call logging").toBeLessThan(10);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a page inside the budget gets the policy's answer, and so does one after a flood",
    async () => {
      const { json, text } = caller(server);
      const session = "quiet";
      await json("open_session", { session, mode: "incognito" });
      await json("set_permission_policy", { session, mode: "allow" });
      await json("navigate", { session, url: `${base}/quiet` });

      await json("click", { session, selector: '[data-testid="ask-btn"]' });
      const asked = await pollSnapshot(() => text("snapshot", { session }), "ASKED", 10_000);
      expect(asked).toContain("ASKED allow,allow,allow,allow,allow,allow,allow,allow,allow,allow");

      // After a flood the bucket refills; a single check is answered for real.
      await json("navigate", { session, url: `${base}/flood` });
      await pollSnapshot(() => text("snapshot", { session }), "FLOOD-DONE", ACTION_BUDGET_MS);
      await new Promise((r) => setTimeout(r, 3_000));
      await json("click", { session, selector: '[data-testid="ask-one-btn"]' });
      const after = await pollSnapshot(() => text("snapshot", { session }), "ASKED", 10_000);
      expect(after).toContain("ASKED allow");
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("binding budget — file writer loops, real Chromium", () => {
  let server: Server_;
  let workspace: string;

  beforeAll(async () => {
    workspace = isolateEnv("browx-binding-writer-");
    process.env.BROWX_CAPABILITIES = "read,navigation,action,human,file-io";
    server = await createServer({ headless: true });
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  async function save(
    testid: string,
    file: string,
  ): Promise<{ title: string; bytes: number | null }> {
    const { json, text } = caller(server);
    const session = `writer-${testid}`;
    await json("open_session", { session, mode: "incognito" });
    await json("set_fs_picker_policy", { session, mode: "allow" });
    await json("navigate", { session, url: `${base}/writer` });
    await json("fs_picker_respond", {
      session,
      api: "showSaveFilePicker",
      files: [{ path: file }],
    });
    await json("click", { session, selector: `[data-testid="${testid}"]` });
    const snap = await pollSnapshot(() => text("snapshot", { session }), "WRITE-", 15_000);
    const title = /WRITE-[^\s"]+/.exec(snap)?.[0] ?? "";
    const path = join(workspace, file);
    return { title, bytes: existsSync(path) ? statSync(path).size : null };
  }

  it(
    "a real saver, awaiting each chunk or firing 900 at once, writes the whole file",
    async () => {
      const awaited = await save("w-await", "awaited.bin");
      expect(awaited).toEqual({ title: "WRITE-ok", bytes: 300 * 1024 });
      const burst = await save("w-burst", "burst.bin");
      expect(burst).toEqual({ title: "WRITE-ok", bytes: 900 * 1024 });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a writer that fires more chunks than the burst never sees success for a truncated file",
    async () => {
      const over = await save("w-over", "over.bin");
      expect(over.title, "the page is not told the save worked").not.toBe("WRITE-ok");
      expect(over.bytes ?? 0).toBeLessThan(1500 * 1024);
      expect(
        stderrLog.some((l) => l.includes("file write dropped over the binding call budget")),
        "the truncation is logged for the handle",
      ).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );
});
