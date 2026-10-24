import { describe, it, expect, vi } from "vitest";
import {
  KNOWN_PROVIDERS,
  resolveCaptchaProvider,
  submitToProvider,
  unconfiguredFailure,
} from "./solve-captcha.js";

describe("resolveCaptchaProvider", () => {
  const KEYED = { BROWX_CAPTCHA_PROVIDER: "2captcha", BROWX_CAPTCHA_API_KEY: "k" };

  it.each([
    { name: "no env vars set", env: {}, match: { reason: "unconfigured" } },
    {
      name: "only the provider set",
      env: { BROWX_CAPTCHA_PROVIDER: "2captcha" },
      match: { reason: "partial" },
    },
    {
      name: "only the key set",
      env: { BROWX_CAPTCHA_API_KEY: "abc" },
      match: { reason: "partial" },
    },
    {
      name: "an unknown provider, naming it and the known ones",
      env: { BROWX_CAPTCHA_PROVIDER: "deathbycaptcha", BROWX_CAPTCHA_API_KEY: "k" },
      match: {
        reason: "partial",
        error: expect.stringMatching(/^(?=[\s\S]*deathbycaptcha)(?=[\s\S]*2captcha)/),
      },
    },
    {
      name: "a plain-http base on a non-loopback host",
      env: { ...KEYED, BROWX_CAPTCHA_API_BASE: "http://captcha.example.test" },
      match: {
        reason: "partial",
        error: expect.stringMatching(/BROWX_CAPTCHA_API_BASE must be an https URL/),
      },
    },
    {
      name: "a non-http(s) base",
      env: { ...KEYED, BROWX_CAPTCHA_API_BASE: "ftp://127.0.0.1" },
      match: { error: expect.stringMatching(/BROWX_CAPTCHA_API_BASE/) },
    },
    {
      name: "an unparseable base",
      env: { ...KEYED, BROWX_CAPTCHA_API_BASE: "not a url" },
      match: { error: expect.stringMatching(/BROWX_CAPTCHA_API_BASE/) },
    },
    {
      name: "a non-positive timeoutMs",
      env: { ...KEYED, BROWX_CAPTCHA_TIMEOUT_MS: "0" },
      match: {},
    },
  ])("refuses $name", ({ env, match }) => {
    expect(resolveCaptchaProvider(env)).toMatchObject({ ok: false, ...match });
  });

  it.each([
    {
      name: "a 2captcha config with defaults",
      env: KEYED,
      config: {
        provider: "2captcha",
        apiBase: "https://2captcha.com",
        timeoutMs: 120_000,
        pollMs: 5000,
      },
    },
    {
      name: "an https BROWX_CAPTCHA_API_BASE override, trailing slash trimmed",
      env: { ...KEYED, BROWX_CAPTCHA_API_BASE: "https://example.test/captcha/" },
      config: { apiBase: "https://example.test/captcha" },
    },
    {
      name: "a mixed-case provider name (operators paste from docs)",
      env: { ...KEYED, BROWX_CAPTCHA_PROVIDER: "2Captcha" },
      config: {},
    },
    ...["http://127.0.0.1:8080", "http://localhost:8080/", "http://[::1]:8080"].map((base) => ({
      name: `plain http for the loopback base ${base}`,
      env: { ...KEYED, BROWX_CAPTCHA_API_BASE: base },
      config: { apiBase: base.replace(/\/+$/, "") },
    })),
  ])("resolves $name", ({ env, config }) => {
    const r = resolveCaptchaProvider(env);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config).toMatchObject(config);
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
    const calls: Array<{ url: string; body?: string; method?: string }> = [];
    let pollN = 0;
    const fakeFetch = vi.fn(async (url: string, init?: { body?: string; method?: string }) => {
      calls.push({ url, body: init?.body, method: init?.method });
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
    // every poll is a POST to /res.php with the key and task id in the form body,
    // and no request URL carries the key
    const polls = calls.filter((c) => c.url.endsWith("/res.php"));
    expect(polls).toHaveLength(2);
    for (const p of polls) {
      expect(p.method).toBe("POST");
      const form = new URLSearchParams(p.body);
      expect(form.get("key")).toBe("secret-key");
      expect(form.get("id")).toBe("tid-42");
      expect(form.get("action")).toBe("get");
    }
    for (const c of calls) expect(c.url).not.toContain("secret-key");
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

  it.each([
    { name: "a recaptcha2 submission missing siteKey", challenge: { type: "recaptcha2" as const } },
    { name: "an image submission missing imageBase64", challenge: { type: "image" as const } },
  ])("rejects $name before contacting the provider", async ({ challenge }) => {
    const fakeFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const r = await submitToProvider(
      { ...challenge, pageUrl: "https://app.example" },
      config,
      fakeFetch,
      () => 0,
    );
    expect(r.ok).toBe(false);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("sends both the submit and the poll with redirects refused", async () => {
    const inits: Array<{ url: string; redirect?: string }> = [];
    const fakeFetch = vi.fn(async (url: string, init?: { redirect?: string }) => {
      inits.push({ url, redirect: init?.redirect });
      if (url.endsWith("/in.php")) {
        return new Response(JSON.stringify({ status: 1, request: "tid-7" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 1, request: "TOKEN" }), { status: 200 });
    });
    const r = await submitToProvider(
      { type: "hcaptcha", pageUrl: "https://app.example", siteKey: "sk" },
      config,
      fakeFetch as unknown as typeof fetch,
      () => 0,
      async () => undefined,
    );
    expect(r.ok).toBe(true);
    expect(inits.map((i) => i.url.split("/").pop())).toEqual(["in.php", "res.php"]);
    for (const i of inits) expect(i.redirect).toBe("error");
  });

  const redirectRejection = () =>
    new TypeError("fetch failed", { cause: new Error("unexpected redirect") });

  it("maps a redirect on submit to a failure with a clear message", async () => {
    const fakeFetch = vi.fn(async () => {
      throw redirectRejection();
    });
    const r = await submitToProvider(
      { type: "recaptcha2", pageUrl: "https://app.example", siteKey: "sk" },
      config,
      fakeFetch,
      () => 0,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("redirect");
      expect(r.error).toContain("not followed");
      expect(r.hint).toContain("BROWX_CAPTCHA_API_BASE");
    }
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(r)).not.toContain("secret-key");
  });

  /** An error chain `levels` deep: the outermost is level 0, and the last
   *  one carries `message`. */
  const causeChain = (levels: number, message: string): Error => {
    let err = new Error(message);
    for (let i = 1; i < levels; i++) err = new Error("wrapper", { cause: err });
    return err;
  };
  const submitRejecting = async (err: unknown) =>
    submitToProvider(
      { type: "recaptcha2", pageUrl: "https://app.example", siteKey: "sk" },
      config,
      vi.fn(async () => {
        throw err;
      }),
      () => 0,
    );

  it("finds a redirect as deep as the fourth error in the cause chain", async () => {
    const r = await submitRejecting(causeChain(4, "unexpected redirect"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not followed");
  });

  it("stops looking after four errors in the cause chain", async () => {
    const r = await submitRejecting(causeChain(5, "unexpected redirect"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("network error submitting");
      expect(r.error).not.toContain("not followed");
    }
  });

  it("ends on an error whose cause is itself", async () => {
    const loop = new Error("loop");
    loop.cause = loop;
    const r = await submitRejecting(loop);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("network error submitting");
  });

  it("ends the wait on a redirect during the poll instead of retrying until the deadline", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.endsWith("/in.php")) {
        return new Response(JSON.stringify({ status: 1, request: "tid-9" }), { status: 200 });
      }
      throw redirectRejection();
    });
    const r = await submitToProvider(
      { type: "hcaptcha", pageUrl: "https://app.example", siteKey: "sk" },
      config,
      fakeFetch as unknown as typeof fetch,
      () => 0,
      async () => undefined,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("redirect");
    // one submit, one poll, then it stopped
    expect(fakeFetch).toHaveBeenCalledTimes(2);
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
