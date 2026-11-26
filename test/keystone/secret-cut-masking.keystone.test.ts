// Secret-cut keystone — text longer than a cap is masked before it is cut, on
// the page-side read paths, against a real headless Chromium.
//
// A 300-character registered value is longer than every page-text cap (120 for
// DOM-walk names, 200 for probe text, 40 for point_probe names, 4,000 for
// worker messages). The page functions read the mask slack past each cap and
// the server masks, then cuts. Before that, the page cut first and the head of
// the value reached the output, where the whole-value mask could not match it.
//
// Each check asserts both halves: no 8-character run of the value appears, and
// the `<TOKEN>` alias does where the field is expected to carry it. A page
// function that throws or returns `undefined` loses the alias and fails here.

import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";
import { engineGate, gatedDescribe } from "./keystone-gate.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;
const SESSION = "ks-secret-cut";

/** 300 characters with no repeated 8-character run, so a leaked head of any
 *  length from 8 up is found by the window check. */
const VALUE = ((): string => {
  let seed = 7;
  let out = "tok_";
  while (out.length < 300) {
    seed = (seed * 48271) % 2147483647;
    out += (seed % 36).toString(36);
  }
  return out;
})();

/** Every 8-character run of the value. */
const RUNS = Array.from({ length: VALUE.length - 7 }, (_, i) => VALUE.slice(i, i + 8));

function expectNoHead(text: string, where: string): void {
  const hit = RUNS.find((r) => text.includes(r));
  expect(hit, `${where} carries a run of the registered value`).toBeUndefined();
}

const chromeGate = engineGate("chromium");
const describeChromium = gatedDescribe(chromeGate);

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const fn = handlers[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  const res = await fn({ session: SESSION, ...args });
  return res.content.map((c) => ("text" in c ? String(c.text) : "")).join("\n");
}

describeChromium("secret-cut masking keystone", () => {
  beforeAll(async () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("BROWX_")) {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    }
    workspace = mkdtempSync(join(tmpdir(), "browx-secret-cut-keystone-"));
    process.env.BROWX_WORKSPACE = workspace;
    process.env.BROWX_CAPABILITIES = "read,navigation,action,human,secrets";
    fixture = await startFixture();
    server = await createServer({ headless: true });
    handlers = server.handlers;
    await call("open_session", { mode: "incognito" });
    await call("navigate", { url: `${fixture.url}/secret-cut-page` });
    const reg = JSON.parse(await call("register_secret", { name: "TOKEN", value: VALUE })) as {
      ok: boolean;
    };
    expect(reg.ok).toBe(true);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    delete process.env.BROWX_WORKSPACE;
    delete process.env.BROWX_CAPABILITIES;
    for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }, KEYSTONE_TIMEOUT);

  it(
    "fill, snapshot, find, point_probe and verify_value carry the alias and no head",
    async () => {
      const fill = await call("fill", { selector: "#tok", value: "<TOKEN>" });
      expectNoHead(fill, "fill ActionResult");
      expect(fill).toContain("<TOKEN>");
      expectNoHead(
        await call("fill", { selector: "#hidden-tok", value: "<TOKEN>" }),
        "fill ActionResult (hidden input)",
      );

      // The aria-hidden input is a DOM-walk-only entry named by its value.
      const snap = await call("snapshot", {});
      expectNoHead(snap, "snapshot");
      expect(snap).toContain("<TOKEN>");

      const found = await call("find", { query: "text input" });
      expectNoHead(found, "find");

      const probed = await call("point_probe", { coords: { x: 50, y: 25 } });
      expectNoHead(probed, "point_probe");
      expect(probed).toMatch(/"tag":\s*"input"/);

      const verify = await call("verify_value", { selector: "#tok", value: "wrong" });
      expectNoHead(verify, "verify_value");
      expect(verify).toContain("<TOKEN>");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a worker message with the value across the 4,000-character cut carries the alias and no head",
    async () => {
      await call("click", { selector: "#post" });
      let read = "";
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        read += await call("worker_messages_read", {});
        if (read.includes("<TOKEN>")) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expectNoHead(read, "worker_messages_read");
      expect(read).toContain("x".repeat(3990) + "<TOKEN>");
    },
    KEYSTONE_TIMEOUT,
  );
});
