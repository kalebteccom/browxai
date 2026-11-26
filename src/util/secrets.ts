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
import {
  formatOrigin,
  originOf,
  parseScope,
  scopeMatches,
  type ScopeOrigin,
} from "./secret-scope.js";
import { docsUrl } from "./docs-links.js";
import { secretForms } from "./secret-forms.js";

export { ENCODED_FORM_MIN_LENGTH } from "./secret-forms.js";

/** A registered secret. `name` is the agent-facing alias (`PASSWORD`),
 *  `value` the real string that gets substituted in/out, and optional
 *  `scope` narrows substitution at dispatch (a real value scoped to
 *  `https://app.example.com` won't be materialised into a `fill` on a
 *  different origin's frame, even if the agent passes `<PASSWORD>`). */
export interface SecretEntry {
  name: string;
  value: string;
  /** Optional origin, or list of origins (see `secret-scope.ts` for the
   *  accepted forms). Dispatch materialises the value only into a frame whose
   *  origin equals one of them exactly. Masking-on-egress is global (any sink,
   *  any origin): narrowing only the *write* side keeps the read-side
   *  guarantee absolute. */
  scope?: string | readonly string[];
}

/**
 * Per-session secrets registry. Bounded (32 secrets) to keep the per-sink
 * scan O(secrets × text-len) sane; the realistic upper bound for an auth
 * flow is small (password, OTP, maybe a couple of token-like values).
 */
export class SecretRegistry {
  private byName = new Map<string, SecretEntry>();
  /** Parsed scope origins per scoped name. Absent for an unscoped secret. */
  private originsByName = new Map<string, ScopeOrigin[]>();
  /** Every form a registered value is masked in, longest first. Built on the
   *  first mask after a registration, so the scan never re-encodes values. */
  private formsCache: MaskForm[] | null = null;
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
          `(uppercase letters, digits and underscores, e.g. PASSWORD, OTP or SESSION_TOKEN), ` +
          `so the \`<NAME>\` mask is unambiguous.`,
      );
    }
    if (typeof entry.value !== "string" || entry.value.length === 0) {
      throw new Error("register_secret: value must be a non-empty string");
    }
    let origins: ScopeOrigin[] | undefined;
    if (entry.scope !== undefined) {
      try {
        origins = parseScope(entry.scope);
      } catch (e) {
        throw new Error(`register_secret: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!this.byName.has(entry.name) && this.byName.size >= this.cap) {
      throw new Error(
        `register_secret: capacity ${this.cap} reached. Close the session or restart ` +
          `the server to clear secrets before registering more.`,
      );
    }
    this.byName.set(entry.name, { ...entry });
    this.formsCache = null;
    if (origins) this.originsByName.set(entry.name, origins);
    else this.originsByName.delete(entry.name);
    if (!this.warnedOnce) {
      // Mirrors the eval / network-body / disableWebSecurity loud-warn posture
      // (docs/threat-model.md "Loud one-time warnings"). The `secrets`
      // capability is off by default; once registered, the egress-masking
      // layer is engaged for the lifetime of the session.
      log.warn(
        "a secret was registered: its value is now masked in tool output, but screenshots are not masked (see " +
          docsUrl.toolReferenceSecrets +
          "). Remove secrets from BROWX_CAPABILITIES to turn it off.",
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

  /** The longest form the mask matches, less one; 0 when nothing is
   *  registered. A value that starts before a cut at `n` ends before
   *  `n + maskSlack()`, so a sink that masks `n + maskSlack()` characters
   *  before cutting at `n` masks every value the cut crosses. The forms
   *  themselves stay private. */
  maskSlack(): number {
    const longest = this.maskForms()[0];
    return longest ? longest.form.length - 1 : 0;
  }

  /** The normalised origins a secret is scoped to (`https://app.example.com`),
   *  or null when it is unscoped or unknown. Never exposes the value. */
  scopeOrigins(name: string): string[] | null {
    const origins = this.originsByName.get(name);
    return origins ? origins.map(formatOrigin) : null;
  }

  /** True when `value` is a `<NAME>` alias of a registered, scoped secret, so
   *  the caller has to resolve the frame that receives it before calling
   *  `materialize`. Plain strings and unscoped aliases answer false. */
  needsScopeCheck(value: string): boolean {
    const m = /^<([A-Z][A-Z0-9_]*)>$/.exec(value);
    return !!m && this.originsByName.has(m[1]!);
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
   * `targetUrl` is the URL of the frame that receives the value. It is
   * consulted only when an entry has a `scope`: unless the frame's origin
   * equals one of the scope's origins exactly (scheme, host and port), the
   * materialisation is REFUSED (returns ok:false), so the real value only
   * reaches the origins it was registered for.
   */
  materialize(value: string, targetUrl: string): MaterialiseResult {
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
          `"${name}" is registered on this session. Call register_secret({name,value}) first.`,
      };
    }
    const origins = this.originsByName.get(name);
    if (origins && !scopeMatches(origins, targetUrl)) {
      const scoped = origins.map((o) => `"${formatOrigin(o)}"`).join(", ");
      const at = originOf(targetUrl) ?? "a frame with no origin to match";
      return {
        ok: false,
        materialised: false,
        value,
        error:
          `secret "<${name}>" is scoped to ${scoped} but the frame receiving it is ` +
          `at "${at}". The origin must match exactly (scheme, host and port); ` +
          `refusing to substitute. Navigate to the scoped origin first, or ` +
          `re-register with the origin this field lives on.`,
      };
    }
    return { ok: true, materialised: true, value: entry.value, alias: name };
  }

  /** Egress-side: scan `text` for any registered real-value and rewrite each
   *  occurrence to `<NAME>`. No-op when the registry is empty (the common
   *  case — secrets is opt-in). Pure string replacement; safe to apply
   *  multiple times (idempotent — `<NAME>` doesn't contain any registered
   *  value, so won't re-match). Order: longest form first, so a value
   *  that's a substring of another doesn't leave a partial leak.
   *
   *  Besides the value itself, a value of at least `ENCODED_FORM_MIN_LENGTH`
   *  characters is matched in its percent-encoded forms (`encodeURIComponent`
   *  and the form-body `+`-for-space form) and its base64 and base64url
   *  encodings, all in this one pass. The value must be encoded on its own: a
   *  base64 of a larger string (`Authorization: Basic base64(user:pass)`) does
   *  not contain the value's own base64 and is not masked.
   *
   *  A value holding a character that JSON or HTML escaping rewrites is also
   *  matched as those encoders write it (`secret-forms.ts` lists the forms),
   *  so it is masked inside a string that itself holds JSON or markup. */
  applyMaskInText(text: string): string {
    if (this.byName.size === 0 || !text) return text;
    let out = text;
    for (const { name, form } of this.maskForms()) {
      // String split/join — no regex, so secret values containing regex
      // metacharacters (e.g. `+`, `(`, `.`) work without escaping.
      if (out.includes(form)) {
        out = out.split(form).join(`<${name}>`);
      }
    }
    return out;
  }

  /** Egress-side, for one whole tool-result text item, which is usually a
   *  JSON document. Masking JSON text as a plain string would miss a value
   *  that JSON encoding changed (a `"` or `\` in it) and could break the document, so
   *  JSON is parsed, its string leaves, object keys and any number whose
   *  digits carry a value are masked, and it is serialised again in the same
   *  layout (two-space indent or compact). Non-JSON text gets
   *  `applyMaskInText`.
   *
   *  Fast path: text that contains no form of a registered value, as it is or
   *  JSON-encoded, comes back untouched with no parse, which is the case for
   *  every result a sink already masked. That also makes the method
   *  idempotent. */
  applyMaskInResultText(text: string): string {
    if (this.byName.size === 0 || !text) return text;
    const hit = this.maskForms().some(
      (f) => text.includes(f.form) || (f.inJson !== undefined && text.includes(f.inJson)),
    );
    if (!hit) return text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text, (_key, v: unknown) => this.maskJsonNode(v));
    } catch {
      return this.applyMaskInText(text);
    }
    return JSON.stringify(parsed, null, /^[[{]\r?\n/.test(text) ? 2 : undefined);
  }

  /** One `JSON.parse` reviver step. Children are already masked when their
   *  parent is visited, so each node only handles its own strings. */
  private maskJsonNode(v: unknown): unknown {
    if (typeof v === "string") return this.applyMaskInText(v);
    if (typeof v === "number") return this.maskJsonNumber(v);
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (!keys.some((k) => this.containsAnySecret(k).hit)) return v;
    return Object.fromEntries(keys.map((k) => [this.applyMaskInText(k), obj[k]]));
  }

  /** A JSON number cannot hold `<NAME>`. A number whose digits contain a
   *  registered value, as the whole number or part of it, is replaced as a
   *  whole by the string `"<NAME>"` (the longest matching value's alias), so
   *  no digits beside the value are left to narrow it down. The field's type
   *  changes from number to string in that case only; every other number
   *  stays a number. */
  private maskJsonNumber(v: number): unknown {
    const digits = String(v);
    const hit = this.maskForms().find((f) => digits.includes(f.form));
    return hit ? `<${hit.name}>` : v;
  }

  /** Convenience: mask the string fields of an object/array, at any depth.
   *  Object keys are masked like strings. A number is replaced by the string
   *  `"<NAME>"` when its decimal digits contain a registered value of at least
   *  `DIGIT_VALUE_MIN_LENGTH` characters made only of digits; shorter values
   *  would match ordinary counts and sizes. Other leaves pass through. Returns
   *  a new object — the input is not mutated.
   *
   *  There is no depth cap, and there must not be one. A cap here is not a
   *  safety bound, it is a leak: the previous `depth > 8` guard returned the
   *  sub-tree VERBATIM, so a registered value sitting deeper than 8 reached
   *  the sink in cleartext — the exact inverse of what register_secret
   *  promises. It is reachable: `verify_predicate` lifts `failure.actual`
   *  out of a caller-supplied `data` bag typed `z.record(z.string(), z.unknown())`, and
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
    // Masking rewrites leaves and keys only, so the result has the same shape
    // as the input (a masked number becomes a string). The walk runs on
    // `unknown` (every branch narrows with a real runtime check); the single
    // `as T` is that shape-preserving contract.
    if (this.byName.size === 0) return obj;
    return this.maskValue(obj) as T;
  }

  /** Iterative deep-copy-with-masking. `seen` maps each input node to the
   *  masked node standing in for it; the entry is recorded BEFORE that node's
   *  children are queued, which is what makes a self-reference resolvable. */
  private maskValue(root: unknown): unknown {
    if (typeof root === "string") return this.applyMaskInText(root);
    if (typeof root === "number") return this.maskDeepNumber(root);
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
      if (typeof v === "number") return this.maskDeepNumber(v);
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
        rec[this.applyMaskInText(k)] = childOf(v);
      }
    }
    return out;
  }

  /** `applyMaskDeep`'s number rule: only an all-digit registered value of at
   *  least `DIGIT_VALUE_MIN_LENGTH` characters is looked for in the number's
   *  decimal form. */
  private maskDeepNumber(v: number): unknown {
    const digits = String(v);
    let hit: SecretEntry | undefined;
    for (const entry of this.byName.values()) {
      const { value } = entry;
      if (value.length < DIGIT_VALUE_MIN_LENGTH || !/^[0-9]+$/.test(value)) continue;
      if (digits.includes(value) && (!hit || value.length > hit.value.length)) hit = entry;
    }
    return hit ? `<${hit.name}>` : v;
  }

  /** Best-effort detection: does `text` contain any registered real-value?
   *  Used by the screenshot tool's text-content sweep to decide whether to
   *  emit the "screenshot may reveal registered secret values" warning. */
  containsAnySecret(text: string): { hit: boolean; names: string[] } {
    if (this.byName.size === 0 || !text) return { hit: false, names: [] };
    const names: string[] = [];
    for (const { name, form } of this.maskForms()) {
      if (text.includes(form) && !names.includes(name)) names.push(name);
    }
    return { hit: names.length > 0, names };
  }

  /** Every (name, form) pair the mask matches, longest form first. */
  private maskForms(): MaskForm[] {
    if (this.formsCache) return this.formsCache;
    const forms: MaskForm[] = [];
    for (const { name, value } of this.byName.values()) {
      for (const form of secretForms(value)) {
        const inJson = jsonEncoded(form);
        forms.push(inJson === form ? { name, form } : { name, form, inJson });
      }
    }
    forms.sort((a, b) => b.form.length - a.form.length);
    this.formsCache = forms;
    return forms;
  }
}

/** Shortest all-digit registered value `applyMaskDeep` looks for inside a
 *  number. */
const DIGIT_VALUE_MIN_LENGTH = 6;

/** One string the mask replaces with `<name>`. */
interface MaskForm {
  name: string;
  form: string;
  /** `form` as a JSON string literal holds it, when that differs. A result
   *  text is JSON, so a form with a quote or backslash sits in it this way. */
  inJson?: string;
}

/** A value as it appears inside a JSON string literal. */
function jsonEncoded(value: string): string {
  return JSON.stringify(value).slice(1, -1);
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
