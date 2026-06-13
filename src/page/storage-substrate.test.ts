import { describe, it, expect } from "vitest";
import {
  PlaywrightStorageSubstrate,
  SafariStorageSubstrate,
  type StorageSubstrate,
} from "./storage-substrate.js";
import type { SafariSessionHandle } from "../engine/index.js";
import type { BrowserContext } from "playwright-core";

// The StorageSubstrate port routing/gating. The Playwright impl delegates to the
// existing `cookiesList` / `cookiesSet` over a BrowserContext (covered by the
// per-engine keystones); these cover the Safari adapter's WebDriver cookie path +
// the in-adapter domain derivation that replaced the per-handler
// `if (e.session.safari?.())` branches (RFC 0003).

function safariHandle(): {
  handle: SafariSessionHandle;
  added: Array<Record<string, unknown>>;
} {
  const added: Array<Record<string, unknown>> = [];
  const handle = {
    sessionId: "S",
    webDriver: {
      getCookies: async (sessionId: string) => {
        expect(sessionId).toBe("S");
        return [{ name: "sid", value: "abc", domain: "example.com" }];
      },
      addCookie: async (sessionId: string, cookie: Record<string, unknown>) => {
        expect(sessionId).toBe("S");
        added.push(cookie);
      },
    },
  } as unknown as SafariSessionHandle;
  return { handle, added };
}

describe("SafariStorageSubstrate", () => {
  it("tags the safari engine", () => {
    const { handle } = safariHandle();
    expect(new SafariStorageSubstrate(handle).engine).toBe("safari");
  });

  it("reads the cookie jar from the WebDriver client (urls filter is inert)", async () => {
    const { handle } = safariHandle();
    const sub = new SafariStorageSubstrate(handle);
    // `urls` is honoured by Playwright but not by WebDriver — the Safari adapter
    // ignores it and returns the current document's jar, as the pre-seam branch did.
    const jar = await sub.cookiesList({ urls: ["https://other.test/"] });
    expect(jar).toEqual([{ name: "sid", value: "abc", domain: "example.com" }]);
  });

  it("derives the cookie domain from `url` on set (WebDriver scopes to a domain)", async () => {
    const { handle, added } = safariHandle();
    const sub = new SafariStorageSubstrate(handle);
    const r = await sub.cookiesSet({ name: "k", value: "v", url: "https://shop.example.com/cart" });
    expect(r).toEqual({ ok: true, name: "k" });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      name: "k",
      value: "v",
      domain: "shop.example.com",
      path: "/",
    });
  });

  it("prefers an explicit `domain` over the url-derived one and maps expires→expiry", async () => {
    const { handle, added } = safariHandle();
    const sub = new SafariStorageSubstrate(handle);
    await sub.cookiesSet({
      name: "k",
      value: "v",
      url: "https://shop.example.com/",
      domain: "example.com",
      path: "/app",
      expires: 1_700_000_000.7,
      secure: true,
      sameSite: "Lax",
    });
    expect(added[0]).toMatchObject({
      domain: "example.com",
      path: "/app",
      expiry: 1_700_000_000,
      secure: true,
      sameSite: "Lax",
    });
  });

  it("omits the domain when neither `domain` nor a valid `url` is given", async () => {
    const { handle, added } = safariHandle();
    const sub: StorageSubstrate = new SafariStorageSubstrate(handle);
    await sub.cookiesSet({ name: "k", value: "v", url: "::not a url::" });
    expect(added).toHaveLength(1);
    const cookie = added[0]!;
    expect(cookie.domain).toBeUndefined();
    expect(cookie.path).toBe("/");
  });
});

describe("PlaywrightStorageSubstrate", () => {
  function ctxStub(): {
    context: () => BrowserContext;
    added: Array<Record<string, unknown>>;
    listedUrls: Array<string[] | undefined>;
  } {
    const added: Array<Record<string, unknown>> = [];
    const listedUrls: Array<string[] | undefined> = [];
    const context = (() => ({
      cookies: async (urls?: string[]) => {
        listedUrls.push(urls);
        return [{ name: "sid", value: "abc", domain: "example.com", path: "/" }];
      },
      addCookies: async (cookies: Array<Record<string, unknown>>) => {
        added.push(...cookies);
      },
    })) as unknown as () => BrowserContext;
    return { context, added, listedUrls };
  }

  it("tags the engine it was built for", () => {
    const { context } = ctxStub();
    expect(new PlaywrightStorageSubstrate(context, "firefox").engine).toBe("firefox");
  });

  it("passes the `urls` filter through to the BrowserContext (native cross-domain filter)", async () => {
    const { context, listedUrls } = ctxStub();
    const sub = new PlaywrightStorageSubstrate(context, "chromium");
    const jar = await sub.cookiesList({ urls: ["https://example.com/"] });
    expect(jar).toHaveLength(1);
    expect(listedUrls).toEqual([["https://example.com/"]]);
  });

  it("lists the whole jar (urls undefined) when no filter is given", async () => {
    const { context, listedUrls } = ctxStub();
    const sub = new PlaywrightStorageSubstrate(context, "chromium");
    await sub.cookiesList({});
    expect(listedUrls).toEqual([undefined]);
  });

  it("delegates set to addCookies and echoes back the cookie name", async () => {
    const { context, added } = ctxStub();
    const sub = new PlaywrightStorageSubstrate(context, "chromium");
    const r = await sub.cookiesSet({ name: "k", value: "v", url: "https://example.com/" });
    expect(r).toEqual({ ok: true, name: "k" });
    expect(added).toEqual([{ name: "k", value: "v", url: "https://example.com/" }]);
  });
});
