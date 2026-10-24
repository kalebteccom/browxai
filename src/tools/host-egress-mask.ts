// Tool output masks registered secrets. The `register` wrapper runs every tool
// result through `maskToolResponse` once, after the handler, so a tool family
// that never called the egress sanitiser (`extract`, `shadow_trees`,
// `cookies_get`, `idb_get`, `caches_get`, …) still returns `<NAME>` in place of
// a registered value. Sinks that already mask keep doing so; their output
// carries no registered value, so this pass leaves it untouched without
// parsing it.
//
// Only text items are masked. Image items are pixels; `screenshot`'s page-text
// warning covers them. Result shapes are unchanged: an item is replaced only
// when its text changed.

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
 *  itself when nothing changed. */
export function maskToolResponse(
  res: ToolResponse,
  registries: readonly SecretRegistry[],
): ToolResponse {
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
