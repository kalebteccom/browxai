import {
  resolveCaptchaProvider,
  submitToProvider,
  unconfiguredFailure,
  type CaptchaType,
} from "../page/solve-captcha.js";
import {
  accountError,
  applyCredentialToRegistry,
  SECRETS_REQUIRED_ERROR,
  type ProviderCredentialInternal,
} from "../util/credentials.js";
import { capabilityMissing } from "../util/capabilities.js";
import { estimateTokens } from "../util/tokens.js";
import type { ToolHost } from "./host.js";
import { SESSION_ARG } from "./schemas.js";
import { requirePage } from "../engine/index.js";

type CaptchaPage = ReturnType<typeof requirePage>;

/** Stamp a captcha result body with its token estimate and wrap it as a tool
 *  text response — the shared shape every solve_captcha envelope uses. */
function captchaJsonResult(body: object): { content: Array<{ type: "text"; text: string }> } {
  const withTokens = { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) };
  return { content: [{ type: "text" as const, text: JSON.stringify(withTokens, null, 2) }] };
}

/** Read the widget site-key from a selector — `data-sitekey` (the
 *  reCAPTCHA/hCaptcha/Turnstile convention) first, then common alternatives.
 *  Returns undefined when the selector misses or carries no key. */
async function readSiteKeyFromSelector(
  page: CaptchaPage,
  selector: string,
): Promise<string | undefined> {
  try {
    const handle = await page.$(selector);
    if (!handle) return undefined;
    const key =
      (await handle.getAttribute("data-sitekey")) ??
      (await handle.getAttribute("data-site-key")) ??
      (await handle.getAttribute("sitekey")) ??
      undefined;
    await handle.dispose().catch(() => undefined);
    return key;
  } catch {
    return undefined;
  }
}

/** The `{ok:false}` envelope the credentials tools return before any vault
 *  call: a rejected account name, or nothing to bind a password to. */
function accountRefusal(
  provider: string,
  error: string,
): { content: Array<{ type: "text"; text: string }> } {
  return captchaJsonResult({ ok: false, provider, error });
}

/** The origins the operator listed for `account` in `BROWX_CREDENTIAL_ORIGINS`,
 *  or undefined when the account is not listed. `Object.hasOwn` keeps names
 *  such as `constructor` or `toString` from resolving through the prototype. */
function listedOrigins(
  configured: Readonly<Record<string, readonly string[]>> | undefined,
  account: string,
): readonly string[] | undefined {
  if (!configured || !Object.hasOwn(configured, account)) return undefined;
  const origins = configured[account];
  return Array.isArray(origins) && origins.length > 0 ? origins : undefined;
}

/** The refusal for an account with no `BROWX_CREDENTIAL_ORIGINS` entry. */
function unlistedAccountError(account: string): string {
  return (
    `get_credential: account "${account}" is not listed in BROWX_CREDENTIAL_ORIGINS, so there is ` +
    "no origin to bind its password to. List the origins it may be typed into, for example " +
    `BROWX_CREDENTIAL_ORIGINS="${account}=https://app.example.com|https://sso.example.com", ` +
    "then restart browxai (the variable is read at start)."
  );
}

/** The refusal for `get_credential` when the configured provider is `oathtool`. */
function oathtoolCredentialError(): string {
  return (
    "get_credential: the configured provider is oathtool, which holds TOTP seeds only and stores no " +
    "username or password. Set BROWX_CREDENTIALS_PROVIDER to 1password, bitwarden or lastpass and " +
    "restart browxai. get_totp keeps working with oathtool."
  );
}

/** Either the Playwright `Page` the selector-derived site-key read needs, or the
 *  structured refusal to return instead. */
type SiteKeyPage = { page: CaptchaPage } | { refusal: ReturnType<typeof captchaJsonResult> };

/** Acquire the `Page` the site-key read walks, or refuse structurally.
 *
 *  `requirePage` throws on an engine that backs no Playwright Page and on an
 *  attached session whose tab is gone. Left bare, that throw leaves the handler
 *  as a raw rejection instead of the `{ok:false, error, hint}` envelope every
 *  other solve_captcha failure returns. It also has to land HERE, before
 *  `submitToProvider` — a refusal after the POST would have already spent a
 *  provider credit on a solve the caller cannot complete. */
function pageForSiteKeyRead(
  session: Parameters<typeof requirePage>[0],
  provider: string,
): SiteKeyPage {
  try {
    return { page: requirePage(session) };
  } catch (err) {
    return {
      refusal: captchaJsonResult({
        ok: false,
        provider,
        error: `solve_captcha: cannot read a site-key from a selector on this session — ${
          err instanceof Error ? err.message : String(err)
        }`,
        hint: "Pass `siteKey` explicitly (the widget's `data-sitekey` value). Deriving it from a selector needs a Playwright page; the solve itself does not.",
      }),
    };
  }
}

/**
 * Secrets / captcha / credentials tools — the off-by-default egress-sensitive
 * seams: `register_secret` (the per-session secrets registry that backs egress
 * masking), `solve_captcha` (the provider-bridge), and `get_totp` /
 * `get_credential` (the credentials provider). Registered through the shared
 * `ToolHost` seam.
 */
export function registerSecretsCaptchaTools(host: ToolHost): void {
  const { z, register, gateCheck, entryFor, caps, credentialsResolved, targetFor } = host;

  // ---------- secrets registry (capability `secrets`) ----------

  register(
    "register_secret",
    {
      capability: "secrets",
      description:
        'Register a sensitive value so you can use it without ever seeing it. Requires the `secrets` capability (off by default). Call `fill({value:"<NAME>"})` or `press({key:"<NAME>"})`: the server substitutes the real value at dispatch, so the page receives it, and every output you see (`ActionResult.network`, `network_read`, `network_body`, `ws_read`, `console_read`, `snapshot`, `find` evidence, any other tool result text) has occurrences of the real value replaced by `<NAME>`. `name` matches `/^[A-Z][A-Z0-9_]*$/`. `scope` limits where the value can be typed: an origin such as `https://app.example.com` or `http://localhost:3000`, a bare host (meaning https), or a list of them. A scoped secret is typed only into a frame whose origin matches an entry exactly (scheme, host and port) and is refused anywhere else; a scope with a path, query or `*` is refused at registration, and no `scope` means any origin. The registry is per session, max 32 entries. `screenshot` is a partial sink: it adds a warning when the page text holds a registered value but does not redact pixels, so use `snapshot` or `find` for verified-clean evidence. The real value is never re-emitted or logged.',
      inputSchema: {
        name: z
          .string()
          .describe(
            'Agent-facing alias, e.g. "PASSWORD" / "OTP" / "SESSION_TOKEN". Uppercase identifier — `<NAME>` mask format.',
          ),
        value: z
          .string()
          .describe(
            "The real secret value. Stored per-session in memory only; never persisted, never logged.",
          ),
        scope: z
          .union([z.string(), z.array(z.string()).min(1)])
          .optional()
          .describe(
            'Optional origin, or list of origins: `"https://app.example.com"`, `"http://localhost:3000"`, or a bare host `"app.example.com"` (meaning https). Dispatch-side substitution happens only in a frame whose origin matches an entry exactly (scheme, host and port); no wildcards, no subdomains, no paths. Egress masking is global regardless.',
          ),
        ...SESSION_ARG,
      },
    },
    async ({
      name,
      value,
      scope,
      session,
    }: {
      name: string;
      value: string;
      scope?: string | string[];
      session?: string;
    }) => {
      const g = gateCheck("register_secret");
      if (g) return g;
      const e = await entryFor(session);
      try {
        e.secrets.register({
          name,
          value,
          ...(scope !== undefined && scope !== "" ? { scope } : {}),
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
      const origins = e.secrets.scopeOrigins(name);
      const body = {
        ok: true,
        registered: name,
        scope: scope ?? null,
        // The normalised origins the scope matches, so the agent sees what a
        // bare host resolved to.
        origins,
        // never echo the value back. Echo only the registered names — useful
        // for the agent to confirm what aliases are live without leaking.
        names: e.secrets.names(),
        tokensEstimate: estimateTokens(
          JSON.stringify({ ok: true, registered: name, scope, origins, names: e.secrets.names() }),
        ),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  // ---------- captcha solver delegation (capability `captcha`) ----------
  //
  // `solve_captcha` is a delegation seam — it POSTs the captcha challenge to a
  // provider configured per-deployment via environment variables
  // (BROWX_CAPTCHA_PROVIDER + BROWX_CAPTCHA_API_KEY, optional
  // BROWX_CAPTCHA_API_BASE / BROWX_CAPTCHA_TIMEOUT_MS / BROWX_CAPTCHA_POLL_MS).
  // browxai does NOT bundle a solver and does NOT auto-purchase credits — when
  // the capability is on but no provider is configured the tool returns a
  // structured failure with a clear "no provider configured" hint. Loud-warned
  // at boot (see the `captcha` warning above). Targets the 2Captcha-
  // compatible HTTP API for v0.2.0 (`/in.php` submit + `/res.php` poll);
  // CapMonster Cloud mirrors the same shape. Other providers can be added by
  // extending src/page/solve-captcha.ts.

  register(
    "solve_captcha",
    {
      capability: "captcha",
      description:
        "Send a captcha challenge to a configured external solving provider (2Captcha or CapMonster, through the 2Captcha-compatible REST API) and return the solution. Requires the `captcha` capability (off by default). Solving captchas may break the target site's terms of service, and the operator carries that exposure; to have a person clear it instead, use `await_human`. Provider config is environment variables: `BROWX_CAPTCHA_PROVIDER` (`2captcha` or `capmonster`), `BROWX_CAPTCHA_API_KEY`, and optionally `BROWX_CAPTCHA_API_BASE` (an https URL; plain http only for localhost), `BROWX_CAPTCHA_TIMEOUT_MS` and `BROWX_CAPTCHA_POLL_MS`. browxai bundles no solver and buys no credits: with the capability on and no provider configured, the call returns `ok:false` with a `no provider configured` hint. For widget captchas (`recaptcha2`, `recaptcha3`, `hcaptcha`, `turnstile`) give `siteKey`, or `selector` (the server reads `data-sitekey` from that element). For `image`, give `imageBase64` (raw base64, no data URL prefix). Returns `{ok, provider, solution, taskId, elapsedMs}`. The solution is not submitted for you: type it into the hidden field or call the page's callback yourself.",
      inputSchema: {
        type: z
          .enum(["recaptcha2", "recaptcha3", "hcaptcha", "turnstile", "image"])
          .describe(
            "Captcha kind. `recaptcha2` = checkbox or invisible v2; `recaptcha3` = score-based v3; `hcaptcha` = hCaptcha widget; `turnstile` = Cloudflare Turnstile; `image` = base64 image upload (caller provides `imageBase64`).",
          ),
        selector: z
          .string()
          .optional()
          .describe(
            "CSS selector for the captcha widget element on the current page. When given, the server reads `data-sitekey` (or equivalent) from the element to populate `siteKey`. Either `selector` or `siteKey` is required for widget captchas.",
          ),
        siteKey: z
          .string()
          .optional()
          .describe(
            "Explicit site-key for the captcha widget (alternative to `selector`). Required for widget captchas when `selector` is not given.",
          ),
        imageBase64: z
          .string()
          .optional()
          .describe(
            "Raw base64-encoded image bytes (no `data:image/...;base64,` prefix). Required for `image` type; ignored for widget types.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({
      type,
      selector,
      siteKey,
      imageBase64,
      session,
    }: {
      type: CaptchaType;
      selector?: string;
      siteKey?: string;
      imageBase64?: string;
      session?: string;
    }) => {
      const g = gateCheck("solve_captcha");
      if (g) return g;
      // Resolve provider config fresh per call so an operator can rotate creds
      // via env without restarting (env is the source of truth).
      const cfg = resolveCaptchaProvider(process.env);
      if (!cfg.ok) {
        if (cfg.reason === "unconfigured") return captchaJsonResult(unconfiguredFailure());
        return captchaJsonResult({
          ok: false,
          provider: null,
          error: cfg.error ?? "captcha provider config is incomplete",
          hint: "Set BROWX_CAPTCHA_PROVIDER and BROWX_CAPTCHA_API_KEY together. browxai does NOT bundle a solver and does NOT auto-purchase credits.",
        });
      }
      const e = await entryFor(session);
      // The scope the provider is told to solve against. Read through the target
      // port, so an engine with no Playwright Page answers from its own client.
      let pageUrl: string;
      try {
        pageUrl = await targetFor(e).url();
      } catch {
        return captchaJsonResult({
          ok: false,
          provider: cfg.config.provider,
          error: "session has no active page",
          hint: "Call open_session + navigate first.",
        });
      }
      // Resolve siteKey: explicit > selector-derived. For `image` neither is
      // needed (imageBase64 is the payload).
      let resolvedSiteKey = siteKey;
      if (!resolvedSiteKey && selector && type !== "image") {
        const read = pageForSiteKeyRead(e.session, cfg.config.provider);
        if ("refusal" in read) return read.refusal;
        resolvedSiteKey = await readSiteKeyFromSelector(read.page, selector);
        if (!resolvedSiteKey) {
          return captchaJsonResult({
            ok: false,
            provider: cfg.config.provider,
            error: `solve_captcha: could not read a site-key attribute from selector "${selector}"`,
            hint: "Pass `siteKey` explicitly, or pass a `selector` that points at an element carrying `data-sitekey` (the standard reCAPTCHA / hCaptcha / Turnstile widget attribute).",
          });
        }
      }
      const result = await submitToProvider(
        {
          type,
          pageUrl,
          ...(resolvedSiteKey ? { siteKey: resolvedSiteKey } : {}),
          ...(imageBase64 ? { imageBase64 } : {}),
        },
        cfg.config,
      );
      // Mask the solution through the per-session secrets registry so a
      // solver-issued token containing a registered value (unlikely but
      // defensible) doesn't bypass the egress layer.
      const masked = e.secrets.applyMaskDeep(result);
      const body = { ...masked, tokensEstimate: estimateTokens(JSON.stringify(masked)) };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  // ---------- credentials hook (capability `credentials`) ----------
  //
  // Pluggable TOTP / username+password lookup against an operator-configured
  // vault. Off-by-default; loud-warned at boot. Provider is per-deployment,
  // NEVER bundled. `get_credential` ADDITIONALLY requires the `secrets`
  // capability (auto-registers the looked-up password into the secrets-mask
  // registry under `<PASSWORD_<account>>` — without `secrets`, the lookup
  // refuses rather than leak cleartext into the result).

  register(
    "get_totp",
    {
      capability: "credentials",
      description:
        "Get a one-time TOTP code from the deployment's credentials vault. Requires the `credentials` capability (off by default). The provider comes from `BROWX_CREDENTIALS_PROVIDER`: `oathtool` (default; seeds from env or file), or `1password`, `bitwarden` or `lastpass` through their CLIs, which the operator installs. Returns `{ok, code, provider}`, or `{ok:false, error, hint, provider}` (missing seed, CLI not on PATH, CLI not logged in; the hint says which). The code is returned in clear and is not masked, because it is single-use and short-lived: pass it straight to `fill({value: code})`. Pair with `get_credential` for the password.",
      inputSchema: {
        account: z
          .string()
          .describe(
            "What identifies the account depends on the provider: oathtool a key from `BROWX_OATHTOOL_SEEDS`; 1password, bitwarden and lastpass an item name or id. Starts with a letter or digit; letters, digits, space and `. _ @ + : / -` only; max 128 characters.",
          ),
      },
    },
    async ({ account }: { account: string }) => {
      const g = gateCheck("get_totp");
      if (g) return g;
      const bad = accountError(account);
      if (bad) return accountRefusal(credentialsResolved.config.provider, bad);
      const result = await credentialsResolved.provider.getTotp(account);
      const body = {
        ...result,
        tokensEstimate: estimateTokens(JSON.stringify(result)),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );

  register(
    "get_credential",
    {
      capability: "credentials",
      description:
        'Look up a `{username, password}` pair from the deployment\'s credentials vault without returning the password. Requires the `credentials` capability and also the `secrets` capability (both off by default); without `secrets` it refuses, since a cleartext password would land in the transcript. The password is registered as a secret named `<PASSWORD_<account>>` (account sanitised to `/^[A-Z][A-Z0-9_]*$/`) and bound to the origins listed for that account in `BROWX_CREDENTIAL_ORIGINS` (`acct=https://a.example.com|https://b.example.com`, read at start, so restart after changing it). An account with no entry is refused before the vault is asked. Then `fill({value:"<PASSWORD_acct>"})` types the real value, only into a frame on one of those origins. Returns `{ok, username, aliasName, origins, provider}`, never the password. The `oathtool` provider is TOTP-only and does not support this tool. Pair with `get_totp` for the second factor.',
      inputSchema: {
        account: z
          .string()
          .describe(
            "What identifies the account depends on the provider: 1password an item name, bitwarden an item id, lastpass an item name. Starts with a letter or digit; letters, digits, space and `. _ @ + : / -` only; max 128 characters.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ account, session }: { account: string; session?: string }) => {
      const g = gateCheck("get_credential");
      if (g) return g;
      const provider = credentialsResolved.config.provider;
      // oathtool keeps TOTP seeds only, so a password lookup can never succeed.
      if (provider === "oathtool") return accountRefusal(provider, oathtoolCredentialError());
      // Without `secrets` the password could not be masked, so the lookup refuses
      // here, before the vault is asked.
      if (capabilityMissing("secrets", caps))
        return accountRefusal(provider, SECRETS_REQUIRED_ERROR);
      const bad = accountError(account);
      if (bad) return accountRefusal(provider, bad);
      // The password is bound to the origins the operator listed for this
      // account. An unlisted account is refused here, before the vault is asked.
      const origins = listedOrigins(credentialsResolved.config.origins, account);
      if (!origins) return accountRefusal(provider, unlistedAccountError(account));
      const e = await entryFor(session);
      const raw = (await credentialsResolved.provider.getCredential(
        account,
      )) as ProviderCredentialInternal;
      // `applyCredentialToRegistry` strips `_password` before the result leaves
      // this module — so the response we serialise never contains cleartext.
      const result = applyCredentialToRegistry(raw, e.secrets, account, origins);
      const body = {
        ...result,
        tokensEstimate: estimateTokens(JSON.stringify(result)),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );
}
