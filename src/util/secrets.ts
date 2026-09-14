// Per-session sensitive-data masking. Pairs with the URL sanitiser at the
// same egress boundary — both layers apply.
//
// Why it exists: browxai transcripts are shareable (adoption reports, GitHub
// issue repros, eval datasets). An auth flow whose `fill({value:"hunter2"})`
// arg, ActionResult, snapshot, console line, or WS frame echoes the real
// password makes the transcript radioactive. The browser-use precedent:
// the agent sees `<PASSWORD>`, the runtime substitutes the real value at
// dispatch — so the password reaches the page, never the agent.
//
// Shape: the agent registers a secret with an alias name (`PASSWORD`, `OTP`)
// and a real value. From then on:
//   - `fill({value:"<PASSWORD>"})` / `press({key:"<OTP>"})` materialise the
//     real value AT DISPATCH time (between the registry and Playwright).
//   - Every egress sink that could carry the real value (network urls + frame
//     payloads, console text, snapshot trees, find evidence) is scanned for
//     the real value and rewrites occurrences back to `<PASSWORD>` before
//     leaving the server.
//
// Sanitiser composition: the URL sanitiser is regex-based on URLs;
// secrets-masking is literal-substring across arbitrary strings. They don't
// fight — apply secrets-masking AFTER the URL sanitiser at each sink (the
// URL sanitiser may have already redacted `?token=…`; the literal-value scan
// still catches a secret that landed in a path / payload / header value).

import { log } from "./logging.js";

/** A registered secret. `name` is the agent-facing alias (`PASSWORD`),
 *  `value` the real string that gets substituted in/out, and optional
 *  `scope` narrows substitution at dispatch (a real value scoped to
 *  `https://app.example.com` won't be materialised into a `fill` on a
 *  different origin's page, even if the agent passes `<PASSWORD>`). */
export interface SecretEntry {
  name: string;
  value: string;
  /** Optional URL substring (case-insensitive) — only applied at dispatch
   *  when the current page URL contains it. Masking-on-egress is global
   *  (any sink, any origin) — narrowing only the *write* side keeps the
   *  read-side guarantee absolute. */
  scope?: string;
}

/**
 * Per-session secrets registry. Bounded (32 secrets) to keep the per-sink
 * scan O(secrets × text-len) sane; the realistic upper bound for an auth
 * flow is small (password, OTP, maybe a couple of token-like values).
 */
export class SecretRegistry {
  private byName = new Map<string, SecretEntry>();
  private warnedOnce = false;

  constructor(private cap = 32) {}

  /** Register or replace a secret by name. Names must match `^[A-Z][A-Z0-9_]*$`
   *  — uppercase identifier, no whitespace, no angle brackets — so the
   *  `<NAME>` mask is unambiguous. An empty `value` is rejected (would mask
   *  the empty string everywhere and produce nothing useful). */
  register(entry: SecretEntry): void {
    if (!/^[A-Z][A-Z0-9_]*$/.test(entry.name)) {
      throw new Error(
        `register_secret: name "${entry.name}" must match /^[A-Z][A-Z0-9_]*$/ ` +
          `(uppercase identifier, e.g. PASSWORD / OTP / SESSION_TOKEN) — the ` +
          `\`<NAME>\` mask format is the stable contract for agents to recognise.`,
      );
    }
    if (typeof entry.value !== "string" || entry.value.length === 0) {
      throw new Error("register_secret: value must be a non-empty string");
    }
    if (!this.byName.has(entry.name) && this.byName.size >= this.cap) {
      throw new Error(
        `register_secret: capacity ${this.cap} reached — remove an existing ` +
          `secret (close_session or restart) before registering more`,
      );
    }
    this.byName.set(entry.name, { ...entry });
    if (!this.warnedOnce) {
      // Mirrors the eval / network-body / disableWebSecurity loud-warn posture
      // (docs/threat-model.md "Loud one-time warnings"). The `secrets`
      // capability is off by default; once registered, the egress-masking
      // layer is engaged for the lifetime of the session.
      log.warn(
        "browxai: secrets capability is ENABLED — a sensitive value was registered. " +
          "All egress sinks (ActionResult.network, network_read, network_body, " +
          "ws_read, console_read, snapshot, find) now strip occurrences of the " +
          "registered value and substitute `<NAME>` aliases. `fill`/`press` " +
          "materialise `<NAME>` to the real value at dispatch time. The " +
          "`screenshot` tool is a partial sink — see docs/tool-reference.md.",
      );
      this.warnedOnce = true;
    }
  }

  /** List registered secret names (NEVER values). Useful for the
   *  registration tool's confirmation reply + the per-action warning that
   *  fires when a screenshot's page-text reveals one. */
  names(): string[] {
    return [...this.byName.keys()];
  }

  size(): number {
    return this.byName.size;
  }

  /** Look up an entry by name. Internal — callers go through `materialize`
   *  or `applyMask` so the real value never escapes this module by accident. */
  private lookup(name: string): SecretEntry | undefined {
    return this.byName.get(name);
  }

  /**
   * Dispatch-side: turn `<NAME>` (with optional surrounding whitespace OK,
   * but the contract is exact `<NAME>`) into the real value, for `fill` /
   * `press`. Strings that are NOT `<NAME>`-shaped pass through unchanged —
   * the substitution is conservative on purpose so a plain string containing
   * angle brackets stays a plain string.
   *
   * Returns the materialised string + a flag for the caller to label
   * the dispatched-action descriptor (so the ActionResult records that a
   * masked value was sent, not the value itself).
   *
   * `pageUrl` is consulted only when an entry has a `scope`; if scope is set
   * and the current page URL doesn't contain it, the materialisation is
   * REFUSED (returns ok:false) — substituting a secret on a wrong-origin page
   * would leak it cross-site.
   */
  materialize(value: string, pageUrl: string): MaterialiseResult {
    const m = /^<([A-Z][A-Z0-9_]*)>$/.exec(value);
    if (!m) return { ok: true, materialised: false, value };
    const name = m[1]!;
    const entry = this.lookup(name);
    if (!entry) {
      return {
        ok: false,
        materialised: false,
        value,
        error:
          `value "<${name}>" looks like a secret alias but no secret named ` +
          `"${name}" is registered on this session — call register_secret({name,value}) first`,
      };
    }
    if (entry.scope && !pageUrl.toLowerCase().includes(entry.scope.toLowerCase())) {
      return {
        ok: false,
        materialised: false,
        value,
        error:
          `secret "<${name}>" is scoped to "${entry.scope}" but the current ` +
          `page URL doesn't contain it — refusing to substitute (would leak ` +
          `the value cross-origin). Navigate to the scoped origin first, or ` +
          `re-register without a scope.`,
      };
    }
    return { ok: true, materialised: true, value: entry.value, alias: name };
  }

  /** Egress-side: scan `text` for any registered real-value and rewrite each
   *  occurrence to `<NAME>`. No-op when the registry is empty (the common
   *  case — secrets is opt-in). Pure string replacement; safe to apply
   *  multiple times (idempotent — `<NAME>` doesn't contain any registered
   *  value, so won't re-match). Order: longest value first, so a value
   *  that's a substring of another doesn't leave a partial leak. */
  applyMaskInText(text: string): string {
    if (this.byName.size === 0 || !text) return text;
    let out = text;
    for (const { name, value } of this.entriesByValueLenDesc()) {
      if (!value) continue;
      // String split/join — no regex, so secret values containing regex
      // metacharacters (e.g. `+`, `(`, `.`) work without escaping.
      if (out.includes(value)) {
        out = out.split(value).join(`<${name}>`);
      }
    }
    return out;
  }

  /** Convenience: mask the string fields of an object/array, at any depth.
   *  Non-string leaves pass through. Returns a new object — the input is not
   *  mutated.
   *
   *  There is no depth cap, and there must not be one. A cap here is not a
   *  safety bound, it is a leak: the previous `depth > 8` guard returned the
   *  sub-tree VERBATIM, so a registered value sitting deeper than 8 reached
   *  the sink in cleartext — the exact inverse of what register_secret
   *  promises. It is reachable: `verify_predicate` lifts `failure.actual`
   *  out of a caller-supplied `data` bag typed `z.record(z.unknown())`, and
   *  the documented use is piping a prior snapshot or ActionResult back in.
   *
   *  What the cap was supposed to buy — no unbounded walk, no stack
   *  overflow — is bought properly instead:
   *    - `maskValue` walks an EXPLICIT heap stack, not the call stack, so
   *      input nesting depth cannot overflow. (Recursion here would: a
   *      recursive version dies around 3k levels of nesting, and a caller
   *      controls the nesting, so a cap-free recursive walk would just swap
   *      a leak for a RangeError.)
   *    - Masking only rewrites primitive string leaves. Strings, numbers,
   *      booleans, null and undefined all terminate the walk, so no
   *      value-shaped input drives it deeper than the input actually nests.
   *    - The one shape that walks forever is a cyclic object graph, and the
   *      `seen` map neutralises it: a node already visited resolves to its
   *      own masked copy, so a back-edge closes the cycle in the output
   *      instead of being re-descended. Work is therefore bounded by the
   *      number of DISTINCT nodes, which is finite for any input that fits
   *      in memory.
   *  `seen` also collapses a shared (non-cyclic) sub-tree to one masked
   *  copy, so a DAG costs one walk per node, not one per reference. */
  applyMaskDeep<T>(obj: T): T {
    // Masking only rewrites string leaves, so the result has the same structure
    // as the input. The walk runs on `unknown` (every branch narrows with a
    // real runtime check); the single `as T` is that structure-preserving contract.
    if (this.byName.size === 0) return obj;
    return this.maskValue(obj) as T;
  }

  /** Iterative deep-copy-with-masking. `seen` maps each input node to the
   *  masked node standing in for it; the entry is recorded BEFORE that node's
   *  children are queued, which is what makes a self-reference resolvable. */
  private maskValue(root: unknown): unknown {
    if (typeof root === "string") return this.applyMaskInText(root);
    if (!root || typeof root !== "object") return root;

    const seen = new WeakMap<object, unknown>();
    /** Allocate the masked counterpart of `src` and register it before its
     *  children are walked. */
    const shellFor = (src: object): unknown => {
      const shell: unknown = Array.isArray(src) ? [] : {};
      seen.set(src, shell);
      return shell;
    };
    /** Resolve one child value: mask a string, pass a non-object through, and
     *  for an object either reuse its already-allocated shell or allocate one
     *  and queue it for a later pass. */
    const pending: Array<{ src: object; dst: unknown }> = [];
    const childOf = (v: unknown): unknown => {
      if (typeof v === "string") return this.applyMaskInText(v);
      if (!v || typeof v !== "object") return v;
      const hit = seen.get(v);
      if (hit !== undefined) return hit;
      const shell = shellFor(v);
      pending.push({ src: v, dst: shell });
      return shell;
    };

    const out = shellFor(root);
    pending.push({ src: root, dst: out });
    while (pending.length > 0) {
      const { src, dst } = pending.pop()!;
      if (Array.isArray(src)) {
        const arr = dst as unknown[];
        for (const v of src) arr.push(childOf(v));
        continue;
      }
      const rec = dst as Record<string, unknown>;
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        rec[k] = childOf(v);
      }
    }
    return out;
  }

  /** Best-effort detection: does `text` contain any registered real-value?
   *  Used by the screenshot tool's text-content sweep to decide whether to
   *  emit the "screenshot may reveal registered secret values" warning. */
  containsAnySecret(text: string): { hit: boolean; names: string[] } {
    if (this.byName.size === 0 || !text) return { hit: false, names: [] };
    const names: string[] = [];
    for (const { name, value } of this.entriesByValueLenDesc()) {
      if (value && text.includes(value)) names.push(name);
    }
    return { hit: names.length > 0, names };
  }

  /** Internal: entries sorted by descending value-length, so longer values
   *  mask before their shorter prefixes / substrings. Recomputed each call —
   *  the registry is bounded (32) and only walked per egress sink, so the
   *  sort cost is negligible and a stale cache can never leak a partial value. */
  private entriesByValueLenDesc(): SecretEntry[] {
    const arr = [...this.byName.values()];
    arr.sort((a, b) => b.value.length - a.value.length);
    return arr;
  }
}

export interface MaterialiseResult {
  ok: boolean;
  /** True if `value` is the *real* secret (substituted from the alias);
   *  false if it was a plain string the registry didn't touch. Either way
   *  `value` is what the caller should pass to Playwright. */
  materialised: boolean;
  /** The string to dispatch — either the original (pass-through) or the
   *  registry's stored real value (when materialised). */
  value: string;
  /** Present when `materialised: true` — the alias name, so the dispatched-
   *  action descriptor can record `value:"<NAME>"` instead of the real value. */
  alias?: string;
  /** Present when `ok: false` — a clean error message the action handler
   *  surfaces back to the agent without dispatching. */
  error?: string;
}

/**
 * Compose with the URL sanitiser: apply secrets-masking AFTER URL sanitisation.
 * The two layers are independent — the URL sanitiser handles
 * query/fragment/userinfo/token-paths (regex on URL structure); secrets-
 * masking handles literal real-value substitution anywhere in the text.
 *
 * Helper exists so callers don't have to remember the ordering at every sink.
 */
export function composeUrlAndSecretsInText(
  text: string,
  urlSanitiser: (t: string) => string,
  registry: SecretRegistry | null,
): string {
  const afterUrl = urlSanitiser(text);
  if (!registry) return afterUrl;
  return registry.applyMaskInText(afterUrl);
}
