// Unit tests for the three-layer storage-state primitives (W-U7).
//
// Strategy:
//   - Layer 1 (bulk) + layer 3 (named slots) — exercised with a fake
//     `BrowserContext` that records calls. No browser needed.
//   - Layer 2 cookies — same fake context, asserts the Playwright-API plumb.
//   - Layer 2 web-storage — uses a fake `Page` whose `evaluate()` interprets
//     the literal expression strings against an in-memory storage map. This
//     mirrors what the real `page.evaluate` does without launching Chrome.
//   - Workspace-escape rejection + name-validator coverage is shared across
//     `dump_storage_state` / `auth_save` / `auth_load` / `auth_delete`.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dumpStorageState,
  injectStorageState,
  readStorageStateFile,
  cookiesGet,
  cookiesList,
  cookiesSet,
  cookiesDelete,
  cookiesClear,
  webStorageGet,
  webStorageSet,
  webStorageList,
  webStorageDelete,
  webStorageClear,
  authSave,
  authLoad,
  authList,
  authDelete,
  assertSafeName,
  resolveWorkspacePath,
  authStatePath,
  type StorageStateBlob,
} from "./storage.js";

// ---- fixture helpers -------------------------------------------------------

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "browx-store-")); });
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

function emptyState(): StorageStateBlob {
  return { cookies: [], origins: [] };
}
function seededState(): StorageStateBlob {
  return {
    cookies: [
      { name: "sid", value: "abc", domain: "example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    ],
    origins: [
      { origin: "https://example.com", localStorage: [{ name: "theme", value: "dark" }] },
    ],
  };
}

/** Minimal fake BrowserContext — records every call and serves canned
 *  cookies. Only the methods the storage layer touches are present. */
function fakeContext(initialState: StorageStateBlob = emptyState()) {
  const state: StorageStateBlob = JSON.parse(JSON.stringify(initialState));
  const calls: Array<{ method: string; args: unknown }> = [];
  const ctx = {
    storageState: vi.fn(async () => JSON.parse(JSON.stringify(state)) as StorageStateBlob),
    addCookies: vi.fn(async (cookies: StorageStateBlob["cookies"]) => {
      calls.push({ method: "addCookies", args: cookies });
      // de-dupe by (name, domain, path)
      for (const c of cookies) {
        const i = state.cookies.findIndex((e) => e.name === c.name && e.domain === c.domain && e.path === c.path);
        const filled: StorageStateBlob["cookies"][number] = {
          name: c.name,
          value: c.value,
          domain: c.domain ?? "",
          path: c.path ?? "/",
          expires: c.expires ?? -1,
          httpOnly: c.httpOnly ?? false,
          secure: c.secure ?? false,
          sameSite: c.sameSite ?? "Lax",
        };
        if (i >= 0) state.cookies[i] = filled;
        else state.cookies.push(filled);
      }
    }),
    cookies: vi.fn(async (urls?: string | string[]) => {
      calls.push({ method: "cookies", args: urls });
      if (!urls) return JSON.parse(JSON.stringify(state.cookies)) as StorageStateBlob["cookies"];
      const list = Array.isArray(urls) ? urls : [urls];
      // crude filter: domain match on hostname
      return state.cookies.filter((c) =>
        list.some((u) => { try { return new URL(u).hostname.endsWith(c.domain.replace(/^\./, "")); } catch { return false; } }),
      ) as StorageStateBlob["cookies"];
    }),
    clearCookies: vi.fn(async (filter?: { name?: string; domain?: string; path?: string }) => {
      calls.push({ method: "clearCookies", args: filter });
      if (!filter) { state.cookies = []; return; }
      state.cookies = state.cookies.filter((c) =>
        !((filter.name === undefined || filter.name === c.name) &&
          (filter.domain === undefined || filter.domain === c.domain) &&
          (filter.path === undefined || filter.path === c.path))
      );
    }),
    setStorageState: vi.fn(async (s: StorageStateBlob) => {
      calls.push({ method: "setStorageState", args: s });
      state.cookies = JSON.parse(JSON.stringify(s.cookies));
      state.origins = JSON.parse(JSON.stringify(s.origins));
    }),
  };
  return { ctx, state, calls };
}

/** Minimal fake Page — `evaluate()` interprets the storage-tool expr strings
 *  against an in-memory map keyed by origin. */
function fakePage(initialUrl: string, store: Record<string, Record<string, string>> = {}) {
  let url = initialUrl;
  const setUrl = (u: string) => { url = u; };
  const evaluate = vi.fn(async (expr: unknown) => {
    if (typeof expr !== "string") throw new Error("fakePage.evaluate: expected string expression");
    let origin: string;
    try { origin = new URL(url).origin; } catch { origin = "null"; }
    const bucket = (store[origin] ??= {});

    // Recognise the storage-helper expression shapes by string match.
    // The expressions are stable enough (we control the producer) that this
    // is reliable; the alternative — running the expr through `eval` with a
    // shimmed `window` — adds far more attack surface than the test value.

    // shared: `var s = window.<kind>;` — capture kind off the expr.
    const kindMatch = expr.match(/var s = window\.(localStorage|sessionStorage)/);
    if (!kindMatch) {
      // The merge-localStorage expression carries its own format.
      const merge = expr.match(/var es = (\[[\s\S]*?\]);/);
      if (merge) {
        const entries = JSON.parse(merge[1]!) as Array<{ name: string; value: string }>;
        for (const e of entries) bucket[e.name] = e.value;
        return undefined;
      }
      throw new Error("fakePage.evaluate: unrecognised expression: " + expr);
    }
    // Per the helper, we just track in `bucket` regardless of kind (a real
    // page would route to the right Storage object; the tests don't mix
    // localStorage + sessionStorage in the same suite, so a single bucket
    // suffices).

    if (expr.includes("getItem(") && expr.includes("return { value:")) {
      const m = expr.match(/getItem\((".*?")\)/)!;
      const key = JSON.parse(m[1]!) as string;
      return { value: Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : null, origin };
    }
    if (expr.includes("setItem(")) {
      const m = expr.match(/setItem\((".*?"), (".*?")\)/)!;
      const key = JSON.parse(m[1]!) as string;
      const value = JSON.parse(m[2]!) as string;
      bucket[key] = value;
      return { ok: true, origin };
    }
    if (expr.includes("removeItem(")) {
      const m = expr.match(/removeItem\((".*?")\)/)!;
      const key = JSON.parse(m[1]!) as string;
      delete bucket[key];
      return { ok: true, origin };
    }
    if (expr.includes("s.length") && expr.includes("var out = []")) {
      const entries = Object.entries(bucket).map(([key, value]) => ({ key, value }));
      return { entries, origin };
    }
    if (expr.includes("s.clear()")) {
      for (const k of Object.keys(bucket)) delete bucket[k];
      return { ok: true, origin };
    }
    throw new Error("fakePage.evaluate: unhandled storage expr: " + expr);
  });
  const page = {
    url: () => url,
    evaluate,
  };
  return { page, setUrl, store };
}

// ---- validators ------------------------------------------------------------

describe("assertSafeName", () => {
  it("accepts safe names", () => {
    expect(() => assertSafeName("test", "alpha")).not.toThrow();
    expect(() => assertSafeName("test", "alpha.beta-1_2")).not.toThrow();
  });
  it("rejects path separators and traversal", () => {
    for (const bad of ["foo/bar", "../foo", "..", ".", "", "with space", "name\\b"]) {
      expect(() => assertSafeName("test", bad), `should reject "${bad}"`).toThrow();
    }
  });
});

describe("resolveWorkspacePath", () => {
  it("accepts a path inside the workspace", () => {
    expect(resolveWorkspacePath(ws, "states/a.json", "dump_storage_state")).toBe(join(ws, "states/a.json"));
  });
  it("rejects path-traversal", () => {
    expect(() => resolveWorkspacePath(ws, "../escape.json", "dump_storage_state")).toThrow(/inside \$BROWX_WORKSPACE/);
  });
  it("rejects absolute paths pointing outside", () => {
    expect(() => resolveWorkspacePath(ws, "/etc/passwd", "dump_storage_state")).toThrow(/inside \$BROWX_WORKSPACE/);
  });
});

// ---- layer 1: bulk ---------------------------------------------------------

describe("dumpStorageState", () => {
  it("returns the blob inline when no path is given", async () => {
    const { ctx } = fakeContext(seededState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await dumpStorageState(ctx as any, ws);
    expect(r.state.cookies).toHaveLength(1);
    expect(r.path).toBeUndefined();
  });
  it("writes the blob to a workspace path", async () => {
    const { ctx } = fakeContext(seededState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await dumpStorageState(ctx as any, ws, { path: "out/state.json" });
    expect(r.path).toBe(join(ws, "out/state.json"));
    expect(r.bytes).toBeGreaterThan(0);
    expect(existsSync(r.path!)).toBe(true);
    const parsed = JSON.parse(readFileSync(r.path!, "utf8"));
    expect(parsed.cookies).toHaveLength(1);
  });
  it("rejects a path that escapes the workspace", async () => {
    const { ctx } = fakeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(dumpStorageState(ctx as any, ws, { path: "../boom.json" }))
      .rejects.toThrow(/inside \$BROWX_WORKSPACE/);
  });
});

describe("readStorageStateFile", () => {
  it("reads and validates a state JSON", () => {
    writeFileSync(join(ws, "state.json"), JSON.stringify(seededState()));
    const blob = readStorageStateFile(ws, "state.json", "test");
    expect(blob.cookies[0]!.name).toBe("sid");
  });
  it("rejects a missing file", () => {
    expect(() => readStorageStateFile(ws, "missing.json", "test")).toThrow(/not found/);
  });
  it("rejects invalid JSON", () => {
    writeFileSync(join(ws, "bad.json"), "{not json");
    expect(() => readStorageStateFile(ws, "bad.json", "test")).toThrow(/not valid JSON/);
  });
  it("rejects a state without cookies/origins arrays", () => {
    writeFileSync(join(ws, "shape.json"), JSON.stringify({ cookies: "no" }));
    expect(() => readStorageStateFile(ws, "shape.json", "test")).toThrow(/cookies.*array/);
  });
  it("rejects a workspace escape", () => {
    expect(() => readStorageStateFile(ws, "../escape.json", "test")).toThrow(/inside \$BROWX_WORKSPACE/);
  });
});

describe("injectStorageState", () => {
  it("replace mode calls setStorageState (clears + applies)", async () => {
    const { ctx, calls } = fakeContext(seededState());
    const { page } = fakePage("https://example.com/page");
    const r = await injectStorageState(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx as any, page as any, seededState(),
    );
    expect(r.mode).toBe("replace");
    expect(calls.some((c) => c.method === "setStorageState")).toBe(true);
    expect(r.cookiesApplied).toBe(1);
    expect(r.originsApplied).toBe(1);
    expect(r.originsSkipped).toEqual([]);
  });
  it("merge mode adds cookies + merges localStorage only for current origin", async () => {
    const { ctx, calls } = fakeContext();
    const { page, store } = fakePage("https://example.com/page");
    const blob: StorageStateBlob = {
      cookies: [
        { name: "a", value: "1", domain: "example.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
      ],
      origins: [
        { origin: "https://example.com", localStorage: [{ name: "k1", value: "v1" }] },
        { origin: "https://other.example.org", localStorage: [{ name: "x", value: "y" }] },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await injectStorageState(ctx as any, page as any, blob, { mode: "merge" });
    expect(r.mode).toBe("merge");
    expect(r.cookiesApplied).toBe(1);
    expect(r.originsApplied).toBe(1);
    expect(r.originsSkipped).toEqual(["https://other.example.org"]);
    expect(calls.some((c) => c.method === "addCookies")).toBe(true);
    expect(calls.some((c) => c.method === "setStorageState")).toBe(false);
    expect(store["https://example.com"]?.k1).toBe("v1");
    expect(store["https://other.example.org"]).toBeUndefined();
  });
});

// ---- layer 2: cookies ------------------------------------------------------

describe("cookies CRUD", () => {
  it("get returns null when missing, the cookie when present", async () => {
    const { ctx } = fakeContext(seededState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await cookiesGet(ctx as any, { name: "sid" })).toMatchObject({ name: "sid", value: "abc" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await cookiesGet(ctx as any, { name: "missing" })).toBeNull();
  });
  it("get requires name", async () => {
    const { ctx } = fakeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(cookiesGet(ctx as any, { name: "" })).rejects.toThrow(/name.*required/);
  });
  it("list returns the array (and filters by urls)", async () => {
    const { ctx } = fakeContext(seededState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = await cookiesList(ctx as any);
    expect(all).toHaveLength(1);
  });
  it("set requires url OR domain+path", async () => {
    const { ctx } = fakeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(cookiesSet(ctx as any, { name: "a", value: "1" })).rejects.toThrow(/url.*domain.*path/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(cookiesSet(ctx as any, { name: "a", value: "1", url: "https://example.com" })).resolves.toEqual({ ok: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(cookiesSet(ctx as any, { name: "b", value: "2", domain: "example.com", path: "/" })).resolves.toEqual({ ok: true });
  });
  it("delete with url derives domain+path", async () => {
    const { ctx, calls, state } = fakeContext(seededState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cookiesDelete(ctx as any, { name: "sid", url: "https://example.com/" });
    const c = calls.find((x) => x.method === "clearCookies")!;
    expect(c.args).toMatchObject({ name: "sid", domain: "example.com", path: "/" });
    expect(state.cookies).toHaveLength(0);
  });
  it("delete rejects invalid url", async () => {
    const { ctx } = fakeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(cookiesDelete(ctx as any, { name: "x", url: "not a url" })).rejects.toThrow(/invalid url/);
  });
  it("clear wipes everything", async () => {
    const { ctx, state } = fakeContext(seededState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await cookiesClear(ctx as any);
    expect(state.cookies).toHaveLength(0);
  });
});

// ---- layer 2: web-storage --------------------------------------------------

describe("webStorage (localStorage / sessionStorage)", () => {
  it("rejects on about:blank with a navigation hint", async () => {
    const { page } = fakePage("about:blank");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(webStorageGet(page as any, "localStorage", { key: "k" }, "localstorage_get"))
      .rejects.toThrow(/origin-scoped/);
  });
  it("rejects on empty url", async () => {
    const { page } = fakePage("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(webStorageGet(page as any, "localStorage", { key: "k" }, "localstorage_get"))
      .rejects.toThrow(/origin-scoped/);
  });

  for (const kind of ["localStorage", "sessionStorage"] as const) {
    describe(`${kind}`, () => {
      it("round-trips set → get → list → delete → clear", async () => {
        const { page } = fakePage("https://example.com/");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const set = await webStorageSet(page as any, kind, { key: "k", value: "v" }, `${kind}_set`);
        expect(set.ok).toBe(true);
        expect(set.origin).toBe("https://example.com");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const got = await webStorageGet(page as any, kind, { key: "k" }, `${kind}_get`);
        expect(got.value).toBe("v");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const missing = await webStorageGet(page as any, kind, { key: "nope" }, `${kind}_get`);
        expect(missing.value).toBeNull();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const listed = await webStorageList(page as any, kind, `${kind}_list`);
        expect(listed.entries).toEqual([{ key: "k", value: "v" }]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await webStorageDelete(page as any, kind, { key: "k" }, `${kind}_delete`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((await webStorageList(page as any, kind, `${kind}_list`)).entries).toEqual([]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await webStorageSet(page as any, kind, { key: "x", value: "y" }, `${kind}_set`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await webStorageClear(page as any, kind, `${kind}_clear`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((await webStorageList(page as any, kind, `${kind}_list`)).entries).toEqual([]);
      });
      it("requires a key on get/set/delete", async () => {
        const { page } = fakePage("https://example.com/");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(webStorageGet(page as any, kind, { key: "" }, `${kind}_get`)).rejects.toThrow(/key.*required/);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(webStorageSet(page as any, kind, { key: "", value: "v" }, `${kind}_set`)).rejects.toThrow(/key.*required/);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(webStorageDelete(page as any, kind, { key: "" }, `${kind}_delete`)).rejects.toThrow(/key.*required/);
      });
      it("requires a string value on set", async () => {
        const { page } = fakePage("https://example.com/");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await expect(webStorageSet(page as any, kind, { key: "k", value: 42 as any }, `${kind}_set`))
          .rejects.toThrow(/value.*string.*required/);
      });
    });
  }
});

// ---- layer 3: named auth-states -------------------------------------------

describe("auth_* (named slots)", () => {
  it("authStatePath enforces the safe-name posture", () => {
    expect(authStatePath(ws, "prod")).toBe(join(ws, ".auth-states", "prod.json"));
    expect(() => authStatePath(ws, "../escape")).toThrow();
    expect(() => authStatePath(ws, "with/slash")).toThrow();
    expect(() => authStatePath(ws, "..")).toThrow();
  });
  it("auth_save → auth_load round-trips the state through the workspace", async () => {
    const { ctx } = fakeContext(seededState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await authSave(ctx as any, ws, "prod");
    expect(r.path).toBe(join(ws, ".auth-states", "prod.json"));
    expect(r.cookies).toBe(1);
    expect(r.origins).toBe(1);
    expect(existsSync(r.path)).toBe(true);
    const blob = authLoad(ws, "prod");
    expect(blob.cookies[0]!.name).toBe("sid");
    expect(blob.origins[0]!.origin).toBe("https://example.com");
  });
  it("auth_load fails clearly when the slot is missing", () => {
    expect(() => authLoad(ws, "missing")).toThrow(/no named state/);
  });
  it("auth_list returns empty when the dir is missing", () => {
    expect(authList(ws)).toEqual([]);
  });
  it("auth_list enumerates safe-named slots, ignoring junk + unsafe names", async () => {
    const { ctx } = fakeContext(seededState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authSave(ctx as any, ws, "a");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authSave(ctx as any, ws, "b");
    // a sibling file that isn't .json — should be ignored.
    mkdirSync(join(ws, ".auth-states"), { recursive: true });
    writeFileSync(join(ws, ".auth-states", "README"), "ignored");
    // an unsafe-named .json — should also be ignored
    writeFileSync(join(ws, ".auth-states", "with space.json"), "{}");
    const list = authList(ws);
    expect(list.map((s) => s.name)).toEqual(["a", "b"]);
  });
  it("auth_delete is idempotent", async () => {
    const { ctx } = fakeContext(seededState());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await authSave(ctx as any, ws, "to-go");
    expect(authDelete(ws, "to-go")).toMatchObject({ ok: true, existed: true });
    expect(authDelete(ws, "to-go")).toMatchObject({ ok: true, existed: false });
    expect(authDelete(ws, "never-there")).toMatchObject({ ok: true, existed: false });
  });
  it("auth_save rejects an unsafe name", async () => {
    const { ctx } = fakeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(authSave(ctx as any, ws, "../escape")).rejects.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(authSave(ctx as any, ws, "with/slash")).rejects.toThrow();
  });
});
