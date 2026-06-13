// The StorageSubstrate interface — the engine-agnostic seam beneath the cookie
// tools (cookies_list / cookies_set today). It is the storage side of RFC 0003: a
// tool handler asks a substrate to read or write the cookie jar and gets back a
// universal result; an engine-specific implementation does the work. The handler
// never names Playwright, safaridriver, or an engine — it calls
// `storageFor(e).cookiesList(req)`, the same shape as `actionsFor(e).click(args)` /
// `captureFor(e).screenshot(req)`.
//
// Dependency direction (architecture doctrine §1): tool handler → StorageSubstrate
// (this interface) → implementation → Playwright BrowserContext | safaridriver.
// Two impls today:
//   - PlaywrightStorageSubstrate (chromium / firefox / webkit / android): wraps the
//     existing `cookiesList` / `cookiesSet` over a Playwright BrowserContext —
//     byte-identical to the pre-seam path, so the four engines' keystones stay green
//     unchanged. The native `urls` cross-domain filter is honoured.
//   - SafariStorageSubstrate (safari): wraps the WebDriver Classic cookie endpoints
//     (`getCookies` / `addCookie`; no Playwright BrowserContext). safaridriver scopes
//     the jar to the current document, so the `urls` filter is inert (the WebDriver
//     protocol has no cross-domain cookie filter) and `cookies_set` derives the
//     domain from `url` exactly as the pre-seam Safari branch did. The gating lives
//     here, not as an `if (e.session.safari?.())` branch in the handler.

import type { BrowserContext } from "playwright-core";
import type { SafariSessionHandle } from "../engine/index.js";
import type { CookieInput, StorageStateBlob } from "../session/storage.js";
import { cookiesList, cookiesSet } from "../session/storage.js";

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

/** The storage capability port. One instance wraps one session's engine handle;
 *  the methods carry no engine type, so the handlers above this seam are
 *  engine-blind. Mirrors the ActionSubstrate / CaptureSubstrate shape. */
export interface StorageSubstrate {
  readonly engine: string;
  cookiesList(req: CookiesListRequest): Promise<ListedCookie[]>;
  cookiesSet(req: CookieInput): Promise<{ ok: boolean; name: string }>;
}

/** Playwright engines — delegates to the existing `cookiesList` / `cookiesSet` over
 *  the session's BrowserContext (the `context` thunk captures the session entry, the
 *  same per-call access the handlers did before this seam). No behaviour change. */
export class PlaywrightStorageSubstrate implements StorageSubstrate {
  readonly engine: string;
  constructor(
    private readonly context: () => BrowserContext,
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
}

/** Safari — the WebDriver-Classic cookie path. safaridriver returns the cookie jar
 *  for the current document; the Playwright `urls` cross-domain filter is not
 *  available over WebDriver, so it is inert here. `cookiesSet` scopes to the current
 *  document's domain — derived from `url` when given (else the explicit `domain`);
 *  the session must already be navigated to that domain. This is the pre-seam Safari
 *  branch, moved into the adapter so the handler stays engine-blind. RFC 0003. */
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
}
