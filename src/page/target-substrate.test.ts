import { describe, it, expect } from "vitest";
import type { Page } from "playwright-core";
import {
  PlaywrightTargetSubstrate,
  SafariTargetSubstrate,
  type TargetSubstrate,
} from "./target-substrate.js";
import { safariSubstrateBundle } from "./substrate-bundle-safari.js";
import type { SafariSessionHandle } from "../engine/index.js";
import type { SubstrateDeps } from "../engine/registry.js";
import type { SessionEntry } from "../session/registry.js";

// The TargetSubstrate port (RFC 0009 P1) — the structural identity of whatever a
// session is pointed at, and the seam that took `e.session.page().url()` out of
// the tool handlers.
//
// Three things are worth pinning here, and the third is the point of the port:
// the Playwright adapter is the verbatim body of the calls it replaced; the
// Safari adapter answers the SAME two questions with no Playwright Page anywhere;
// and a session whose engine declares no `page` sub-interface reaches the port
// through its engine's own substrate bundle, never through `page()`.

/** The Safari-native handle, faked down to the two WebDriver endpoints the
 *  adapter drives. `page` is deliberately absent from every session object in
 *  this file — touching it would be the bypass the port exists to remove. */
function safariHandle(opts: { url?: string; title?: unknown; urlFails?: boolean } = {}): {
  handle: SafariSessionHandle;
  calls: string[];
} {
  const calls: string[] = [];
  const handle = {
    sessionId: "SID-7",
    webDriver: {
      currentUrl: (sessionId: string) => {
        calls.push(`currentUrl:${sessionId}`);
        return opts.urlFails
          ? Promise.reject(new Error("webdriver: session gone"))
          : Promise.resolve(opts.url ?? "https://example.test/checkout");
      },
      executeScript: (sessionId: string, script: string) => {
        calls.push(`exec:${sessionId}:${script}`);
        return Promise.resolve("title" in opts ? opts.title : "Checkout");
      },
    },
  } as unknown as SafariSessionHandle;
  return { handle, calls };
}

describe("TargetSubstrate — the port contract", () => {
  const cases: Array<[string, () => TargetSubstrate]> = [
    [
      "playwright",
      () =>
        new PlaywrightTargetSubstrate(
          () =>
            ({
              url: () => "https://example.test/checkout",
              title: () => Promise.resolve("Checkout"),
            }) as unknown as Page,
          "firefox",
        ),
    ],
    ["safari", () => new SafariTargetSubstrate(safariHandle().handle)],
  ];

  it.each(cases)("[%s] carries an engine tag", (_name, make) => {
    expect(typeof make().engine).toBe("string");
    expect(make().engine.length).toBeGreaterThan(0);
  });

  it.each(cases)("[%s] answers url() and title() as promises of strings", async (_name, make) => {
    const sub = make();
    await expect(sub.url()).resolves.toBe("https://example.test/checkout");
    await expect(sub.title()).resolves.toBe("Checkout");
  });

  it.each(cases)("[%s] exposes exactly the two port methods", (_name, make) => {
    const sub = make();
    // The port is `engine` + two reads, and both adapters answer the same two.
    // An adapter that grew an escape hatch — a `page()`, a `handle()`, a
    // `currentUrlSync()` a caller could come to depend on — shows up here as a
    // third method. Injected collaborators are constructor state, not surface,
    // so only the prototype is inspected.
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(sub) as object).filter(
      (k) => k !== "constructor",
    );
    expect(methods.sort()).toEqual(["title", "url"]);
    expect(Object.getOwnPropertyNames(sub)).toContain("engine");
  });
});

describe("PlaywrightTargetSubstrate", () => {
  it("tags the supplied engine (default chromium)", () => {
    const page = (() => ({})) as unknown as () => Page;
    expect(new PlaywrightTargetSubstrate(page).engine).toBe("chromium");
    expect(new PlaywrightTargetSubstrate(page, "webkit").engine).toBe("webkit");
  });

  it("reads the Page per call, so a re-targeted session is not stale", async () => {
    const urls = ["https://a.test/", "https://b.test/"];
    let i = 0;
    const sub = new PlaywrightTargetSubstrate(
      () => ({ url: () => urls[i++], title: () => Promise.resolve("t") }) as unknown as Page,
    );
    await expect(sub.url()).resolves.toBe("https://a.test/");
    await expect(sub.url()).resolves.toBe("https://b.test/");
  });

  it("delegates title() to page.title() verbatim", async () => {
    let called = 0;
    const sub = new PlaywrightTargetSubstrate(
      () =>
        ({
          url: () => "about:blank",
          title: () => {
            called += 1;
            return Promise.resolve("Docs");
          },
        }) as unknown as Page,
    );
    await expect(sub.title()).resolves.toBe("Docs");
    expect(called).toBe(1);
  });
});

describe("SafariTargetSubstrate", () => {
  it("tags the safari engine", () => {
    expect(new SafariTargetSubstrate(safariHandle().handle).engine).toBe("safari");
  });

  it("reads the URL over WebDriver Classic, threading the session id", async () => {
    const { handle, calls } = safariHandle({ url: "https://shop.test/cart" });
    await expect(new SafariTargetSubstrate(handle).url()).resolves.toBe("https://shop.test/cart");
    expect(calls).toEqual(["currentUrl:SID-7"]);
  });

  it("reads the title through execute/sync as a `return document.title` body", async () => {
    const { handle, calls } = safariHandle({ title: "Cart" });
    await expect(new SafariTargetSubstrate(handle).title()).resolves.toBe("Cart");
    expect(calls).toEqual(["exec:SID-7:return document.title"]);
  });

  it("coerces a non-string execute/sync result to the empty title", async () => {
    // `execute/sync` returns whatever the page evaluated to; a document with no
    // title, or a driver that answers null, must not surface as `null` in a
    // snapshot header typed `string`.
    const { handle } = safariHandle({ title: null });
    await expect(new SafariTargetSubstrate(handle).title()).resolves.toBe("");
  });

  it("propagates a WebDriver failure rather than inventing a URL", async () => {
    // The caller decides what an unreadable target means (the snapshot header
    // degrades to ""; `list_sessions` reports null). The port must not pick for
    // them by swallowing the error into a plausible-looking string.
    const { handle } = safariHandle({ urlFails: true });
    await expect(new SafariTargetSubstrate(handle).url()).rejects.toThrow(
      "webdriver: session gone",
    );
  });
});

describe("a session declaring no `page` sub-interface", () => {
  it("reaches the target port through its engine bundle, never through page()", async () => {
    const { handle, calls } = safariHandle();
    // The safari session shape: a native handle, and NO `page` member at all —
    // the state RFC 0009 P5 leaves every engine in. If anything on this path
    // reached for a Page it would be a TypeError, not a silent fallback.
    const entry = {
      session: { engine: "safari", safari: () => handle },
    } as unknown as SessionEntry;
    expect("page" in (entry.session as object)).toBe(false);

    const target = safariSubstrateBundle({} as unknown as SubstrateDeps).target(entry);
    expect(target.engine).toBe("safari");
    await expect(target.url()).resolves.toBe("https://example.test/checkout");
    await expect(target.title()).resolves.toBe("Checkout");
    expect(calls).toEqual(["currentUrl:SID-7", "exec:SID-7:return document.title"]);
  });
});
