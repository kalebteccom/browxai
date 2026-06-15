// `solve_captcha` — gated behind the off-by-default `captcha` capability.
//
// What this is (and is NOT):
//
//   - This is a DELEGATION SEAM, not a solver. browxai does NOT bundle a
//     captcha solver; doing so would mean shipping ML weights / cloud creds /
//     legal exposure to every adopter. Instead the tool reads provider config
//     from environment variables at session-/call-time and POSTs the captcha
//     challenge to that provider's HTTP API. If no provider is configured,
//     the tool returns a structured failure with a clear "no provider
//     configured" hint — never tries to "guess" the answer.
//
//   - The provider API shape we target for v0.2.0 is the **2Captcha** REST
//     contract (`POST /in.php` to submit + poll `GET /res.php` for the
//     answer). CapMonster Cloud mirrors this API exactly (it documents
//     itself as drop-in compatible with 2Captcha), so configuring
//     `BROWX_CAPTCHA_PROVIDER=capmonster` + `BROWX_CAPTCHA_API_BASE=https://api.capmonster.cloud`
//     works without code changes. Other providers (AntiCaptcha's
//     `/createTask` + `/getTaskResult` flow, hCaptcha-specific endpoints)
//     are extensible — drop a new branch in `submitToProvider` and add the
//     provider name to `KNOWN_PROVIDERS`. We chose 2Captcha because (a) it
//     and CapMonster between them cover the majority of real-world adopter
//     captcha-solving setups, and (b) the polled-task model is the most
//     widely-mirrored shape, so 2Captcha-compatible providers proliferate.
//
//   - Posture: same class as `eval` / `network-body` / `secrets` / `extensions`
//     / `stealth`. Loud one-time warning at server boot when the capability
//     is on; the warning names the legal/ToS exposure explicitly. Many
//     sites' terms of service prohibit "circumventing access controls"
//     including captchas; using this tool against such sites is the
//     operator's choice and their legal exposure.

import { log } from "../util/logging.js";

/** Provider names this version of the module knows how to talk to. Other
 *  providers can be added without breaking the env-config surface — new
 *  names just append. */
export const KNOWN_PROVIDERS = ["2captcha", "capmonster"] as const;
export type CaptchaProvider = (typeof KNOWN_PROVIDERS)[number];

/** Captcha types this tool surfaces in its input schema. The string is
 *  forwarded to the provider — providers themselves accept the same shape
 *  (`recaptcha2`, `hcaptcha`, `image`, etc.) so we keep the vocabulary thin. */
export type CaptchaType = "recaptcha2" | "recaptcha3" | "hcaptcha" | "image" | "turnstile";

/** Resolved provider config (from env). `apiKey` is sensitive — NEVER log it,
 *  NEVER include it on the tool result. */
export interface CaptchaProviderConfig {
  provider: CaptchaProvider;
  apiKey: string;
  /** Override the provider's base URL. Default is the canonical endpoint for
   *  the chosen provider. Useful for self-hosted CapMonster-compatible
   *  proxies or for testing. */
  apiBase: string;
  /** Per-attempt polling deadline in milliseconds. Default 120_000
   *  (2 minutes) — most providers take 10–60s for image/recaptcha. */
  timeoutMs: number;
  /** Poll interval between `getTaskResult` calls. Default 5000 ms. */
  pollMs: number;
}

const DEFAULT_BASE_FOR: Record<CaptchaProvider, string> = {
  "2captcha": "https://2captcha.com",
  capmonster: "https://api.capmonster.cloud",
};

/** Read provider config from env. Returns `null` when nothing is configured —
 *  the caller surfaces a structured `ok:false` with a "no provider
 *  configured" hint rather than throwing (the capability is on but the
 *  deployment hasn't wired a solver — recoverable, not a server-startup
 *  error). Returns an `error` object on partial config (provider set without
 *  api-key, unknown provider name) so the agent sees a clear pointer. */
export function resolveCaptchaProvider(
  env: NodeJS.ProcessEnv = process.env,
):
  | { ok: true; config: CaptchaProviderConfig }
  | { ok: false; reason: "unconfigured" | "partial"; error?: string } {
  const rawProvider = env.BROWX_CAPTCHA_PROVIDER?.trim();
  const rawKey = env.BROWX_CAPTCHA_API_KEY?.trim();
  if (!rawProvider && !rawKey) {
    return { ok: false, reason: "unconfigured" };
  }
  if (!rawProvider) {
    return {
      ok: false,
      reason: "partial",
      error:
        "BROWX_CAPTCHA_API_KEY is set but BROWX_CAPTCHA_PROVIDER is not — set both, or unset both.",
    };
  }
  if (!rawKey) {
    return {
      ok: false,
      reason: "partial",
      error: `BROWX_CAPTCHA_PROVIDER="${rawProvider}" is set but BROWX_CAPTCHA_API_KEY is not — set both, or unset both.`,
    };
  }
  const provider = rawProvider.toLowerCase() as CaptchaProvider;
  if (!KNOWN_PROVIDERS.includes(provider)) {
    return {
      ok: false,
      reason: "partial",
      error:
        `BROWX_CAPTCHA_PROVIDER="${rawProvider}" is not a known provider. ` +
        `Known: ${KNOWN_PROVIDERS.join(", ")}. ` +
        `Other providers can be supported by extending src/page/solve-captcha.ts.`,
    };
  }
  const apiBase = (env.BROWX_CAPTCHA_API_BASE?.trim() || DEFAULT_BASE_FOR[provider]).replace(
    /\/+$/,
    "",
  );
  const timeout = parsePositiveIntEnv(
    env.BROWX_CAPTCHA_TIMEOUT_MS,
    120_000,
    "BROWX_CAPTCHA_TIMEOUT_MS",
  );
  if (!timeout.ok) return { ok: false, reason: "partial", error: timeout.error };
  const poll = parsePositiveIntEnv(env.BROWX_CAPTCHA_POLL_MS, 5000, "BROWX_CAPTCHA_POLL_MS");
  if (!poll.ok) return { ok: false, reason: "partial", error: poll.error };
  return {
    ok: true,
    config: { provider, apiKey: rawKey, apiBase, timeoutMs: timeout.value, pollMs: poll.value },
  };
}

/** Parse a positive-integer env var (ms), falling back to `fallback` when unset.
 *  Returns a structured error message naming `varName` when it isn't a positive
 *  integer. */
function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
  varName: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = raw?.trim();
  const value = trimmed ? Number.parseInt(trimmed, 10) : fallback;
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, error: `${varName}="${trimmed}" must be a positive integer (ms).` };
  }
  return { ok: true, value };
}

/** A challenge ready to submit. The shape mirrors the 2Captcha `in.php` form:
 *  `googlekey` + `pageurl` for recaptcha2/3, `sitekey` + `pageurl` for
 *  hcaptcha / turnstile, `body` (base64) for image. The tool layer extracts
 *  these from the page given `type` + `selector` + the current page URL. */
export interface CaptchaChallenge {
  type: CaptchaType;
  pageUrl: string;
  /** For recaptcha/hcaptcha/turnstile: the site-key as published on the page. */
  siteKey?: string;
  /** For image captchas: base64-encoded image bytes (without the data URL prefix). */
  imageBase64?: string;
}

/** Solver result envelope. `solution` is the provider-returned token / text
 *  the agent then types into a hidden form field or invokes a JS callback
 *  with. We do NOT auto-submit — the agent is in the driver's seat for
 *  what to do with the solution (different sites wire reCAPTCHA differently). */
export interface CaptchaSolution {
  ok: true;
  provider: CaptchaProvider;
  solution: string;
  /** Provider-specific task id (for logs / cost reconciliation, never sensitive). */
  taskId: string;
  elapsedMs: number;
}

export interface CaptchaFailure {
  ok: false;
  provider: CaptchaProvider | null;
  error: string;
  hint: string;
  /** Best-effort: when the provider returned a structured error, surface its
   *  code so the agent can decide whether to retry. */
  providerCode?: string;
}

/**
 * Submit a challenge to the configured provider and poll for the solution.
 * Uses native `fetch` (Node 18+ ships it; Node 20 is the project's floor).
 * The provider may return a transient busy state (`CAPCHA_NOT_READY`) — we
 * poll until the deadline.
 *
 * `fetchImpl` parameter is injected so tests can stub it without a real
 * network round-trip.
 */
/** Per-captcha-type submit-method config: the 2Captcha `method`, the form key
 *  the siteKey rides under, and an optional extra (e.g. recaptcha3 `version`). */
const SITEKEY_SUBMIT: Record<
  "recaptcha2" | "recaptcha3" | "hcaptcha" | "turnstile",
  { method: string; keyParam: string; extra?: [string, string]; hint: string }
> = {
  recaptcha2: {
    method: "userrecaptcha",
    keyParam: "googlekey",
    hint: "recaptcha2 requires a siteKey (the page's `data-sitekey` attribute)",
  },
  recaptcha3: {
    method: "userrecaptcha",
    keyParam: "googlekey",
    extra: ["version", "v3"],
    hint: "recaptcha3 requires a siteKey (the page's `data-sitekey` attribute)",
  },
  hcaptcha: {
    method: "hcaptcha",
    keyParam: "sitekey",
    hint: "hcaptcha requires a siteKey (the hCaptcha widget's `data-sitekey`)",
  },
  turnstile: {
    method: "turnstile",
    keyParam: "sitekey",
    hint: "turnstile requires a siteKey (Cloudflare Turnstile's `data-sitekey`)",
  },
};

/** Build the 2Captcha `/in.php` form body for a challenge, or a structured
 *  failure when a required field (siteKey / imageBase64) is missing. */
function buildSubmitBody(
  challenge: CaptchaChallenge,
  config: CaptchaProviderConfig,
): { body: URLSearchParams } | { error: CaptchaFailure } {
  const body = new URLSearchParams({ key: config.apiKey, json: "1" });
  if (challenge.type === "image") {
    if (!challenge.imageBase64) {
      return {
        error: failureWithHint(
          config.provider,
          "image captcha requires `imageBase64` (raw base64, no data URL prefix)",
        ),
      };
    }
    body.set("method", "base64");
    body.set("body", challenge.imageBase64);
    return { body };
  }
  const spec = SITEKEY_SUBMIT[challenge.type];
  if (!spec) {
    return {
      error: failureWithHint(
        config.provider,
        `unsupported captcha type "${String((challenge as { type: string }).type)}"`,
      ),
    };
  }
  if (!challenge.siteKey) return { error: failureWithHint(config.provider, spec.hint) };
  body.set("method", spec.method);
  if (spec.extra) body.set(spec.extra[0], spec.extra[1]);
  body.set(spec.keyParam, challenge.siteKey);
  body.set("pageurl", challenge.pageUrl);
  return { body };
}

export async function submitToProvider(
  challenge: CaptchaChallenge,
  config: CaptchaProviderConfig,
  fetchImpl: typeof fetch = fetch,
  nowFn: () => number = Date.now,
  sleepFn: (ms: number) => Promise<void> = (ms) => new Promise((res) => setTimeout(res, ms)),
): Promise<CaptchaSolution | CaptchaFailure> {
  const started = nowFn();
  const built = buildSubmitBody(challenge, config);
  if ("error" in built) return built.error;
  const submitBody = built.body;
  let submitResp: Response;
  try {
    submitResp = await fetchImpl(`${config.apiBase}/in.php`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: submitBody.toString(),
    });
  } catch (err) {
    return failureWithHint(
      config.provider,
      `network error submitting to provider: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!submitResp.ok) {
    return failureWithHint(
      config.provider,
      `provider returned HTTP ${submitResp.status} on submit`,
    );
  }
  let submitJson: { status?: number; request?: string; error_text?: string };
  try {
    submitJson = (await submitResp.json()) as typeof submitJson;
  } catch (err) {
    return failureWithHint(
      config.provider,
      `provider returned non-JSON on submit: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (submitJson.status !== 1 || !submitJson.request) {
    return {
      ok: false,
      provider: config.provider,
      error: `provider rejected submission: ${submitJson.request ?? "(no detail)"}`,
      hint:
        submitJson.error_text ??
        "Check the provider dashboard for account balance / blocked-method status.",
      ...(submitJson.request ? { providerCode: submitJson.request } : {}),
    };
  }
  return pollForSolution(submitJson.request, config, started, { fetchImpl, nowFn, sleepFn });
}

/** Injected timing/network seams for the poll loop (tests stub these). */
interface PollSeams {
  fetchImpl: typeof fetch;
  nowFn: () => number;
  sleepFn: (ms: number) => Promise<void>;
}

/** One poll tick: fetch /res.php once. Returns a terminal solution/failure, or
 *  null to keep polling (transient blip or still-working). */
async function pollOnce(
  taskId: string,
  config: CaptchaProviderConfig,
  started: number,
  seams: PollSeams,
): Promise<CaptchaSolution | CaptchaFailure | null> {
  let pollResp: Response;
  try {
    pollResp = await seams.fetchImpl(
      `${config.apiBase}/res.php?key=${encodeURIComponent(config.apiKey)}&action=get&id=${encodeURIComponent(taskId)}&json=1`,
    );
  } catch (err) {
    log.warn(
      `solve_captcha: poll network blip (${err instanceof Error ? err.message : String(err)}) — continuing`,
    );
    return null;
  }
  if (!pollResp.ok) {
    log.warn(`solve_captcha: poll returned HTTP ${pollResp.status} — continuing`);
    return null;
  }
  let pollJson: { status?: number; request?: string; error_text?: string };
  try {
    pollJson = (await pollResp.json()) as typeof pollJson;
  } catch {
    return null;
  }
  if (pollJson.status === 1 && pollJson.request) {
    return {
      ok: true,
      provider: config.provider,
      solution: pollJson.request,
      taskId,
      elapsedMs: seams.nowFn() - started,
    };
  }
  // `status:0, request:"CAPCHA_NOT_READY"` is the canonical "still working"
  // signal; any other request-string is a terminal error.
  if (pollJson.request && pollJson.request !== "CAPCHA_NOT_READY") {
    return {
      ok: false,
      provider: config.provider,
      error: `provider returned terminal error: ${pollJson.request}`,
      hint: pollJson.error_text ?? "Consult the provider documentation for this error code.",
      providerCode: pollJson.request,
    };
  }
  return null; // still working — keep polling
}

/** Poll /res.php until ready or the deadline expires. */
async function pollForSolution(
  taskId: string,
  config: CaptchaProviderConfig,
  started: number,
  seams: PollSeams,
): Promise<CaptchaSolution | CaptchaFailure> {
  while (true) {
    if (seams.nowFn() - started > config.timeoutMs) {
      return {
        ok: false,
        provider: config.provider,
        error: `provider did not return a solution within ${config.timeoutMs}ms`,
        hint: "Increase BROWX_CAPTCHA_TIMEOUT_MS, or check the provider dashboard — repeated timeouts usually mean the worker pool is overloaded.",
        providerCode: taskId,
      };
    }
    await seams.sleepFn(config.pollMs);
    const outcome = await pollOnce(taskId, config, started, seams);
    if (outcome) return outcome;
  }
}

function failureWithHint(provider: CaptchaProvider, error: string): CaptchaFailure {
  return {
    ok: false,
    provider,
    error,
    hint:
      "Validate the captcha challenge inputs against the provider's API docs " +
      "(https://2captcha.com/2captcha-api for 2Captcha / CapMonster-compatible providers).",
  };
}

/** Build the structured "no provider configured" failure — used when the
 *  capability is on but env vars are unset. Hints at exactly what to set and
 *  names the per-deployment / no-bundled-solver / no-auto-purchase posture. */
export function unconfiguredFailure(): CaptchaFailure {
  return {
    ok: false,
    provider: null,
    error: "no captcha provider configured — `solve_captcha` cannot delegate.",
    hint:
      'Set BROWX_CAPTCHA_PROVIDER (e.g. "2captcha" or "capmonster") and BROWX_CAPTCHA_API_KEY in the server\'s ' +
      "environment to enable delegation. browxai does NOT bundle a solver and does NOT auto-purchase credits — the " +
      "operator chooses a provider, funds the account, and configures the server. Known providers in this version: " +
      `${KNOWN_PROVIDERS.join(", ")} (both speak the 2Captcha-compatible HTTP API).`,
  };
}
