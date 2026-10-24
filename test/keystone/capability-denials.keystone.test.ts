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
//   file-io          the 13 tool-gated tools, plus the `screenshot({path})` branch
//   diagnostics      diagnostics_note
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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
// call must not reach (or create) one.
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
  { capability: "diagnostics", tool: "diagnostics_note", args: { insight: "keystone note" } },
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
      expect(denied.error).toMatch(/capability is not in the server's ACTIVE set/);
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
        expect(denied.error).toMatch(/ACTIVE set/);
        expect([...denied.activeCapabilities].sort()).toEqual([...DEFAULT_SET].sort());
        expect(existsSync(join(workspace, "ks-capability-denials"))).toBe(false);
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
      "starts a recording with no bodies by default",
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
