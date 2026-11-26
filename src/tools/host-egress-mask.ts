// Tool output masks registered secrets. The `register` wrapper runs every tool
// result through `maskToolResponse` once, after the handler, so a tool family
// that never called the egress sanitiser (`extract`, `shadow_trees`,
// `cookies_get`, `idb_get`, `caches_get`, …) still returns `<NAME>` in place of
// a registered value. Sinks that already mask keep doing so; their output
// carries no registered value, so this pass leaves it untouched without
// parsing it.
//
// A handler that throws is masked too: the wrapper the MCP server calls turns
// the error into the SDK's error result and masks that (`maskedToolError`).
//
// Only text items are masked. Image items are pixels; `screenshot`'s page-text
// warning covers them. Result shapes are unchanged: an item is replaced only
// when its text changed.

import { addLogMask } from "../util/logging.js";
import type { SecretRegistry } from "../util/secrets.js";
import type { ToolResponse } from "./host.js";

/** The registries the wrapper masks with: every open session's that holds at
 *  least one value. All sessions, so a tool reporting on another session (or
 *  on none) is covered too. Empty when the `secrets` capability is off. */
export function activeSecretRegistries(
  secretsEnabled: boolean,
  entries: Iterable<{ secrets: SecretRegistry }>,
): SecretRegistry[] {
  if (!secretsEnabled) return [];
  const out: SecretRegistry[] = [];
  for (const e of entries) if (e.secrets.size() > 0) out.push(e.secrets);
  return out;
}

/** Mask registered values in every text item of a tool result. Returns `res`
 *  itself when nothing changed. Other fields (`isError`) are kept. */
export function maskToolResponse<T extends ToolResponse>(
  res: T,
  registries: readonly SecretRegistry[],
): T {
  if (registries.length === 0) return res;
  let changed = false;
  const content = res.content.map((item) => {
    if (item.type !== "text") return item;
    let text = item.text;
    for (const r of registries) text = r.applyMaskInResultText(text);
    if (text === item.text) return item;
    changed = true;
    return { ...item, text };
  });
  return changed ? { ...res, content } : res;
}

/** Mask registered values in one log entry. The logger's mask hook calls this
 *  with the same registries a tool result is masked with. A log entry is plain
 *  text with a JSON tail, so it is scanned as text and never parsed. */
export function maskLogText(text: string, registries: readonly SecretRegistry[]): string {
  let out = text;
  for (const r of registries) out = r.applyMaskInText(out);
  return out;
}

/** Make the stderr log mask with one server's registries: the same ones its
 *  tool results are masked with, read per entry, so a session opened later is
 *  covered. Returns the call that removes the mask, for the server's shutdown.
 *  Each server adds its own, so two servers in one process both stay masked. */
export function installLogMask(
  secretsEnabled: boolean,
  sessions: { list(): Iterable<{ secrets: SecretRegistry }> },
): () => void {
  return addLogMask((text) =>
    maskLogText(text, activeSecretRegistries(secretsEnabled, sessions.list())),
  );
}

/** The result the MCP SDK builds for a handler that throws: the error message
 *  as one text item, with `isError: true`. Built here so the message goes
 *  through the same masking pass as any other result before it is sent. */
export function maskedToolError(
  err: unknown,
  registries: readonly SecretRegistry[],
): ToolResponse & { isError: true } {
  const text = err instanceof Error ? err.message : String(err);
  return maskToolResponse({ content: [{ type: "text", text }], isError: true }, registries);
}
