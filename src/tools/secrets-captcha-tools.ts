import {
  resolveCaptchaProvider,
  submitToProvider,
  unconfiguredFailure,
  type CaptchaType,
} from "../page/solve-captcha.js";
import { applyCredentialToRegistry, type ProviderCredentialInternal } from "../util/credentials.js";
import { estimateTokens } from "../util/tokens.js";
import type { ToolHost } from "./host.js";
import { SESSION_ARG } from "./schemas.js";

type CaptchaPage = ReturnType<Awaited<ReturnType<ToolHost["entryFor"]>>["session"]["page"]>;

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

/**
 * Secrets / captcha / credentials tools — the off-by-default egress-sensitive
 * seams: `register_secret` (the per-session secrets registry that backs egress
 * masking), `solve_captcha` (the provider-bridge), and `get_totp` /
 * `get_credential` (the credentials provider). Registered through the shared
 * `ToolHost` seam.
 */
export function registerSecretsCaptchaTools(host: ToolHost): void {
  const { z, register, gateCheck, entryFor, caps, credentialsResolved } = host;

  // ---------- secrets registry (capability `secrets`) ----------

  register(
    "register_secret",
    {
      capability: "secrets",
      description:
        'Register a sensitive value the agent will use without ever seeing the real string in any tool result. **Gated behind the off-by-default `secrets` capability** — same posture class as `eval` / `network-body` / `disableWebSecurity`. Pair: the agent calls `fill({value:"<NAME>"})` / `press({key:"<NAME>"})` and the runtime substitutes the registered real value AT dispatch (so the page receives the actual string), while EVERY egress sink — `ActionResult.network`, `network_read`, `network_body`, `ws_read`, `console_read`, `snapshot`, `find` evidence — strips occurrences of the real value back to `<NAME>` before returning to the agent. `name` must match `/^[A-Z][A-Z0-9_]*$/` (uppercase identifier — the `<NAME>` mask is the stable contract). Optional `scope` (URL substring, case-insensitive) narrows the *dispatch* side: a scoped secret won\'t be substituted into a `fill` whose page URL doesn\'t contain the scope (refuses with a clear error). Per-session registry, capped at 32 entries. `screenshot` is a PARTIAL sink: when the page\'s text content contains a registered value, a warning is appended; pixel-level redaction (region-blur) is deferred — call snapshot/find for verified-clean evidence instead. NEVER re-emits or logs the real value.',
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
          .string()
          .optional()
          .describe(
            "Optional URL substring (case-insensitive). When set, dispatch-side substitution refuses if the current page URL doesn't contain the scope (prevents cross-origin leak). Egress masking is global regardless.",
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
      scope?: string;
      session?: string;
    }) => {
      const g = gateCheck("register_secret");
      if (g) return g;
      const e = await entryFor(session);
      try {
        e.secrets.register({ name, value, ...(scope ? { scope } : {}) });
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
      const body = {
        ok: true,
        registered: name,
        scope: scope ?? null,
        // never echo the value back. Echo only the registered names — useful
        // for the agent to confirm what aliases are live without leaking.
        names: e.secrets.names(),
        tokensEstimate: estimateTokens(
          JSON.stringify({ ok: true, registered: name, scope, names: e.secrets.names() }),
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
        "Delegate a captcha challenge to a configured external provider (2Captcha / CapMonster / etc — provider speaks the 2Captcha-compatible REST API). **Gated behind the off-by-default `captcha` capability** — same posture class as `eval` / `network-body` / `secrets` / `extensions` / `stealth`. SOLVING CAPTCHAS MAY VIOLATE THE TARGET SITE'S TERMS OF SERVICE; the operator carries the legal exposure. " +
        "Provider config is per-deployment via environment variables: BROWX_CAPTCHA_PROVIDER (`2captcha` or `capmonster`) + BROWX_CAPTCHA_API_KEY; optional BROWX_CAPTCHA_API_BASE / BROWX_CAPTCHA_TIMEOUT_MS / BROWX_CAPTCHA_POLL_MS. **browxai does NOT bundle a solver and does NOT auto-purchase credits** — when the capability is on but no provider is configured the tool returns a structured `ok:false` with a clear `no provider configured` hint. " +
        "For widget captchas (`recaptcha2`, `recaptcha3`, `hcaptcha`, `turnstile`), supply the page's site-key via `siteKey` OR `selector` (when given, the server reads `data-sitekey` from the selected element on the current page). For `image`, supply `imageBase64` (raw base64, no data URL prefix). Returns `{ok, provider, solution, taskId, elapsedMs}` on success — the agent then types `solution` into the hidden form field / invokes the page's recaptcha callback. We do NOT auto-submit the solution; how to wire it into the page is per-site.",
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
      let pageUrl: string;
      try {
        pageUrl = e.session.page().url();
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
        resolvedSiteKey = await readSiteKeyFromSelector(e.session.page(), selector);
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
        "Look up a one-time TOTP code from the deployment's configured credentials vault. **Gated behind the off-by-default `credentials` capability** — same posture class as `eval` / `network-body` / `secrets`. Provider is selected per-deployment via `BROWX_CREDENTIALS_PROVIDER` (`oathtool` default — no paid dependency, seeds via env or file; or `1password` / `bitwarden` / `lastpass` via their respective CLIs the operator installs out-of-band). Returns `{ok, code, provider}` on success; `{ok:false, error, hint, provider}` on failure (missing seed / CLI not on PATH / CLI not logged in — actionable hint included). TOTP codes are NOT masked through the secrets registry: a TOTP is single-use and short-lived, so masking buys little while complicating verify-step flows — the code is returned in plaintext so the agent can pass it to `fill({value: code})` or compare against on-page text. `account` semantics depend on the provider (oathtool: a key from `BROWX_OATHTOOL_SEEDS`; 1password/bitwarden/lastpass: an item name / id the CLI accepts).",
      inputSchema: {
        account: z
          .string()
          .describe(
            "Provider-specific account identifier (oathtool seed key / 1password item name / bitwarden item id / lastpass item name).",
          ),
      },
    },
    async ({ account }: { account: string }) => {
      const g = gateCheck("get_totp");
      if (g) return g;
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
        'Look up a `{username, password}` pair from the deployment\'s configured credentials vault. **Gated behind the off-by-default `credentials` capability** AND additionally requires the `secrets` capability (without it the lookup refuses — returning a password in cleartext would leak it into the transcript on first reference). On success, the password is AUTO-REGISTERED into the per-session secrets registry under `<PASSWORD_<account>>` (account name sanitised to `/^[A-Z][A-Z0-9_]*$/`); the agent then passes `fill({value: "<PASSWORD_acct>"})` and the runtime materialises the real value AT Playwright dispatch. The returned object carries `{ok, username, aliasName, provider}` — **never the cleartext password**. Pair with `get_totp` for the 2FA half. `oathtool` provider does NOT support `get_credential` (TOTP-only) — pair with a credential-bearing provider. `account` semantics are provider-specific (1password: item name; bitwarden: item id; lastpass: item name).',
      inputSchema: {
        account: z
          .string()
          .describe(
            "Provider-specific account identifier — see the per-provider notes in docs/tool-reference.md.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ account, session }: { account: string; session?: string }) => {
      const g = gateCheck("get_credential");
      if (g) return g;
      const e = await entryFor(session);
      const raw = (await credentialsResolved.provider.getCredential(
        account,
      )) as ProviderCredentialInternal;
      // `applyCredentialToRegistry` enforces the `secrets`-capability
      // pairing rule and strips `_password` before the result leaves this
      // module — so the response we serialise never contains cleartext.
      const registry = caps.enabled.has("secrets") ? e.secrets : null;
      const result = applyCredentialToRegistry(raw, registry, account);
      const body = {
        ...result,
        tokensEstimate: estimateTokens(JSON.stringify(result)),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
    },
  );
}
