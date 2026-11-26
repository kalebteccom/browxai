// `browxai doctor` confirm-hooks rows: the hooks in force, then one warning row
// for each thing the list leaves un-held.

import { confirmHookWarnings, resolveConfirmHooks } from "../util/capabilities.js";
import { docsUrl } from "../util/docs-links.js";
import type { Check } from "./doctor.js";

export function confirmHookRows(env: NodeJS.ProcessEnv = process.env): Check[] {
  try {
    const hooks = resolveConfirmHooks(env);
    const rows: Check[] = [
      {
        name: "confirm-hooks",
        ok: true,
        detail: hooks.size > 0 ? `[${[...hooks].join(", ")}]` : "(none)",
      },
    ];
    for (const warning of confirmHookWarnings(hooks)) {
      rows.push({
        name: "confirm-hooks",
        ok: true,
        warn: true,
        detail: warning,
        fix: "see " + docsUrl.threatModelConfiguring,
      });
    }
    return rows;
  } catch (e) {
    return [
      {
        name: "confirm-hooks",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
        fix: "fix BROWX_CONFIRM_REQUIRED, see " + docsUrl.threatModelConfiguring,
      },
    ];
  }
}
