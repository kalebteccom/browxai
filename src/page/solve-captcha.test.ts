import { describe, it, expect, vi } from "vitest";
import {
  KNOWN_PROVIDERS,
  resolveCaptchaProvider,
  submitToProvider,
  unconfiguredFailure,
} from "./solve-captcha.js";

describe("resolveCaptchaProvider", () => {
  it("returns unconfigured when no env vars are set", () => {
    const r = resolveCaptchaProvider({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unconfigured");
  });

  it("returns partial when only one of provider/key is set", () => {
    const a = resolveCaptchaProvider({ BROWX_CAPTCHA_PROVIDER: "2captcha" });
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toBe("partial");
    const b = resolveCaptchaProvider({ BROWX_CAPTCHA_API_KEY: "abc" });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("partial");
  });

  it("rejects an unknown provider with a named hint", () => {
    const r = resolveCaptchaProvider({
      BROWX_CAPTCHA_PROVIDER: "deathbycaptcha",
      BROWX_CAPTCHA_API_KEY: "k",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("partial");
      expect(r.error).toMatch(/deathbycaptcha/);
      expect(r.error).toMatch(/2captcha/);
    }
  });

  it("resolves a 2captcha config with defaults", () => {
    const r = resolveCaptchaProvider({
      BROWX_CAPTCHA_PROVIDER: "2captcha",
      BROWX_CAPTCHA_API_KEY: "k",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.provider).toBe("2captcha");
      expect(r.config.apiBase).toBe("https://2captcha.com");
      expect(r.config.timeoutMs).toBe(120_000);
      expect(r.config.pollMs).toBe(5000);
    }
  });

  it("resolves capmonster with its canonical base URL", () => {
    const r = resolveCaptchaProvider({
      BROWX_CAPTCHA_PROVIDER: "capmonster",
      BROWX_CAPTCHA_API_KEY: "k",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.apiBase).toBe("https://api.capmonster.cloud");
    }
  });

  it("honours an explicit BROWX_CAPTCHA_API_BASE override", () => {
    const r = resolveCaptchaProvider({
      BROWX_CAPTCHA_PROVIDER: "2captcha",
      BROWX_CAPTCHA_API_KEY: "k",
      BROWX_CAPTCHA_API_BASE: "https://example.test/captcha/",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // trailing slash trimmed
      expect(r.config.apiBase).toBe("https://example.test/captcha");
    }
  });

  it("rejects a non-positive timeoutMs", () => {
    const r = resolveCaptchaProvider({
      BROWX_CAPTCHA_PROVIDER: "2captcha",
      BROWX_CAPTCHA_API_KEY: "k",
      BROWX_CAPTCHA_TIMEOUT_MS: "0",
    });
    expect(r.ok).toBe(false);
  });

  it("provider names are case-insensitive (operators paste from docs)", () => {
    const r = resolveCaptchaProvider({
      BROWX_CAPTCHA_PROVIDER: "2Captcha",
      BROWX_CAPTCHA_API_KEY: "k",
    });
    expect(r.ok).toBe(true);
  });
});

describe("unconfiguredFailure", () => {
  it("names both env vars and the no-bundled-solver / no-auto-purchase posture", () => {
    const f = unconfiguredFailure();
    expect(f.ok).toBe(false);
    expect(f.error).toMatch(/no captcha provider configured/);
    expect(f.hint).toContain("BROWX_CAPTCHA_PROVIDER");
    expect(f.hint).toContain("BROWX_CAPTCHA_API_KEY");
    expect(f.hint).toMatch(/auto-purchase|fund/i);
    for (const p of KNOWN_PROVIDERS) expect(f.hint).toContain(p);
  });

  it("does not surface a `provider` value when none is configured", () => {
    const f = unconfiguredFailure();
    expect(f.provider).toBeNull();
  });
});

describe("submitToProvider", () => {
  const config = {
    provider: "2captcha" as const,
    apiKey: "secret-key",
    apiBase: "https://2captcha.com",
    timeoutMs: 60_000,
    pollMs: 10,
  };

  it("submits a recaptcha2 challenge with the right form fields", async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    let pollN = 0;
    const fakeFetch = vi.fn(async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body });
      if (url.endsWith("/in.php")) {
        return new Response(JSON.stringify({ status: 1, request: "tid-42" }), { status: 200 });
      }
      pollN++;
      if (pollN < 2) {
        return new Response(JSON.stringify({ status: 0, request: "CAPCHA_NOT_READY" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ status: 1, request: "TOKEN-XYZ" }), { status: 200 });
    });
    const r = await submitToProvider(
      { type: "recaptcha2", pageUrl: "https://app.example/login", siteKey: "site-abc" },
      config,
      fakeFetch as unknown as typeof fetch,
      () => 0,
      async () => undefined,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.solution).toBe("TOKEN-XYZ");
      expect(r.taskId).toBe("tid-42");
      expect(r.provider).toBe("2captcha");
    }
    // submit went to /in.php with googlekey + pageurl
    const submit = calls.find((c) => c.url.endsWith("/in.php"))!;
    expect(submit.body).toMatch(/googlekey=site-abc/);
    expect(submit.body).toContain("pageurl=https%3A%2F%2Fapp.example%2Flogin");
    expect(submit.body).toMatch(/method=userrecaptcha/);
  });

  it("returns a structured failure when the provider rejects the submission", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 0, request: "ERROR_KEY_DOES_NOT_EXIST" }), {
          status: 200,
        }),
    );
    const r = await submitToProvider(
      { type: "image", pageUrl: "https://app.example/x", imageBase64: "AAA=" },
      config,
      fakeFetch,
      () => 0,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/provider rejected/);
      expect(r.providerCode).toBe("ERROR_KEY_DOES_NOT_EXIST");
    }
  });

  it("times out cleanly when the provider never returns ready", async () => {
    let now = 0;
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/in.php")) {
        return new Response(JSON.stringify({ status: 1, request: "tid-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 0, request: "CAPCHA_NOT_READY" }), {
        status: 200,
      });
    });
    const r = await submitToProvider(
      { type: "hcaptcha", pageUrl: "https://app.example", siteKey: "sk" },
      { ...config, timeoutMs: 100, pollMs: 30 },
      fakeFetch as unknown as typeof fetch,
      () => {
        now += 40;
        return now;
      },
      async () => undefined,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/did not return a solution within/);
  });

  it("rejects a recaptcha2 submission missing siteKey before contacting the provider", async () => {
    const fakeFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await submitToProvider(
      { type: "recaptcha2", pageUrl: "https://app.example" },
      config,
      fakeFetch,
      () => 0,
    );
    expect(r.ok).toBe(false);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("rejects an image submission missing imageBase64 before contacting the provider", async () => {
    const fakeFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await submitToProvider(
      { type: "image", pageUrl: "https://app.example" },
      config,
      fakeFetch,
      () => 0,
    );
    expect(r.ok).toBe(false);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("never echoes the api key in the failure body", async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const r = await submitToProvider(
      { type: "recaptcha2", pageUrl: "https://app.example", siteKey: "sk" },
      config,
      fakeFetch,
      () => 0,
    );
    expect(JSON.stringify(r)).not.toContain("secret-key");
  });
});
