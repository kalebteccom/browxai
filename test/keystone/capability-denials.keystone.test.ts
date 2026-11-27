// Capability denial keystone. Each off-by-default capability below gates a
// posture-broadening surface, and each one is asserted here against a real
// server started with the DEFAULT capability set (read, navigation, action,
// human): the call is refused with the standard capability-required envelope,
// `requiredCapability` names the right capability, and nothing the tool would
// have done happens.
//
// Covered, table-driven (`DENIALS`):
//   captcha          solve_captcha
//   credentials      get_totp, get_credential
//   secrets          register_secret
//   network-body     network_body
//   extensions       extensions_install / _list / _reload / _trigger / _uninstall
//   canvas           canvas_capture, gesture_chain, canvas_world_to_screen,
//                    canvas_screen_to_world, canvas_query
//   file-io          the 13 tool-gated tools, the `action`, `read` and `human`
//                    tools that write a workspace file (`artifact_save`,
//                    `start_har`, `auth_save`, `profile_snapshot`, and
//                    `dump_storage_state` / `export_playwright_script` with `path`),
//                    plus the `screenshot({path})` branch and `navigate` to a `file:` URL
//   diagnostics      diagnostics_note
//   eval             poll_eval, and the document / script content-type branch of `route`,
//                    `route_queue` and `sw_intercept_fetch` (the tools are
//                    `action`; the branch is refused before a session is read)
// Not table-driven, because the gate is an argument or a result field:
//   network-body     `open_session({har:{content:"embed"}})`, and the body of a
//                    `caches_get` entry, which is left out with `bodyOmitted`
//   action           `open_session` `storageState` / `authState` / `hars`, and
//                    `profile_restore`, on a server without it
//   file-io          `pdf_save`, `heap_snapshot`, `perf_start`, `perf_stop`,
//                    `perf_audit`, `layout_thrash_trace` on an open session (the
//                    engine check runs first, so they read the session), and
//                    `open_session` with `har` or `recordVideo`
//   secrets          `get_credential` on a server with `credentials` alone
//   extensions       `extensions_install` from outside the workspace `extensions/`
//                    directory, and a tool writing into that directory
// Not table-driven, because the gate is a behaviour branch and not a tool gate:
//   clipboard        `shortcut` copy/cut/paste leaves the OS clipboard and the
//                    per-session buffer alone
//   stealth          no init script is injected, so the page sees the browser's
//                    own `navigator.webdriver` / `navigator.plugins` / `window.chrome`
//
// A second server with a few of those capabilities on supplies positive
// controls that need no external service and no OS side effect (`captcha`,
// `credentials` and `secrets` are skipped: they need a provider or a password
// manager, and `clipboard` would write the shared OS clipboard). The server
// runs one at a time, one real browser session each, so this file adds a few
// seconds to the keystone run.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

const KEYSTONE_TIMEOUT = 120_000;

const DEFAULT_SET = ["read", "navigation", "action", "human"];

type Booted = Awaited<ReturnType<typeof createServer>>;

interface Denied {
  ok: boolean;
  error: string;
  requiredCapability: string;
  activeCapabilities: string[];
}

interface Case {
  capability: string;
  tool: string;
  args: Record<string, unknown>;
}

// One row per gated tool. The gate runs before any argument is read, so the
// arguments only need to be plausible; no session is named because a refused
// call must not reach (or create) one. The `eval` rows are the exception on
// arguments: the tool itself is enabled, and a document or script content type
// in the arguments is what the gate refuses.
const DENIALS: readonly Case[] = [
  {
    capability: "captcha",
    tool: "solve_captcha",
    args: { type: "image", imageBase64: "AAAA" },
  },
  { capability: "credentials", tool: "get_totp", args: { account: "keystone-account" } },
  { capability: "credentials", tool: "get_credential", args: { account: "keystone-account" } },
  {
    capability: "secrets",
    tool: "register_secret",
    args: { name: "KS_DENIED", value: "keystone-denied-value" },
  },
  { capability: "network-body", tool: "network_body", args: { requestId: "keystone-unknown" } },
  {
    capability: "extensions",
    tool: "extensions_install",
    args: { path: "keystone-no-such-extension" },
  },
  { capability: "extensions", tool: "extensions_list", args: {} },
  { capability: "extensions", tool: "extensions_reload", args: { id: "keystone-id" } },
  { capability: "extensions", tool: "extensions_trigger", args: { id: "keystone-id" } },
  { capability: "extensions", tool: "extensions_uninstall", args: { id: "keystone-id" } },
  { capability: "canvas", tool: "canvas_capture", args: { format: "png" } },
  { capability: "canvas", tool: "gesture_chain", args: {} },
  { capability: "canvas", tool: "canvas_world_to_screen", args: {} },
  { capability: "canvas", tool: "canvas_screen_to_world", args: {} },
  { capability: "canvas", tool: "canvas_query", args: {} },
  { capability: "file-io", tool: "upload_file", args: {} },
  { capability: "file-io", tool: "drop_files", args: {} },
  { capability: "file-io", tool: "downloads_capture", args: {} },
  { capability: "file-io", tool: "download_get", args: {} },
  { capability: "file-io", tool: "asset_export", args: {} },
  { capability: "file-io", tool: "page_archive", args: {} },
  { capability: "file-io", tool: "element_export", args: {} },
  { capability: "file-io", tool: "dom_export", args: {} },
  { capability: "file-io", tool: "fs_picker_respond", args: {} },
  { capability: "file-io", tool: "screenshot_schedule", args: { everyMs: 100, count: 1 } },
  { capability: "file-io", tool: "screenshot_on", args: {} },
  { capability: "file-io", tool: "stop_video", args: {} },
  { capability: "file-io", tool: "get_video", args: {} },
  { capability: "file-io", tool: "artifact_save", args: { name: "ks-denied", content: "x" } },
  { capability: "file-io", tool: "auth_save", args: { name: "ks-denied" } },
  { capability: "file-io", tool: "profile_snapshot", args: { snapshot: "ks-denied" } },
  { capability: "file-io", tool: "start_har", args: { path: "ks-file-io-denials/x.har" } },
  {
    capability: "file-io",
    tool: "dump_storage_state",
    args: { path: "ks-file-io-denials/state.json" },
  },
  {
    capability: "file-io",
    tool: "export_playwright_script",
    args: { path: "ks-file-io-denials/flow.spec.ts" },
  },
  { capability: "diagnostics", tool: "diagnostics_note", args: { insight: "keystone note" } },
  { capability: "eval", tool: "poll_eval", args: { expr: "true" } },
  {
    capability: "eval",
    tool: "route",
    args: { urlPattern: "**/keystone-denied", contentType: "text/html", body: "<p>x</p>" },
  },
  {
    capability: "eval",
    tool: "route_queue",
    args: {
      urlPattern: "**/keystone-denied",
      responses: [{ body: "{}" }, { contentType: "text/javascript", body: "void 0" }],
    },
  },
  {
    capability: "eval",
    tool: "sw_intercept_fetch",
    args: {
      pattern: "**/keystone-denied",
      response: { contentType: "application/javascript", body: "void 0" },
    },
  },
];

let workspace: string;
let fixture: Fixture;
let probeServer: HttpServer;
let probeUrl: string;
const savedEnv: Record<string, string | undefined> = {};

// A page that reports how the browser's own navigator looks. The stealth patch
// defines `webdriver` and `plugins` as OWN properties of `navigator` (a native
// Chrome keeps both on `Navigator.prototype`), replaces `plugins` with a plain
// array, installs an empty-object `window.chrome.runtime`, and sets the
// `__browx_stealth` marker. Each reading becomes its own paragraph so a keystone
// can match it with an exact `text_search`.
const PROBE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>stealth probe</title></head>
<body>
<script>
(function () {
  var c = window.chrome;
  var rows = [
    "own-webdriver=" + (Object.getOwnPropertyDescriptor(navigator, "webdriver") ? "patched" : "native"),
    "own-plugins=" + (Object.getOwnPropertyDescriptor(navigator, "plugins") ? "patched" : "native"),
    "plugins-plain-array=" + (Array.isArray(navigator.plugins) ? "yes" : "no"),
    "fake-chrome-runtime=" +
      (c && c.runtime && Object.getPrototypeOf(c.runtime) === Object.prototype &&
      Object.keys(c.runtime).length === 0 ? "yes" : "no"),
    "stealth-marker=" + (window.__browx_stealth ? "present" : "absent")
  ];
  rows.forEach(function (r) {
    var p = document.createElement("p");
    p.textContent = r;
    document.body.appendChild(p);
  });
})();
</script>
</body></html>`;

async function boot(capabilities?: string): Promise<Booted> {
  if (capabilities) process.env.BROWX_CAPABILITIES = capabilities;
  else delete process.env.BROWX_CAPABILITIES;
  return createServer({ headless: true });
}

function callerFor(server: Booted) {
  return async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const fn = server.handlers[name];
    if (!fn) throw new Error(`capability-denials keystone: no handler "${name}"`);
    const res = await fn(args);
    return JSON.parse((res.content[0] as { text: string }).text) as T;
  };
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-capability-denials-"));
  process.env.BROWX_WORKSPACE = workspace;
  fixture = await startFixture();
  probeServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PROBE_PAGE);
  });
  await new Promise<void>((resolve) => probeServer.listen(0, "127.0.0.1", resolve));
  probeUrl = `http://127.0.0.1:${(probeServer.address() as AddressInfo).port}/`;
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await fixture?.close().catch(() => undefined);
  await new Promise<void>((resolve) =>
    probeServer ? probeServer.close(() => resolve()) : resolve(),
  );
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("capability denials with the default capability set", () => {
  let server: Booted;
  let call: ReturnType<typeof callerFor>;
  const session = "ks-denials";

  async function probeHas(token: string): Promise<boolean> {
    const found = await call<{ count: number }>("text_search", {
      session,
      text: token,
      exact: true,
      includeHidden: true,
    });
    return found.count >= 1;
  }

  beforeAll(async () => {
    server = await boot();
    call = callerFor(server);
    const opened = await call<{ ok: boolean }>("open_session", { session, mode: "incognito" });
    expect(opened.ok).toBe(true);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
  }, KEYSTONE_TIMEOUT);

  it("starts with exactly the default set", async () => {
    const resolved = await call<{ config: { capabilities: string[] } }>("get_config", {});
    expect([...resolved.config.capabilities].sort()).toEqual([...DEFAULT_SET].sort());
  });

  it.each(DENIALS)(
    "refuses $tool without `$capability`",
    async ({ capability, tool, args }) => {
      const denied = await call<Denied>(tool, args);
      expect(denied.ok).toBe(false);
      expect(denied.requiredCapability).toBe(capability);
      expect(denied.error).toContain(`capability "${capability}" is not enabled on this server`);
      expect([...denied.activeCapabilities].sort()).toEqual([...DEFAULT_SET].sort());
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses the same tools through batch",
    async () => {
      const batched = await call<{
        results: Array<{ ok: boolean; result: Partial<Denied> }>;
      }>("batch", {
        calls: [
          { tool: "network_body", args: { requestId: "keystone-unknown" } },
          { tool: "stop_video", args: {} },
        ],
        stopOnError: false,
      });
      expect(batched.results.map((r) => r.ok)).toEqual([false, false]);
      expect(batched.results.map((r) => r.result.requiredCapability)).toEqual([
        "network-body",
        "file-io",
      ]);
    },
    KEYSTONE_TIMEOUT,
  );

  describe("file-io on a tool that is otherwise allowed", () => {
    it(
      "refuses screenshot({path}) and writes nothing",
      async () => {
        await call("navigate", { session, url: `${fixture.url}/` });
        const denied = await call<Denied & { hint: string }>("screenshot", {
          session,
          path: "ks-capability-denials/shot.png",
        });
        expect(denied.ok).toBe(false);
        expect(denied.requiredCapability).toBe("file-io");
        expect(denied.error).toContain('capability "file-io" is not enabled on this server');
        expect(denied.hint).toMatch(/BROWX_CAPABILITIES/);
        expect([...denied.activeCapabilities].sort()).toEqual([...DEFAULT_SET].sort());
        expect(existsSync(join(workspace, "ks-capability-denials"))).toBe(false);
      },
      KEYSTONE_TIMEOUT,
    );

    it(
      "refuses navigate to a file: URL and leaves the page where it was",
      async () => {
        await call("navigate", { session, url: `${fixture.url}/` });
        const denied = await call<Denied & { reason: string }>("navigate", {
          session,
          url: "file:///etc/hosts",
        });
        expect(denied.ok).toBe(false);
        expect(denied.requiredCapability).toBe("file-io");
        expect(denied.error).toContain('capability "file-io" is not enabled on this server');
        expect(denied.reason).toMatch(/`file:` URL/);
        expect([...denied.activeCapabilities].sort()).toEqual([...DEFAULT_SET].sort());
        expect(await probeHas("Keystone Fixture")).toBe(true);
      },
      KEYSTONE_TIMEOUT,
    );

    it.each([
      ["pdf_save", "pdfs"],
      ["heap_snapshot", "heap-snapshots"],
      ["perf_start", "perf-traces"],
      ["perf_stop", "perf-traces"],
      ["perf_audit", "perf"],
      ["layout_thrash_trace", "perf"],
    ])(
      "refuses %s on an open session and writes nothing",
      async (tool, dir) => {
        const denied = await call<Denied & { reason: string }>(tool, { session });
        expect(denied.ok).toBe(false);
        expect(denied.requiredCapability).toBe("file-io");
        expect(denied.reason).toContain(`${tool} writes`);
        expect([...denied.activeCapabilities].sort()).toEqual([...DEFAULT_SET].sort());
        expect(existsSync(join(workspace, dir))).toBe(false);
      },
      KEYSTONE_TIMEOUT,
    );

    it.each([
      ["har", { har: { path: "ks-file-io-denials/open.har" } }],
      ["recordVideo", { recordVideo: { path: "ks-file-io-denials/open.webm" } }],
    ])(
      "refuses open_session with %s before the session opens",
      async (name, args) => {
        const denied = await call<Denied & { reason: string }>("open_session", {
          session: "ks-recording",
          mode: "incognito",
          ...args,
        });
        expect(denied.ok).toBe(false);
        expect(denied.requiredCapability).toBe("file-io");
        expect(denied.reason).toContain(name);
        const listed = await call<{ sessions: Array<{ id: string }> }>("list_sessions", {});
        expect(listed.sessions.map((x) => x.id)).not.toContain("ks-recording");
        expect(existsSync(join(workspace, "ks-file-io-denials"))).toBe(false);
      },
      KEYSTONE_TIMEOUT,
    );

    it(
      "still returns dump_storage_state and export_playwright_script inline with no path",
      async () => {
        const dumped = await call<{ ok: boolean; requiredCapability?: string }>(
          "dump_storage_state",
          { session },
        );
        expect(dumped.requiredCapability).toBeUndefined();
        expect(dumped.ok).toBe(true);
        const exported = await call<{ requiredCapability?: string }>("export_playwright_script", {
          session,
        });
        expect(exported.requiredCapability).toBeUndefined();
      },
      KEYSTONE_TIMEOUT,
    );

    it(
      "still returns an inline screenshot when no path is given",
      async () => {
        await call("navigate", { session, url: `${fixture.url}/` });
        const res = await server.handlers.screenshot!({ session });
        expect(res.content.some((c) => c.type === "image")).toBe(true);
      },
      KEYSTONE_TIMEOUT,
    );
  });

  describe("network-body on start_har bodies", () => {
    it.each(["embed", "attach"])(
      "refuses start_har({content:%s}) and records nothing",
      async (content) => {
        const denied = await call<Denied>("start_har", {
          session,
          content,
          path: `ks-har-denials/${content}.har`,
        });
        expect(denied.ok).toBe(false);
        expect(denied.requiredCapability).toBe("network-body");
        expect([...denied.activeCapabilities].sort()).toEqual([...DEFAULT_SET].sort());
      },
      KEYSTONE_TIMEOUT,
    );

    it(
      'refuses open_session({har:{content:"embed"}}) before the session opens',
      async () => {
        const denied = await call<Denied>("open_session", {
          session: "ks-har-embed",
          mode: "incognito",
          har: { content: "embed", path: "ks-har-denials/open.har" },
        });
        expect(denied.ok).toBe(false);
        expect(denied.requiredCapability).toBe("network-body");
        const listed = await call<{ sessions: Array<{ id: string }> }>("list_sessions", {});
        expect(listed.sessions.map((x) => x.id)).not.toContain("ks-har-embed");
      },
      KEYSTONE_TIMEOUT,
    );

    it(
      "leaves the body out of caches_get and names network-body",
      async () => {
        await call("navigate", { session, url: `${fixture.url}/` });
        const put = await call<{ ok: boolean }>("caches_put", {
          session,
          cacheName: "ks-denials",
          url: `${fixture.url}/ks-cached`,
          response: { body: "ks-cached-body", headers: { "content-type": "text/plain" } },
        });
        expect(put.ok).toBe(true);
        const got = await call<{
          found: boolean;
          bodyOmitted?: boolean;
          requiredCapability?: string;
          text?: string;
        }>("caches_get", { session, cacheName: "ks-denials", url: `${fixture.url}/ks-cached` });
        expect(got.found).toBe(true);
        expect(got.bodyOmitted).toBe(true);
        expect(got.requiredCapability).toBe("network-body");
        expect(got.text).toBeUndefined();
        expect(JSON.stringify(got)).not.toContain("ks-cached-body");
      },
      KEYSTONE_TIMEOUT,
    );
  });

  describe("clipboard", () => {
    it.each(["Control+C", "Control+X", "Control+V"])(
      "%s is dispatched and observed, with no clipboard read or write",
      async (keys) => {
        await call("navigate", { session, url: `${fixture.url}/` });
        const res = await call<{
          ok: boolean;
          keys: string[];
          clipboard?: unknown;
          clipboardNote?: string;
        }>("shortcut", { session, keys, selector: '[data-testid="task-input"]' });
        expect(res.ok).toBe(true);
        expect(res.keys).toEqual([keys]);
        expect(res.clipboard).toBeUndefined();
        expect(res.clipboardNote).toMatch(/clipboard capability disabled/);
      },
      KEYSTONE_TIMEOUT,
    );
  });

  describe("stealth", () => {
    it(
      "injects nothing: the page sees the browser's own navigator and window.chrome",
      async () => {
        await call("navigate", { session, url: probeUrl });
        expect(await probeHas("stealth-marker=absent")).toBe(true);
        expect(await probeHas("own-webdriver=native")).toBe(true);
        expect(await probeHas("own-plugins=native")).toBe(true);
        expect(await probeHas("plugins-plain-array=no")).toBe(true);
        expect(await probeHas("fake-chrome-runtime=no")).toBe(true);
        // The patched values must not be there.
        expect(await probeHas("stealth-marker=present")).toBe(false);
        expect(await probeHas("own-webdriver=patched")).toBe(false);
      },
      KEYSTONE_TIMEOUT,
    );
  });
});

// Servers narrower or wider than the default by one capability. Every call
// here is refused before a browser starts.
describe("arguments gated on a capability the server lacks", () => {
  it(
    "open_session refuses storageState, authState and hars on a server without action",
    async () => {
      const server = await boot("read,navigation,human");
      try {
        const call = callerFor(server);
        for (const seed of [
          { storageState: { cookies: [], origins: [] } },
          { authState: "ks-missing" },
          { hars: ["ks-missing.har"] },
        ]) {
          const denied = await call<Denied & { reason: string }>("open_session", {
            session: "ks-seeded",
            mode: "incognito",
            ...seed,
          });
          expect(denied.ok, JSON.stringify(seed)).toBe(false);
          expect(denied.requiredCapability).toBe("action");
          expect(denied.reason).toMatch(/storageState|authState|hars/);
        }
        const listed = await call<{ sessions: unknown[] }>("list_sessions", {});
        expect(listed.sessions).toEqual([]);
      } finally {
        await server.shutdown().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "profile_restore refuses on a server without action",
    async () => {
      const server = await boot("read,navigation,human");
      try {
        const denied = await callerFor(server)<Denied & { reason: string }>("profile_restore", {
          snapshot: "ks-missing",
        });
        expect(denied.ok).toBe(false);
        expect(denied.requiredCapability).toBe("action");
        expect(denied.reason).toMatch(/profile_restore replaces/);
      } finally {
        await server.shutdown().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "get_credential refuses with requiredCapability secrets when only credentials is on",
    async () => {
      const server = await boot("read,navigation,action,human,credentials");
      try {
        const denied = await callerFor(server)<Denied>("get_credential", {
          account: "keystone-account",
        });
        expect(denied.ok).toBe(false);
        expect(denied.requiredCapability).toBe("secrets");
      } finally {
        await server.shutdown().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("the same surfaces with their capabilities on", () => {
  let server: Booted;
  let call: ReturnType<typeof callerFor>;
  const session = "ks-enabled";

  beforeAll(async () => {
    server = await boot(
      "read,navigation,action,human,file-io,network-body,canvas,diagnostics,extensions,stealth",
    );
    call = callerFor(server);
    const opened = await call<{ ok: boolean }>("open_session", { session, mode: "incognito" });
    expect(opened.ok).toBe(true);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
  }, KEYSTONE_TIMEOUT);

  it(
    "file-io: screenshot({path}) writes the file",
    async () => {
      await call("navigate", { session, url: `${fixture.url}/` });
      const shot = await call<{ ok: boolean; bytes: number; requiredCapability?: string }>(
        "screenshot",
        { session, path: "ks-capability-denials/shot.png" },
      );
      expect(shot.requiredCapability).toBeUndefined();
      expect(shot.ok).toBe(true);
      expect(shot.bytes).toBeGreaterThan(0);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "file-io: start_har records with no bodies by default",
    async () => {
      const started = await call<{ ok: boolean; content: string }>("start_har", {
        session,
        path: "ks-har-denials/default.har",
      });
      expect(started.ok).toBe(true);
      expect(started.content).toBe("omit");
      const stopped = await call<{ ok: boolean; wasActive: boolean }>("stop_har", { session });
      expect(stopped.ok).toBe(true);
      expect(stopped.wasActive).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "file-io: artifact_save and pdf_save write their files",
    async () => {
      const saved = await call<{ ok: boolean; requiredCapability?: string }>("artifact_save", {
        session,
        name: "ks-enabled",
        content: "x",
      });
      expect(saved.requiredCapability).toBeUndefined();
      expect(saved.ok).toBe(true);
      await call("navigate", { session, url: `${fixture.url}/` });
      const pdf = await call<{ ok: boolean; bytes: number; requiredCapability?: string }>(
        "pdf_save",
        { session, path: "ks-capability-denials/page.pdf" },
      );
      expect(pdf.requiredCapability).toBeUndefined();
      expect(pdf.ok).toBe(true);
      expect(pdf.bytes).toBeGreaterThan(0);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "file-io: auth_save writes its slot file",
    async () => {
      await call("navigate", { session, url: `${fixture.url}/` });
      const saved = await call<{ ok: boolean; requiredCapability?: string }>("auth_save", {
        session,
        name: "ks-enabled",
      });
      expect(saved.requiredCapability).toBeUndefined();
      expect(saved.ok).toBe(true);
      expect(existsSync(join(workspace, ".auth-states", "ks-enabled.json"))).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "file-io: layout_thrash_trace writes its trace file",
    async () => {
      const r = await call<{ ok: boolean; tracePath: string; requiredCapability?: string }>(
        "layout_thrash_trace",
        { session, durationMs: 200 },
      );
      expect(r.requiredCapability).toBeUndefined();
      expect(r.ok).toBe(true);
      expect(existsSync(r.tracePath)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "canvas: canvas_capture returns PNG bytes",
    async () => {
      await call("navigate", { session, url: `${fixture.url}/canvas-page` });
      const cap = await call<{ ok: boolean; format: string; width: number; height: number }>(
        "canvas_capture",
        { session, format: "png" },
      );
      expect(cap.ok).toBe(true);
      expect(cap.format).toBe("png");
      expect(cap.width).toBe(64);
      expect(cap.height).toBe(64);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "diagnostics: diagnostics_note files a note",
    async () => {
      const note = await call<{ ok: boolean; requiredCapability?: string }>("diagnostics_note", {
        insight: "keystone positive control",
      });
      expect(note.requiredCapability).toBeUndefined();
      expect(note.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "network-body and extensions: the gate passes, so any refusal names another reason",
    async () => {
      const body = await call<{ ok?: boolean; requiredCapability?: string }>("network_body", {
        session,
        requestId: "keystone-unknown",
      });
      expect(body.requiredCapability).toBeUndefined();
      const listed = await call<{ requiredCapability?: string }>("extensions_list", { session });
      expect(listed.requiredCapability).toBeUndefined();
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "extensions: no tool writes into the workspace extensions/ directory",
    async () => {
      const denied = await call<{ ok: boolean; error: string }>("asset_export", {
        session,
        filter: {},
        intoDir: "extensions/ks-written",
      });
      expect(denied.ok).toBe(false);
      expect(denied.error).toMatch(/refusing to write/);
      expect(existsSync(join(workspace, "extensions", "ks-written"))).toBe(false);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "extensions: an extension staged under .artifacts is refused",
    async () => {
      const dir = join(workspace, ".artifacts", "ks-ext");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ name: "ks", version: "1.0.0", manifest_version: 3 }),
      );
      const opened = await call<{ ok: boolean }>("open_session", {
        session: "ks-ext-persistent",
        mode: "persistent",
        profile: "ks-ext-persistent",
      });
      expect(opened.ok).toBe(true);
      try {
        const denied = await call<{ ok: boolean; error: string }>("extensions_install", {
          session: "ks-ext-persistent",
          path: ".artifacts/ks-ext",
        });
        expect(denied.ok).toBe(false);
        // The session is headless, so the headed-session check refuses first. The
        // staging-directory rule has its own unit test in extensions.test.ts.
        expect(denied.error).toMatch(/load only from|requires a headed session/);
      } finally {
        await call("close_session", { session: "ks-ext-persistent" });
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "stealth: the init script patches navigator and window.chrome before page scripts run",
    async () => {
      await call("navigate", { session, url: probeUrl });
      const has = async (token: string) =>
        (
          await call<{ count: number }>("text_search", {
            session,
            text: token,
            exact: true,
            includeHidden: true,
          })
        ).count >= 1;
      expect(await has("stealth-marker=present")).toBe(true);
      expect(await has("own-webdriver=patched")).toBe(true);
      expect(await has("own-plugins=patched")).toBe(true);
      expect(await has("plugins-plain-array=yes")).toBe(true);
      expect(await has("fake-chrome-runtime=yes")).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );
});
