// Action row-evidence keystone — `click` on a table cell and on a list item
// reports the enclosing row (`element.container`) and the owning control
// (`element.ownerControl`), against a real headless Chromium.
//
// The ancestor probe runs in the page from its source text alone. When it read
// role and tag lists from module scope it threw a ReferenceError there, the
// error was caught, and both fields were silently absent from every action
// result. Mocked unit tests call the function in Node, where the module scope
// exists, so only a real page catches that.

import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer } from "../../src/server.js";
import { startFixture, type Fixture } from "./fixture.js";
import { engineGate, gatedDescribe } from "./keystone-gate.js";

type Handlers = Awaited<ReturnType<typeof createServer>>["handlers"];

const KEYSTONE_TIMEOUT = 120_000;
const SESSION = "ks-row-evidence";

interface ClickShape {
  ok: boolean;
  error?: string;
  element?: {
    stillAttached: boolean;
    ownerControl?: {
      label?: string;
      changed: boolean;
      displayTextBefore?: string;
      displayTextAfter?: string;
    };
    container?: { kind: string; rowKey?: string; rowText?: string; changed?: boolean };
  };
}

const describeChromium = gatedDescribe(engineGate("chromium"));

let fixture: Fixture;
let server: Awaited<ReturnType<typeof createServer>>;
let handlers: Handlers;
const savedEnv: Record<string, string | undefined> = {};

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const fn = handlers[name];
  if (!fn) throw new Error(`keystone: no handler "${name}"`);
  const res = await fn({ session: SESSION, ...args });
  return JSON.parse((res.content[0] as { text: string }).text) as T;
}

describeChromium("action row-evidence keystone", () => {
  beforeAll(async () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("BROWX_") && k !== "BROWX_CHANNEL") {
        savedEnv[k] = process.env[k];
        delete process.env[k];
      }
    }
    process.env.BROWX_CAPABILITIES = "read,navigation,action";
    fixture = await startFixture();
    server = await createServer({ headless: true });
    handlers = server.handlers;
    const opened = await call<{ ok: boolean }>("open_session", { mode: "incognito" });
    expect(opened.ok).toBe(true);
    const nav = await call<{ ok: boolean }>("navigate", {
      url: `${fixture.url}/row-evidence-page`,
    });
    expect(nav.ok).toBe(true);
  }, KEYSTONE_TIMEOUT);

  afterAll(async () => {
    await server?.shutdown().catch(() => undefined);
    await fixture?.close().catch(() => undefined);
    delete process.env.BROWX_CAPABILITIES;
    for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  }, KEYSTONE_TIMEOUT);

  it(
    "a table-cell click reports its <tr> row, changed by the click",
    async () => {
      const r = await call<ClickShape>("click", { selector: "#cell-alice" });
      expect(r.ok, r.error).toBe(true);
      const c = r.element?.container;
      expect(c, JSON.stringify(r.element)).toBeDefined();
      expect(c?.kind).toBe("tr");
      expect(c?.rowKey).toMatch(/^Alice \(picked\)/);
      expect(c?.rowText).toBe("Alice (picked) Admin");
      expect(c?.changed).toBe(true);
      expect(r.element?.ownerControl).toBeUndefined();
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "a list-item click reports its <li> row and the labelled listbox that owns it",
    async () => {
      const r = await call<ClickShape>("click", { selector: "#item-apple" });
      expect(r.ok, r.error).toBe(true);
      const c = r.element?.container;
      expect(c, JSON.stringify(r.element)).toBeDefined();
      expect(c?.kind).toBe("li");
      expect(c?.rowKey).toBe("Apple ripe");
      expect(c?.rowText).toBe("Apple ripe");
      expect(c?.changed).toBe(false);
      const o = r.element?.ownerControl;
      expect(o, JSON.stringify(r.element)).toBeDefined();
      expect(o?.label).toBe("Fruit");
      expect(o?.changed).toBe(false);
      expect(o?.displayTextAfter).toContain("Apple ripe");
      expect(o?.displayTextAfter).toContain("Pear hard");
    },
    KEYSTONE_TIMEOUT,
  );
});
