import type { ToolHost } from "./host.js";
import { registerExtensionsTools } from "./extensions-tools.js";
import { registerBatchHumanTools } from "./batch-human-tools.js";
import { registerBatchActTools } from "./batch-act-tools.js";

/**
 * Chrome-extension management + the server-side compound primitives:
 * extensions_install / extensions_list / extensions_reload /
 * extensions_trigger / extensions_uninstall, plus await_human, batch,
 * act_and_sample, act_and_diff, flake_check.
 *
 * RFC 0004 P3 / D3 (SRP): the registrations were split by cohesive family into
 * three sibling modules (extensions / batch-human / batch-act), and the
 * persistent-session context rebuild was extracted to `extensions-rebuild.ts`.
 * This module stays the single entry point `server.ts` + `tool-metadata.ts` call,
 * and invokes each family in the EXACT prior source order so the registered-name
 * set + the derived maps stay byte-identical. The extension tools rebuild the
 * underlying browser context on mutation (Chromium can't add/remove extensions on
 * a live context). The host owns the closures; the family modules own the
 * registrations.
 */
export function registerExtensionsBatchTools(host: ToolHost): void {
  registerExtensionsTools(host);
  registerBatchHumanTools(host);
  registerBatchActTools(host);
}
