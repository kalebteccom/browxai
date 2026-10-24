// solve_captcha — the refusal is structured, and it lands before the money.
//
// Two separable questions live at the site-key read, and they resolve
// differently.
//
// REFUSAL SHAPE. `requirePage` throws on an engine that backs no Playwright Page
// (and on an attached session whose tab is gone). The selector-derived site-key
// read needs one, and the call sat outside the handler's try — so the agent got a
// raw `engine "safari" backs no Playwright Page…` rejection instead of the
// `{ok:false, provider, error, hint}` envelope every other solve_captcha failure
// returns. It now refuses structurally, and it refuses BEFORE `submitToProvider`,
// so no provider credit is spent on a solve the caller cannot complete.
//
// CREDIT SPEND with an explicit `siteKey`. solve_captcha does not inject the
// token on ANY engine — it returns it, and docs/tool-reference.md states the
// agent wires it back into the page. Safari can do that: `eval_js` routes to
// SafariScriptSubstrate over WebDriver `execute/sync`, and `fill` routes to
// SafariActionSubstrate. So a Safari session that supplies its own site-key has
// a complete path to a usable token, and the solve proceeds. The pre-port refusal
// on that path was not a spend policy — it was `session.page()` throwing, with a
// "Call open_session + navigate first" hint that was unactionable on an engine
// where open_session and navigate both succeed.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { registerSecretsCaptchaTools } from "./secrets-captcha-tools.js";
import { SafariTargetSubstrate } from "../page/target-substrate.js";
import type { SafariSessionHandle } from "../engine/index.js";
import type { ToolHost, ToolResponse } from "./host.js";
import { SecretRegistry } from "../util/secrets.js";
import { makeFakeProvider, type CredentialResult } from "../util/credentials.js";
import type { ProviderName } from "../util/credentials-contract.js";

type CapturedHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

const PAGE_URL = "https://shop.test/checkout";

/** A Safari session: the WebDriver handle answers the URL, and there is no
 *  `page` member at all — the shape `requirePage` refuses on. */
function safariSession(): { engine: string } {
  return { engine: "safari" };
}

function safariTarget(): SafariTargetSubstrate {
  const handle = {
    sessionId: "SID-9",
    webDriver: { currentUrl: () => Promise.resolve(PAGE_URL) },
  } as unknown as SafariSessionHandle;
  return new SafariTargetSubstrate(handle);
}

function captureSolveCaptcha(): CapturedHandler {
  const handlers: Record<string, CapturedHandler> = {};
  const host = {
    z,
    register: (name: string, _def: unknown, handler: CapturedHandler) => {
      handlers[name] = handler;
    },
    gateCheck: () => undefined,
    entryFor: () => ({ session: safariSession(), secrets: { applyMaskDeep: (x: unknown) => x } }),
    caps: { enabled: new Set<string>() },
    credentialsResolved: {},
    targetFor: () => safariTarget(),
  } as unknown as ToolHost;
  registerSecretsCaptchaTools(host);
  const handler = handlers.solve_captcha;
  if (!handler) throw new Error("solve_captcha was not registered");
  return handler;
}

function bodyOf(res: ToolResponse): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("solve_captcha — no Playwright page", () => {
  const realFetch = globalThis.fetch;
  let posts: string[];

  beforeEach(() => {
    process.env.BROWX_CAPTCHA_PROVIDER = "2captcha";
    process.env.BROWX_CAPTCHA_API_KEY = "test-key";
    posts = [];
    globalThis.fetch = vi.fn((url: string | URL | Request) => {
      posts.push(String(url));
      // Non-ok short-circuits submitToProvider before any polling.
      return Promise.resolve(new Response("", { status: 503 }));
    });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.BROWX_CAPTCHA_PROVIDER;
    delete process.env.BROWX_CAPTCHA_API_KEY;
  });

  it("refuses a selector-derived site-key structurally, spending nothing", async () => {
    const body = bodyOf(
      await captureSolveCaptcha()({ type: "recaptcha2", selector: ".g-recaptcha" }),
    );
    expect(body.ok).toBe(false);
    expect(body.provider).toBe("2captcha");
    expect(String(body.error)).toContain("site-key from a selector");
    // The hint names the way through, not a step that cannot help here.
    expect(String(body.hint)).toContain("`siteKey`");
    // The refusal landed before the provider was asked to do anything.
    expect(posts).toEqual([]);
  });

  it("submits the target-port URL as the solve scope", async () => {
    let submitted = "";
    globalThis.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      submitted = String(init?.body ?? "");
      return Promise.resolve(new Response("", { status: 503 }));
    });
    await captureSolveCaptcha()({ type: "hcaptcha", siteKey: "hc-key" });
    expect(new URLSearchParams(submitted).get("pageurl")).toBe(PAGE_URL);
  });
});

// get_credential binds the vault password to the origins the operator listed
// for the account in BROWX_CREDENTIAL_ORIGINS, and refuses any other account.
describe("get_credential — origin binding and account names", () => {
  function captureGetCredential(opts: {
    pageUrl: string;
    origins?: Record<string, string[]>;
    providerName?: ProviderName;
  }): {
    handler: CapturedHandler;
    secrets: SecretRegistry;
    lookups: string[];
  } {
    const handlers: Record<string, CapturedHandler> = {};
    const secrets = new SecretRegistry();
    const lookups: string[] = [];
    const provider = makeFakeProvider(
      {
        getTotp: () => Promise.resolve({ ok: true, code: "123456", provider: "1password" }),
        getCredential: (account: string) => {
          lookups.push(account);
          return Promise.resolve({
            ok: true,
            provider: "1password",
            username: "alice",
            _password: "vault-pass-2",
          } as CredentialResult);
        },
      },
      opts.providerName ?? "1password",
    );
    const host = {
      z,
      register: (name: string, _def: unknown, handler: CapturedHandler) => {
        handlers[name] = handler;
      },
      gateCheck: () => undefined,
      entryFor: () => ({ secrets }),
      caps: { enabled: new Set<string>(["secrets", "credentials"]) },
      credentialsResolved: {
        provider,
        config: {
          provider: opts.providerName ?? "1password",
          warnings: [],
          origins: opts.origins ?? {},
        },
      },
      targetFor: () => ({ url: () => Promise.resolve(opts.pageUrl) }),
    } as unknown as ToolHost;
    registerSecretsCaptchaTools(host);
    return { handler: handlers.get_credential!, secrets, lookups };
  }

  it("refuses an unlisted account before asking the vault", async () => {
    const { handler, secrets, lookups } = captureGetCredential({
      pageUrl: "https://app.example.com/login",
      origins: { other: ["https://other.example.com"] },
    });
    const body = bodyOf(await handler({ account: "acme" }));
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain("BROWX_CREDENTIAL_ORIGINS");
    expect(String(body.error)).toContain('"acme"');
    expect(String(body.error)).toContain("acme=https://");
    expect(String(body.error)).toMatch(/restart/);
    expect(lookups).toEqual([]);
    expect(secrets.size()).toBe(0);
  });

  it("refuses with the oathtool reason, not an origin hint, when oathtool is the provider", async () => {
    const { handler, lookups } = captureGetCredential({
      pageUrl: "https://app.example.com/",
      origins: { acme: ["https://app.example.com"] },
      providerName: "oathtool",
    });
    const body = bodyOf(await handler({ account: "acme" }));
    expect(body.ok).toBe(false);
    expect(body.provider).toBe("oathtool");
    expect(String(body.error)).toContain("TOTP seeds only");
    expect(String(body.error)).toContain("BROWX_CREDENTIALS_PROVIDER");
    expect(lookups).toEqual([]);
  });

  it("refuses an unlisted account even with no origins configured at all", async () => {
    const { handler, lookups } = captureGetCredential({ pageUrl: "https://app.example.com/" });
    const body = bodyOf(await handler({ account: "acme" }));
    expect(body.ok).toBe(false);
    expect(lookups).toEqual([]);
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "treats the account name %s as unlisted",
    async (account) => {
      const { handler, secrets, lookups } = captureGetCredential({
        pageUrl: "https://app.example.com/",
        origins: { acme: ["https://app.example.com"] },
      });
      const body = bodyOf(await handler({ account }));
      expect(body.ok).toBe(false);
      expect(lookups).toEqual([]);
      expect(secrets.size()).toBe(0);
    },
  );

  it("binds a listed account to its listed origins, whatever page is open", async () => {
    const { handler, secrets, lookups } = captureGetCredential({
      pageUrl: "https://elsewhere.test/",
      origins: { acme: ["https://sso.example.com", "https://app.example.com"] },
    });
    const body = bodyOf(await handler({ account: "acme" }));
    expect(body.ok).toBe(true);
    expect(lookups).toEqual(["acme"]);
    expect(body.origins).toEqual(["https://sso.example.com", "https://app.example.com"]);
    expect(JSON.stringify(body)).not.toContain("vault-pass-2");
    expect(secrets.materialize("<PASSWORD_ACME>", "https://elsewhere.test/").ok).toBe(false);
    expect(secrets.materialize("<PASSWORD_ACME>", "https://sso.example.com/").ok).toBe(true);
    expect(secrets.materialize("<PASSWORD_ACME>", "https://app.example.com/x").ok).toBe(true);
    expect(secrets.materialize("<PASSWORD_ACME>", "https://evil.test/?app.example.com").ok).toBe(
      false,
    );
  });

  it("rejects an account that could read as a CLI flag, before asking the vault", async () => {
    const { handler, lookups } = captureGetCredential({ pageUrl: "https://app.example.com/" });
    const body = bodyOf(await handler({ account: "--session=x" }));
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(/not a valid account name/);
    expect(lookups).toEqual([]);
  });
});
