// Pluggable credentials / TOTP hook (capability `credentials`, off by default).
//
// Why it exists: agents driving real auth flows routinely block on 2FA or
// stored-credential vault lookups. Without a hook here, the only escapes are
// (a) bake the seed/password into the prompt — which leaks into transcripts
// and eval datasets, defeating the SecretRegistry masking — or (b) hand-fly
// the step every time. Substrate-tier solution: a thin provider abstraction
// that reads from a configured vault, with no provider bundled by default.
//
// This module is the barrel + SecretRegistry integration. The port contract
// (types, shell helper, alias/seed/JSON parsing) lives in
// `credentials-contract.js`; the five vendor adapters and provider
// resolution live in `credentials-providers.js`. Both of those are
// re-exported here so the public surface is importable from this path.
//
// Integration with SecretRegistry masking: `get_credential` does NOT echo
// the password back in cleartext. It auto-registers the password into the
// per-session SecretRegistry under an alias derived from the account name
// (`<PASSWORD_<account>>`), and the returned object carries the alias —
// the agent then uses `fill({value:"<PASSWORD_acct>"})` and Playwright
// receives the real value at dispatch via the registry's materialise path.
// The egress-masking layer also catches the value in every other sink.
// `get_totp` returns the 6-digit code directly (TOTPs are single-use and short-lived
// — the value is "spent" the moment it's typed, so masking buys little
// and complicates the agent's verify-step flow).

import { aliasFromAccount } from "./credentials-contract.js";
import type { CredentialResult, ProviderCredentialInternal } from "./credentials-contract.js";
import type { SecretRegistry } from "./secrets.js";

// Re-export the full public surface so importers keep using "./credentials.js".
export * from "./credentials-contract.js";
export * from "./credentials-providers.js";

// ---------------------------------------------------------------------------
// SecretRegistry integration
// ---------------------------------------------------------------------------

/**
 * Apply a credential lookup to the per-session secrets registry:
 * registers the password under an account-derived alias, then returns the
 * public credential shape (username + aliasName only, NEVER the password).
 *
 * Callers pass `registry` only when the `secrets` capability is enabled.
 * When it's not, the function returns a structured refusal — registering
 * a password without the egress-masking layer engaged would leak the
 * password into transcripts the first time the agent referenced it.
 */
export function applyCredentialToRegistry(
  result: ProviderCredentialInternal,
  registry: SecretRegistry | null,
  account: string,
  pageUrl?: string,
): CredentialResult {
  if (!result.ok) {
    // Surface refusal verbatim; never carries a password.
    return stripInternal(result);
  }
  if (!result._password || !result.username) {
    return {
      ok: false,
      provider: result.provider,
      error: "provider returned incomplete credential (missing username or password)",
    };
  }
  if (!registry) {
    return {
      ok: false,
      provider: result.provider,
      error:
        "credentials lookup refused: the `secrets` capability is not enabled. " +
        "Returning a password without secrets-masking would leak it into transcripts. " +
        "Add `secrets` to BROWX_CAPABILITIES alongside `credentials`, then restart.",
    };
  }
  const aliasName = aliasFromAccount(account);
  try {
    registry.register({
      name: aliasName,
      value: result._password,
      ...(pageUrl ? {} : {}),
    });
  } catch (e) {
    return {
      ok: false,
      provider: result.provider,
      error: `could not register password into secrets registry: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return {
    ok: true,
    provider: result.provider,
    username: result.username,
    aliasName,
  };
}

function stripInternal(r: ProviderCredentialInternal): CredentialResult {
  const { _password, ...rest } = r;
  return rest;
}
