// The StorageSubstrate interface — the engine-agnostic seam beneath the storage
// tools (cookies + localStorage/sessionStorage CRUD). It is the storage side of
// RFC 0003: a tool handler asks a substrate to read or write the cookie jar or
// web-storage and gets back a universal result; an engine-specific
// implementation does the work. The handler never names Playwright,
// safaridriver, or an engine — it calls `storageFor(e).cookiesList(req)` /
// `storageFor(e).webStorageGet(kind, req)`, the same shape as
// `actionsFor(e).click(args)` / `captureFor(e).screenshot(req)`.
//
// Dependency direction (architecture doctrine §1): tool handler → StorageSubstrate
// (this interface) → implementation → Playwright BrowserContext/Page | safaridriver.
// Two impls today:
//   - PlaywrightStorageSubstrate (chromium / firefox / webkit / android): wraps the
//     existing `cookiesList` / `cookiesSet` over a Playwright BrowserContext and the
//     existing `webStorage*` helpers over a Playwright Page — byte-identical to the
//     pre-seam path, so the four engines' keystones stay green unchanged. The native
//     `urls` cross-domain filter is honoured.
//   - SafariStorageSubstrate (safari): wraps the WebDriver Classic cookie endpoints
//     (`getCookies` / `addCookie`; no Playwright BrowserContext) and the WebDriver
//     `execute/sync` endpoint for web-storage (page-side JS, which safaridriver CAN
//     run — the same `return (…)` expression wrapping the ScriptSubstrate uses). For
//     cookies, safaridriver scopes the jar to the current document, so the `urls`
//     filter is inert (the WebDriver protocol has no cross-domain cookie filter) and
//     `cookies_set` derives the domain from `url` exactly as the pre-seam Safari
//     branch did. For web-storage the origin guard reads `currentUrl()` — the Classic
//     substitute for the Playwright `page.url()` the helper guards on. The gating
//     lives here, not as an `if (e.session.safari?.())` branch in the handler.

import type { BrowserContext, Page } from "playwright-core";
import type { SafariSessionHandle } from "../engine/index.js";
import type { CookieInput, StorageStateBlob, WebStorageKind } from "../session/storage.js";
import {
  cookiesList,
  cookiesSet,
  webStorageGet,
  webStorageSet,
  webStorageList,
  webStorageDelete,
  webStorageClear,
} from "../session/storage.js";

/** A cookie as returned by a `cookiesList`. The Playwright path returns the full
 *  Playwright cookie object; the Safari path returns the WebDriver cookie shape.
 *  Both carry at least `name` + `value`, which is all the handler renders. */
export type ListedCookie = StorageStateBlob["cookies"][number] | SafariListedCookie;

/** The WebDriver Classic cookie shape safaridriver returns from `GET /cookie`. */
export interface SafariListedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expiry?: number;
  sameSite?: "Lax" | "Strict" | "None";
}

/** Normalised cookie-list request — the handler's already-validated args, engine-
 *  blind. `urls` is the Playwright native cross-domain filter; it is honoured by the
 *  Playwright path and inert on Safari (WebDriver scopes the jar to the current
 *  document, the same as the pre-seam Safari branch). */
export interface CookiesListRequest {
  urls?: string[];
}

/** A single web-storage entry — the shape `*_list` renders per key. */
export interface WebStorageEntry {
  key: string;
  value: string;
}

/** The storage capability port. One instance wraps one session's engine handle;
 *  the methods carry no engine type, so the handlers above this seam are
 *  engine-blind. Mirrors the ActionSubstrate / CaptureSubstrate shape. The
 *  web-storage methods take `kind` (localStorage | sessionStorage) — the JS
 *  surface is identical, only the storage object differs — plus the handler's
 *  `tool` name, so the validation/guard error messages read the same as the
 *  pre-seam helper path on every engine. */
export interface StorageSubstrate {
  readonly engine: string;
  cookiesList(req: CookiesListRequest): Promise<ListedCookie[]>;
  cookiesSet(req: CookieInput): Promise<{ ok: boolean; name: string }>;
  webStorageGet(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ value: string | null; origin: string }>;
  webStorageList(
    kind: WebStorageKind,
    tool: string,
  ): Promise<{ entries: WebStorageEntry[]; origin: string }>;
  webStorageSet(
    kind: WebStorageKind,
    args: { key: string; value: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }>;
  webStorageDelete(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }>;
  webStorageClear(kind: WebStorageKind, tool: string): Promise<{ ok: true; origin: string }>;
}

/** Playwright engines — delegates cookie ops to the existing `cookiesList` /
 *  `cookiesSet` over the session's BrowserContext (the `context` thunk captures the
 *  session entry, the same per-call access the handlers did before this seam), and
 *  the web-storage ops to the existing `webStorage*` helpers over the session's Page
 *  (the `page` thunk, likewise). No behaviour change. */
export class PlaywrightStorageSubstrate implements StorageSubstrate {
  readonly engine: string;
  constructor(
    private readonly context: () => BrowserContext,
    private readonly page: () => Page,
    engine = "chromium",
  ) {
    this.engine = engine;
  }

  async cookiesList(req: CookiesListRequest): Promise<ListedCookie[]> {
    return cookiesList(this.context(), { urls: req.urls });
  }

  async cookiesSet(req: CookieInput): Promise<{ ok: boolean; name: string }> {
    const r = await cookiesSet(this.context(), req);
    return { ok: r.ok, name: req.name };
  }

  webStorageGet(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ value: string | null; origin: string }> {
    return webStorageGet(this.page(), kind, args, tool);
  }

  webStorageList(
    kind: WebStorageKind,
    tool: string,
  ): Promise<{ entries: WebStorageEntry[]; origin: string }> {
    return webStorageList(this.page(), kind, tool);
  }

  webStorageSet(
    kind: WebStorageKind,
    args: { key: string; value: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }> {
    return webStorageSet(this.page(), kind, args, tool);
  }

  webStorageDelete(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }> {
    return webStorageDelete(this.page(), kind, args, tool);
  }

  webStorageClear(kind: WebStorageKind, tool: string): Promise<{ ok: true; origin: string }> {
    return webStorageClear(this.page(), kind, tool);
  }
}

/** Web-storage is origin-scoped and page-bound — the page MUST be at the target
 *  origin first. On Safari the Classic substitute for `page.url()` is
 *  `currentUrl()`; this guard reframes about:blank / unreachable into the same
 *  navigation hint the Playwright helper throws, so the refusal reads identically
 *  on every engine. */
async function safariWebStorageGuard(
  handle: SafariSessionHandle,
  kind: WebStorageKind,
  tool: string,
): Promise<void> {
  let url: string;
  try {
    url = await handle.webDriver.currentUrl(handle.sessionId);
  } catch {
    url = "";
  }
  if (!url || url === "about:blank") {
    throw new Error(
      `${tool}: ${kind} is origin-scoped and the page is at "${url || "(unknown)"}". ` +
        `Navigate the session to the target origin first.`,
    );
  }
}

/** Safari — the WebDriver-Classic storage path. Cookies ride the Classic cookie
 *  endpoints; web-storage rides `execute/sync`, which runs page-context JS just like
 *  Playwright's `page.evaluate` (the ScriptSubstrate proves the seam). safaridriver
 *  returns the cookie jar for the current document; the Playwright `urls`
 *  cross-domain filter is not available over WebDriver, so it is inert here.
 *  `cookiesSet` scopes to the current document's domain — derived from `url` when
 *  given (else the explicit `domain`); the session must already be navigated to that
 *  domain. The web-storage methods run the SAME page-side IIFE the Playwright helper
 *  evaluates, wrapped in `return (…)` (an expression, not a statement body) the way
 *  `execute/sync` expects — the validation + origin guard mirror the helper so the
 *  error envelopes match. This is the pre-seam Safari behaviour, moved into the
 *  adapter so the handler stays engine-blind. RFC 0003. */
export class SafariStorageSubstrate implements StorageSubstrate {
  readonly engine = "safari";
  constructor(private readonly handle: SafariSessionHandle) {}

  async cookiesList(_req: CookiesListRequest): Promise<ListedCookie[]> {
    return this.handle.webDriver.getCookies(this.handle.sessionId);
  }

  async cookiesSet(req: CookieInput): Promise<{ ok: boolean; name: string }> {
    let derivedDomain = req.domain;
    if (!derivedDomain && req.url) {
      try {
        derivedDomain = new URL(req.url).hostname;
      } catch {
        derivedDomain = undefined;
      }
    }
    await this.handle.webDriver.addCookie(this.handle.sessionId, {
      name: req.name,
      value: req.value,
      path: req.path ?? "/",
      ...(derivedDomain ? { domain: derivedDomain } : {}),
      ...(typeof req.expires === "number" ? { expiry: Math.floor(req.expires) } : {}),
      ...(req.httpOnly !== undefined ? { httpOnly: req.httpOnly } : {}),
      ...(req.secure !== undefined ? { secure: req.secure } : {}),
      ...(req.sameSite ? { sameSite: req.sameSite } : {}),
    });
    return { ok: true, name: req.name };
  }

  async webStorageGet(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ value: string | null; origin: string }> {
    if (!args.key) throw new Error(`${tool}: \`key\` is required`);
    await safariWebStorageGuard(this.handle, kind, tool);
    const expr =
      `(() => { var s = window.${kind}; ` +
      `return { value: s.getItem(${JSON.stringify(args.key)}), origin: window.location.origin }; })()`;
    return (await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      `return (${expr});`,
    )) as { value: string | null; origin: string };
  }

  async webStorageList(
    kind: WebStorageKind,
    tool: string,
  ): Promise<{ entries: WebStorageEntry[]; origin: string }> {
    await safariWebStorageGuard(this.handle, kind, tool);
    const expr =
      `(() => { var s = window.${kind}; var out = []; ` +
      `for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k === null) continue; ` +
      `out.push({ key: k, value: s.getItem(k) || "" }); } ` +
      `return { entries: out, origin: window.location.origin }; })()`;
    return (await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      `return (${expr});`,
    )) as { entries: WebStorageEntry[]; origin: string };
  }

  async webStorageSet(
    kind: WebStorageKind,
    args: { key: string; value: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }> {
    if (!args.key) throw new Error(`${tool}: \`key\` is required`);
    if (typeof args.value !== "string") throw new Error(`${tool}: \`value\` (string) is required`);
    await safariWebStorageGuard(this.handle, kind, tool);
    const expr =
      `(() => { var s = window.${kind}; ` +
      `s.setItem(${JSON.stringify(args.key)}, ${JSON.stringify(args.value)}); ` +
      `return { ok: true, origin: window.location.origin }; })()`;
    return (await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      `return (${expr});`,
    )) as { ok: true; origin: string };
  }

  async webStorageDelete(
    kind: WebStorageKind,
    args: { key: string },
    tool: string,
  ): Promise<{ ok: true; origin: string }> {
    if (!args.key) throw new Error(`${tool}: \`key\` is required`);
    await safariWebStorageGuard(this.handle, kind, tool);
    const expr =
      `(() => { var s = window.${kind}; s.removeItem(${JSON.stringify(args.key)}); ` +
      `return { ok: true, origin: window.location.origin }; })()`;
    return (await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      `return (${expr});`,
    )) as { ok: true; origin: string };
  }

  async webStorageClear(kind: WebStorageKind, tool: string): Promise<{ ok: true; origin: string }> {
    await safariWebStorageGuard(this.handle, kind, tool);
    const expr =
      `(() => { var s = window.${kind}; s.clear(); ` +
      `return { ok: true, origin: window.location.origin }; })()`;
    return (await this.handle.webDriver.executeScript(
      this.handle.sessionId,
      `return (${expr});`,
    )) as { ok: true; origin: string };
  }
}
