// Capture-time redaction for the replay log (RFC 0007 "Privacy"). Every event
// passes through here before it reaches the artifact writer, and an HTTP body
// and a WS frame payload take the SAME code path — a stream that echoes the
// auth blob the client sent is the same disclosure as the POST that sent it.
//
// Two mechanisms, deliberately distinguishable in the artifact:
//   - Registered secrets are masked to their `<NAME>` alias by the one masking
//     implementation in the codebase, `SecretRegistry.applyMaskDeep`. The alias
//     IS the "something was here" record, and reusing the single chokepoint is
//     what the threat model rests on — a second implementation would be a
//     second thing to keep correct.
//   - Header rules and body-path rules replace the value with a `Redacted`
//     marker. The key stays, so a reviewer can tell "nothing was there" from
//     "something was taken out".

import type { SecretRegistry } from "../util/secrets.js";
import type { MaybeRedacted, Redacted, ReplayEvent } from "./schema.js";

export const DEFAULT_DROPPED_HEADERS: readonly string[] = ["authorization", "cookie", "set-cookie"];

/** Body-path token that matches the body itself — `bodyPaths: ["$"]` drops
 *  every body and frame payload wholesale. */
export const ROOT_PATH = "$";

/** Bodies above this size are not parsed for path rules (the secret mask still
 *  runs over them). Mirrors the network slice's own parse ceiling. */
export const MAX_BODY_BYTES_TO_PARSE = 256_000;

const MAX_PATH_DEPTH = 16;

export interface RedactionConfig {
  /** Header names, case-insensitive. Replaces `DEFAULT_DROPPED_HEADERS` when
   *  supplied — spread it to extend rather than replace. */
  headers?: readonly string[];
  /** Dot-separated JSON paths into a body / frame payload. `*` matches any key
   *  or array index; `"$"` matches the whole body. */
  bodyPaths?: readonly string[];
  secrets?: SecretRegistry | null;
}

export function redactedMarker(reason: Redacted["reason"]): Redacted {
  return { redacted: true, reason };
}

export class Redactor {
  private readonly dropHeaders: ReadonlySet<string>;
  private readonly paths: readonly string[][];
  private readonly dropWholeBody: boolean;
  private readonly secrets: SecretRegistry | null;

  constructor(cfg: RedactionConfig = {}) {
    this.dropHeaders = new Set(
      (cfg.headers ?? DEFAULT_DROPPED_HEADERS).map((h) => h.toLowerCase()),
    );
    const paths = cfg.bodyPaths ?? [];
    this.dropWholeBody = paths.includes(ROOT_PATH);
    this.paths = paths.filter((p) => p !== ROOT_PATH).map((p) => p.split("."));
    this.secrets = cfg.secrets ?? null;
  }

  /** Registered-secret masking. Thin pass-through to `applyMaskDeep` so the
   *  codebase keeps exactly one masking implementation. */
  mask<T>(value: T): T {
    return this.secrets ? this.secrets.applyMaskDeep(value) : value;
  }

  headers(
    h: Readonly<Record<string, string>> | undefined,
  ): Record<string, MaybeRedacted<string>> | undefined {
    if (!h) return undefined;
    const out: Record<string, MaybeRedacted<string>> = {};
    for (const [k, v] of Object.entries(h)) {
      out[k] = this.dropHeaders.has(k.toLowerCase()) ? redactedMarker("header") : this.mask(v);
    }
    return out;
  }

  /** An HTTP body or a WS/SSE frame payload — one rule for both tiers. */
  payload(raw: string): MaybeRedacted<string>;
  payload(raw: string | undefined): MaybeRedacted<string> | undefined;
  payload(raw: string | undefined): MaybeRedacted<string> | undefined {
    if (raw === undefined) return undefined;
    if (this.dropWholeBody) return redactedMarker("body-rule");
    const masked = this.mask(raw);
    if (this.paths.length === 0 || masked.length > MAX_BODY_BYTES_TO_PARSE) return masked;
    const parsed = parseJson(masked);
    if (parsed === undefined) return masked;
    return JSON.stringify(this.applyPaths(parsed));
  }

  private applyPaths(value: unknown): unknown {
    let out = value;
    for (const segs of this.paths) out = redactAt(out, segs, 0);
    return out;
  }
}

/** Mask an assembled event. Called on every source adapter's output, so a
 *  registered secret cannot reach the log through a field no adapter knows
 *  about — the pass-through extras included. */
export function redactEvent<P>(ev: ReplayEvent<P>, redact: Redactor): ReplayEvent<P> {
  return { ...ev, payload: redact.mask(ev.payload) };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function redactAt(value: unknown, segs: readonly string[], i: number): unknown {
  if (i >= segs.length || i > MAX_PATH_DEPTH) return value;
  if (value === null || typeof value !== "object") return value;
  const seg = segs[i]!;
  const last = i === segs.length - 1;
  const step = (v: unknown): unknown =>
    last ? redactedMarker("body-rule") : redactAt(v, segs, i + 1);
  if (Array.isArray(value)) {
    const arr: unknown[] = value;
    return arr.map((el, idx) => (seg === "*" || seg === String(idx) ? step(el) : el));
  }
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    if (seg === "*" || seg === k) out[k] = step(out[k]);
  }
  return out;
}
