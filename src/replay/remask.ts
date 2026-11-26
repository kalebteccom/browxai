// The end-of-recording mask pass over `events.jsonl`.
//
// Each event is masked when it is captured, with the registry as it stands at
// that moment. A value registered later is not in the events captured before
// it: a page that renders an API token, which the agent then reads and
// registers, has the token in its DOM snapshot already. So before the archive
// is written the whole log is masked once more with the registry as it stands
// at `end()`.
//
// The pass reads and rewrites the log in memory, one line at a time. It is
// skipped when the registry is empty, so a recording with no registered secret
// keeps its log byte for byte.

import { maskPostDataEntries } from "./net-fields.js";
import type { Redactor } from "./redact.js";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The base64 request body parts of a `net/request` event are opaque to the
 *  text mask, so they are decoded and masked again here. */
function remaskRequestBodyParts(event: Rec, redact: Redactor): void {
  if (event.type !== "net/request" || !isRec(event.payload)) return;
  const request = event.payload.request;
  if (!isRec(request) || request.postDataEntries === undefined) return;
  const entries = maskPostDataEntries(request.postDataEntries, (text) => redact.mask(text));
  if (entries) request.postDataEntries = entries;
}

function remaskLine(line: string, redact: Redactor): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Not JSON: mask it as plain text so the line is still covered.
    return redact.mask(line);
  }
  if (!isRec(parsed)) return redact.mask(line);
  const masked = redact.mask(parsed);
  remaskRequestBodyParts(masked, redact);
  return JSON.stringify(masked);
}

/**
 * Mask every event of a captured log with the registry as it stands now.
 * Returns the input itself when the registry holds no value.
 */
export function remaskEventLog(jsonl: Buffer, redact: Redactor): Buffer {
  if (!redact.hasSecrets) return jsonl;
  const lines: string[] = [];
  for (const line of jsonl.toString("utf8").split("\n")) {
    if (line === "") continue;
    lines.push(remaskLine(line, redact));
  }
  return Buffer.from(lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
}
