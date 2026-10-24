// `browxai doctor` capabilities row: a bad name, or a list that drops defaults.

import {
  DEFAULT_CAPABILITIES,
  resolveCapabilities,
  type Capability,
} from "../util/capabilities.js";
import { docsUrl } from "../util/docs-links.js";
import type { Check } from "./doctor.js";

export interface CapabilitiesRow {
  row: Check;
  /** The capabilities the server would enable; the defaults when the list is invalid. */
  enabled: ReadonlySet<Capability>;
}

export function capabilitiesRow(env: NodeJS.ProcessEnv = process.env): CapabilitiesRow {
  let resolved;
  try {
    resolved = resolveCapabilities(env);
  } catch (e) {
    return {
      row: {
        name: "capabilities",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      },
      enabled: new Set(DEFAULT_CAPABILITIES),
    };
  }
  const enabled = resolved.enabled;
  const explicit = !!env.BROWX_CAPABILITIES?.trim();
  const dangerous = [...enabled].filter((x) => x === "eval" || x === "byob-attach");
  const missing = DEFAULT_CAPABILITIES.filter((x) => !enabled.has(x));
  const detail =
    `enabled=[${[...enabled].join(", ")}]${explicit ? "" : " (default)"}` +
    (missing.length ? `  ⚠ missing: ${missing.join(", ")}` : "") +
    (dangerous.length ? `  ⚠ dangerous: ${dangerous.join(", ")}` : "");
  const fixes: string[] = [];
  if (missing.length) {
    const full = [
      ...DEFAULT_CAPABILITIES,
      ...[...enabled].filter((x) => !DEFAULT_CAPABILITIES.includes(x)),
    ];
    fixes.push(
      `your list replaces the defaults, so tools are off. Add them back: BROWX_CAPABILITIES=${full.join(",")}`,
    );
  }
  if (dangerous.length) {
    fixes.push(
      `${dangerous.join(",")} on: page text remains untrusted, review ${docsUrl.threatModel}`,
    );
  }
  if (!fixes.length && !explicit) {
    fixes.push(
      `see ${docsUrl.threatModel} for the full set; default is ${DEFAULT_CAPABILITIES.join(",")}`,
    );
  }
  return {
    row: {
      name: "capabilities",
      ok: true,
      warn: missing.length > 0 ? true : undefined,
      detail,
      fix: fixes.length ? fixes.join("; ") : undefined,
    },
    enabled,
  };
}
