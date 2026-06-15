// RFC 0004 P3 / D4 (DRY) — the egress-masking chokepoint.
//
// Secrets-masking + URL-sanitisation was a *discipline*, not a *guarantee*: every
// output sink hand-called `composeUrlAndSecretsInText` / `applyMaskDeep` /
// `containsAnySecret`, each first deciding `caps.enabled.has("secrets")` inline,
// and a sink that forgot the call leaked. `EgressSanitiser` is the one object
// every sink masks through. The capability decision is made ONCE, at
// construction (a sink injected with a secrets-off sanitiser holds a null
// registry — URL-sanitisation still applies), so a sink no longer inlines the
// gate; it just calls `maskText` / `maskDeep`.
//
// This wraps the existing primitives verbatim (`SecretRegistry.applyMaskInText` /
// `applyMaskDeep` / `containsAnySecret` and `sanitizeUrlsInText`), in the audited
// order (URL pass first, then secrets) — so the masking behaviour is byte-identical
// to the prior hand-calls; only the *who-decides-and-when* moves.

import type { SecretRegistry } from "./secrets.js";
import { sanitizeUrlsInText } from "./url-sanitizer.js";

/** The single egress masking surface. Every client-facing output path masks
 *  through one of these. Constructed with the session's `SecretRegistry` when the
 *  `secrets` capability is on, or `null` when it is off — so the capability gate
 *  is an injection-time decision, not a per-sink inline check. URL-sanitisation
 *  applies regardless of the secrets registry (it is structural, not value-based). */
export class EgressSanitiser {
  constructor(private readonly secrets: SecretRegistry | null) {}

  /** Whether a real secrets registry is attached (the `secrets` capability is on
   *  AND at least one secret is registered). Lets a sink skip an expensive
   *  side-channel sweep (e.g. the screenshot page-text probe) when there is
   *  nothing to find. */
  get active(): boolean {
    return this.secrets !== null && this.secrets.size() > 0;
  }

  /** URL-sanitise then secrets-mask a single string, in the audited order. The
   *  composition `composeUrlAndSecretsInText` used to make every caller remember. */
  maskText(text: string): string {
    const afterUrl = sanitizeUrlsInText(text);
    return this.secrets ? this.secrets.applyMaskInText(afterUrl) : afterUrl;
  }

  /** Deep-mask the string leaves of a structured payload (secrets only — the
   *  structured masking the verify / JSON families used `applyMaskDeep` for).
   *  No-op when the registry is null/empty. */
  maskDeep<T>(value: T): T {
    return this.secrets ? this.secrets.applyMaskDeep(value) : value;
  }

  /** Best-effort detection: does `text` contain any registered real-value? The
   *  screenshot text-content sweep uses this to decide whether to warn. Returns
   *  no hit when no registry is attached. */
  containsAnySecret(text: string): { hit: boolean; names: string[] } {
    return this.secrets ? this.secrets.containsAnySecret(text) : { hit: false, names: [] };
  }
}
