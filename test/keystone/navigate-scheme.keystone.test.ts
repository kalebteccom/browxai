// Navigation scheme keystone. `navigate` opens web, `about:blank` and `data:`
// URLs on the default capability set. A `file:` URL needs `file-io` and a path
// inside the workspace, `javascript:` needs `eval`, and any other scheme is
// refused unless the operator listed it in BROWX_NAVIGATE_EXTRA_SCHEMES. Each
// case runs against a real server and a managed headless Chromium session, and
// each refusal is checked twice: the envelope, and that the page did not move.
//
// The last block covers history: with an origin allowlist set, `go_back` runs
// the off-allowlist hook on the page it lands on. A pre-approval stands in for
// the human so nothing waits on a prompt, and its use count is the evidence
// that the hook was consulted.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";

const KEYSTONE_TIMEOUT = 120_000;
const DEFAULT_SET = "read,navigation,action,human";
const FIXTURE_TEXT = "Keystone Fixture";
const INSIDE_MARKER = "ks-nav-scheme-inside-marker";
const OUTSIDE_MARKER = "ks-nav-scheme-outside-marker";

type Booted = Awaited<ReturnType<typeof createServer>>;

interface Refusal {
  ok: boolean;
  error: string;
  requiredCapability?: string;
  scheme?: string;
  hint?: string;
}

let workspace: string;
let outsideDir: string;
let fixture: Fixture;
let otherOrigin: Fixture;
let insideUrl: string;
let outsideUrl: string;
const savedEnv: Record<string, string | undefined> = {};

const page = (marker: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>local</title></head><body><p>${marker}</p></body></html>`;

async function boot(env: Record<string, string>): Promise<Booted> {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_") && k !== "BROWX_WORKSPACE") delete process.env[k];
  }
  Object.assign(process.env, env);
  return createServer({ headless: true });
}

function callerFor(server: Booted) {
  return async <T = Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    const fn = server.handlers[name];
    if (!fn) throw new Error(`navigate-scheme keystone: no handler "${name}"`);
    const res = await fn(args);
    return JSON.parse((res.content[0] as { text: string }).text) as T;
  };
}

type Call = ReturnType<typeof callerFor>;

async function pageHas(call: Call, session: string, text: string): Promise<boolean> {
  const found = await call<{ count: number }>("text_search", {
    session,
    text,
    includeHidden: true,
  });
  return found.count >= 1;
}

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  // Real paths, so the file URLs below name the same path the workspace check resolves.
  workspace = realpathSync(mkdtempSync(join(tmpdir(), "browx-nav-scheme-")));
  outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "browx-nav-scheme-outside-")));
  process.env.BROWX_WORKSPACE = workspace;
  writeFileSync(join(workspace, "inside.html"), page(INSIDE_MARKER));
  writeFileSync(join(outsideDir, "outside.html"), page(OUTSIDE_MARKER));
  insideUrl = pathToFileURL(join(workspace, "inside.html")).href;
  outsideUrl = pathToFileURL(join(outsideDir, "outside.html")).href;
  fixture = await startFixture();
  otherOrigin = await startFixture();
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await fixture?.close().catch(() => undefined);
  await otherOrigin?.close().catch(() => undefined);
  for (const k of Object.keys(process.env)) if (k.startsWith("BROWX_")) delete process.env[k];
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (outsideDir) rmSync(outsideDir, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("navigate schemes with the default capability set", () => {
  let server: Booted;
  let call: Call;
  const session = "ks-nav-default";

  beforeAll(async () => {
    server = await boot({ BROWX_CAPABILITIES: DEFAULT_SET });
    call = callerFor(server);
    const opened = await call<{ ok: boolean }>("open_session", { session, mode: "incognito" });
    expect(opened.ok).toBe(true);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
  }, KEYSTONE_TIMEOUT);

  it(
    "loads http, about:blank and data: URLs",
    async () => {
      const web = await call<{ ok: boolean }>("navigate", { session, url: `${fixture.url}/` });
      expect(web.ok).toBe(true);
      expect(await pageHas(call, session, FIXTURE_TEXT)).toBe(true);

      const blank = await call<{ ok: boolean }>("navigate", { session, url: "about:blank" });
      expect(blank.ok).toBe(true);
      expect(await pageHas(call, session, FIXTURE_TEXT)).toBe(false);

      const data = await call<{ ok: boolean }>("navigate", {
        session,
        url: `data:text/html,<p>ks-nav-scheme-data-marker</p>`,
      });
      expect(data.ok).toBe(true);
      expect(await pageHas(call, session, "ks-nav-scheme-data-marker")).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses a file: URL, names file-io, and leaves the page where it was",
    async () => {
      await call("navigate", { session, url: `${fixture.url}/` });
      // The file is inside the workspace: without file-io the location does not matter.
      for (const url of [insideUrl, insideUrl.replace(/^file:/, "FILE:"), outsideUrl]) {
        const denied = await call<Refusal>("navigate", { session, url });
        expect(denied.ok).toBe(false);
        expect(denied.requiredCapability).toBe("file-io");
        expect(denied.hint).toMatch(/BROWX_CAPABILITIES/);
      }
      expect(await pageHas(call, session, INSIDE_MARKER)).toBe(false);
      expect(await pageHas(call, session, OUTSIDE_MARKER)).toBe(false);
      expect(await pageHas(call, session, FIXTURE_TEXT)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses javascript: and names eval",
    async () => {
      await call("navigate", { session, url: `${fixture.url}/` });
      const denied = await call<Refusal>("navigate", {
        session,
        url: "javascript:document.body.textContent='ks-nav-scheme-script-ran'",
      });
      expect(denied.ok).toBe(false);
      expect(denied.requiredCapability).toBe("eval");
      expect(await pageHas(call, session, "ks-nav-scheme-script-ran")).toBe(false);
      expect(await pageHas(call, session, FIXTURE_TEXT)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses chrome:, view-source: and a URL with no scheme, naming the scheme",
    async () => {
      await call("navigate", { session, url: `${fixture.url}/` });
      const cases: Array<[string, string]> = [
        ["chrome://version", "chrome"],
        [`view-source:${fixture.url}/`, "view-source"],
        ["127.0.0.1/no-scheme", ""],
      ];
      for (const [url, scheme] of cases) {
        const denied = await call<Refusal>("navigate", { session, url });
        expect(denied.ok).toBe(false);
        expect(denied.error).toMatch(/^navigation-scheme: /);
        expect(denied.scheme).toBe(scheme);
        expect(denied.requiredCapability).toBeUndefined();
        expect(denied.hint).toMatch(/BROWX_NAVIGATE_EXTRA_SCHEMES/);
      }
      expect(await pageHas(call, session, FIXTURE_TEXT)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses the same URLs through batch",
    async () => {
      const batched = await call<{ results: Array<{ ok: boolean; result: Refusal }> }>("batch", {
        calls: [
          { tool: "navigate", args: { session, url: insideUrl } },
          { tool: "navigate", args: { session, url: "chrome://version" } },
        ],
        stopOnError: false,
      });
      expect(batched.results.map((r) => r.ok)).toEqual([false, false]);
      expect(batched.results[0]!.result.requiredCapability).toBe("file-io");
      expect(batched.results[1]!.result.scheme).toBe("chrome");
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("navigate to file: URLs with file-io on", () => {
  let server: Booted;
  let call: Call;
  const session = "ks-nav-file-io";

  beforeAll(async () => {
    server = await boot({ BROWX_CAPABILITIES: `${DEFAULT_SET},file-io` });
    call = callerFor(server);
    const opened = await call<{ ok: boolean }>("open_session", { session, mode: "incognito" });
    expect(opened.ok).toBe(true);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
  }, KEYSTONE_TIMEOUT);

  it(
    "loads a file inside the workspace",
    async () => {
      const nav = await call<{ ok: boolean }>("navigate", { session, url: insideUrl });
      expect(nav.ok).toBe(true);
      expect(await pageHas(call, session, INSIDE_MARKER)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses a file outside the workspace and leaves the page where it was",
    async () => {
      await call("navigate", { session, url: `${fixture.url}/` });
      for (const url of [outsideUrl, "file:///etc/hosts"]) {
        const denied = await call<Refusal>("navigate", { session, url });
        expect(denied.ok).toBe(false);
        expect(denied.scheme).toBe("file");
        expect(denied.error).toMatch(/^navigation-scheme: a `file:` URL must name a readable path/);
        expect(denied.requiredCapability).toBeUndefined();
      }
      expect(await pageHas(call, session, OUTSIDE_MARKER)).toBe(false);
      expect(await pageHas(call, session, FIXTURE_TEXT)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "still refuses chrome: with file-io on",
    async () => {
      const denied = await call<Refusal>("navigate", { session, url: "chrome://version" });
      expect(denied.ok).toBe(false);
      expect(denied.scheme).toBe("chrome");
    },
    KEYSTONE_TIMEOUT,
  );
});

describe("BROWX_NAVIGATE_EXTRA_SCHEMES", () => {
  let server: Booted;
  let call: Call;
  const session = "ks-nav-extra";

  beforeAll(async () => {
    server = await boot({
      BROWX_CAPABILITIES: DEFAULT_SET,
      BROWX_NAVIGATE_EXTRA_SCHEMES: "chrome,view-source",
    });
    call = callerFor(server);
    const opened = await call<{ ok: boolean }>("open_session", { session, mode: "incognito" });
    expect(opened.ok).toBe(true);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
  }, KEYSTONE_TIMEOUT);

  it(
    "lets a listed scheme through the scheme check",
    async () => {
      // Whether this browser build renders the page is its own business; the
      // assertion is that the scheme check no longer refuses the call.
      for (const url of ["chrome://version", `view-source:${fixture.url}/`]) {
        const res = await call<{ error?: string; requiredCapability?: string }>("navigate", {
          session,
          url,
        });
        expect(res.error ?? "").not.toMatch(/^navigation-scheme: /);
        expect(res.requiredCapability).toBeUndefined();
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "still refuses an unlisted scheme, and a file: URL wrapped in a listed one",
    async () => {
      await call("navigate", { session, url: `${fixture.url}/` });
      const unlisted = await call<Refusal>("navigate", { session, url: "devtools://devtools/x" });
      expect(unlisted.scheme).toBe("devtools");
      const wrapped = await call<Refusal>("navigate", {
        session,
        url: `view-source:${insideUrl}`,
      });
      expect(wrapped.ok).toBe(false);
      expect(wrapped.requiredCapability).toBe("file-io");
      expect(await pageHas(call, session, INSIDE_MARKER)).toBe(false);
      expect(await pageHas(call, session, FIXTURE_TEXT)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "is not a config key: set_config cannot add a scheme",
    async () => {
      await call("set_config", { patch: { navigateExtraSchemes: ["devtools"] } }).catch(
        () => undefined,
      );
      const denied = await call<Refusal>("navigate", { session, url: "devtools://devtools/x" });
      expect(denied.ok).toBe(false);
      expect(denied.scheme).toBe("devtools");
    },
    KEYSTONE_TIMEOUT,
  );

  it("fails the start on a scheme a capability governs", async () => {
    process.env.BROWX_NAVIGATE_EXTRA_SCHEMES = "chrome,file";
    try {
      await expect(createServer({ headless: true })).rejects.toThrow(
        /BROWX_NAVIGATE_EXTRA_SCHEMES: "file" is turned on by the `file-io` capability/,
      );
    } finally {
      process.env.BROWX_NAVIGATE_EXTRA_SCHEMES = "chrome,view-source";
    }
  });
});

describe("go_back and go_forward under an origin allowlist", () => {
  let server: Booted;
  let call: Call;
  const session = "ks-nav-history";

  const offAllowlistUses = async (): Promise<number> => {
    const listed = await call<{ approvals: Array<{ scope: string; uses: number }> }>(
      "list_approvals",
      {},
    );
    return listed.approvals.find((a) => a.scope === "navigate_off_allowlist")?.uses ?? -1;
  };

  beforeAll(async () => {
    server = await boot({
      BROWX_CAPABILITIES: `${DEFAULT_SET},self-approval`,
      BROWX_ALLOWED_ORIGINS: fixture.url,
    });
    call = callerFor(server);
    const opened = await call<{ ok: boolean }>("open_session", { session, mode: "incognito" });
    expect(opened.ok).toBe(true);
    await call("approve_actions", { scopes: ["navigate_off_allowlist"], ttlSeconds: 600 });
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
  }, KEYSTONE_TIMEOUT);

  it(
    "runs the off-allowlist hook on the page a history move lands on",
    async () => {
      const onList = `${fixture.url}/`;
      const offList = `${otherOrigin.url}/echo`;
      expect((await call<{ ok: boolean }>("navigate", { session, url: onList })).ok).toBe(true);
      expect(await offAllowlistUses()).toBe(0);
      // The requested URL is off the allowlist: one use.
      expect((await call<{ ok: boolean }>("navigate", { session, url: offList })).ok).toBe(true);
      expect(await offAllowlistUses()).toBe(1);
      expect((await call<{ ok: boolean }>("navigate", { session, url: onList })).ok).toBe(true);
      expect(await offAllowlistUses()).toBe(1);

      // Back to the off-allowlist page: the hook runs again.
      const back = await call<{ ok: boolean; navigation: { to: string } }>("go_back", { session });
      expect(back.ok).toBe(true);
      expect(back.navigation.to).toBe(offList);
      expect(await offAllowlistUses()).toBe(2);

      // Forward to the allowlisted page: nothing to ask.
      const forward = await call<{ ok: boolean; navigation: { to: string } }>("go_forward", {
        session,
      });
      expect(forward.ok).toBe(true);
      expect(forward.navigation.to).toBe(onList);
      expect(await offAllowlistUses()).toBe(2);
    },
    KEYSTONE_TIMEOUT,
  );
});
