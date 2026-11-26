// Which tool-call arguments the replay log never records.
//
// `action/call` is emitted before the tool's handler runs, so the value passed
// to `register_secret` is not in the session's registry yet and the registry
// mask cannot catch it. The argument fields below are replaced with the
// `Redacted` marker when the event is built, so the value is never written to
// the intermediate log or the archive, whether the call then succeeds, is
// refused, or the process stops.
//
// Cookie values get the same treatment because the redactor already drops the
// `Cookie` and `Set-Cookie` headers by default.

import { redactedMarker } from "./redact.js";

interface UnrecordedArg {
  field: string;
  /** `always`: the field is replaced whatever it holds. `inline`: only a value
   *  that is not a string is replaced, for a field that takes either a
   *  workspace path (kept) or the data itself. */
  when: "always" | "inline";
}

/** Tool name to the argument fields that carry a secret value. */
export const UNRECORDED_ARGS: Readonly<Record<string, readonly UnrecordedArg[]>> = {
  register_secret: [{ field: "value", when: "always" }],
  cookies_set: [{ field: "value", when: "always" }],
  inject_storage_state: [{ field: "state", when: "inline" }],
  open_session: [{ field: "storageState", when: "inline" }],
};

/** How deep a call nested inside another call's arguments is followed. Past
 *  this the nested arguments are replaced whole. No registered tool nests this
 *  deep: `batch` refuses itself as an inner call. */
const MAX_NESTING = 8;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A `{ tool, args }` pair inside another call's arguments: an entry of
 *  `batch({ calls })`, or the `action` of `act_and_diff` and its siblings. */
function nestedCall(v: unknown, depth: number): unknown {
  if (!isRec(v) || typeof v.tool !== "string" || v.args === undefined) return v;
  const args =
    depth >= MAX_NESTING ? redactedMarker("secret") : recordableArgs(v.tool, v.args, depth + 1);
  return { ...v, args };
}

/**
 * The arguments of one tool call as the replay log records them. Returns a
 * copy with each secret-value field replaced by the `Redacted` marker, in the
 * call itself and in any call nested in its arguments. Anything that is not an
 * object is returned as given.
 */
export function recordableArgs(tool: string, args: unknown, depth = 0): unknown {
  if (!isRec(args)) return args;
  const out: Rec = { ...args };
  const rules = Object.hasOwn(UNRECORDED_ARGS, tool) ? (UNRECORDED_ARGS[tool] ?? []) : [];
  for (const rule of rules) {
    const value = out[rule.field];
    if (value === undefined) continue;
    if (rule.when === "inline" && typeof value === "string") continue;
    out[rule.field] = redactedMarker("secret");
  }
  if (Array.isArray(out.calls)) {
    const calls: unknown[] = out.calls;
    out.calls = calls.map((call) => nestedCall(call, depth));
  }
  if (out.action !== undefined) out.action = nestedCall(out.action, depth);
  return out;
}
