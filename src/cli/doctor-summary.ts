// `browxai doctor` output. The default is a short summary, one line per area with
// a tick or a cross, failures first, each with its next step. `--verbose` prints
// every row, including the opt-in engine rows.

import { docsUrl } from "../util/docs-links.js";
import type { Check } from "./doctor.js";

/** Row names grouped into the areas the summary shows, in display order. */
const AREAS: ReadonlyArray<readonly [label: string, rows: readonly string[]]> = [
  ["node", ["node"]],
  ["install", ["build"]],
  ["workspace", ["workspace"]],
  ["browser", ["chrome", "chromium"]],
  ["capabilities", ["capabilities", "byob-attach"]],
  ["attach", ["cdp-attach"]],
  ["settings", ["test-attrs", "confirm-hooks", "origins"]],
  ["plugins", ["plugins"]],
  ["engine", ["engine", "firefox", "webkit", "android", "safari", "electron"]],
];

type State = "fail" | "warn" | "ok";

interface Area {
  label: string;
  state: State;
  /** Rows that explain the state: the failing or warning ones. */
  shown: Check[];
}

function areaFor(name: string): string {
  return AREAS.find(([, rows]) => rows.includes(name))?.[0] ?? name;
}

/** Group rows into areas. An area whose rows are all informational (an opt-in
 *  lane, no plugins declared) is left out: it has nothing to tick or cross. */
export function summarize(checks: readonly Check[]): Area[] {
  const order = [...AREAS.map(([label]) => label)];
  const byArea = new Map<string, Check[]>();
  for (const c of checks) {
    const label = areaFor(c.name);
    if (!order.includes(label)) order.push(label);
    byArea.set(label, [...(byArea.get(label) ?? []), c]);
  }
  const areas: Area[] = [];
  for (const label of order) {
    const rows = byArea.get(label) ?? [];
    const failing = rows.filter((r) => !r.ok);
    const warning = rows.filter((r) => r.ok && r.warn);
    // An opt-in row that failed (a bad engine name) still counts, so test `ok`
    // first. Otherwise informational rows do not make an area.
    if (!rows.some((r) => !r.info) && failing.length === 0) continue;
    if (failing.length) areas.push({ label, state: "fail", shown: failing });
    else if (warning.length) areas.push({ label, state: "warn", shown: warning });
    else areas.push({ label, state: "ok", shown: [] });
  }
  return areas;
}

const GLYPH: Record<State, string> = { fail: "✗", warn: "⚠", ok: "✓" };
const RANK: Record<State, number> = { fail: 0, warn: 1, ok: 2 };

export interface DoctorOutput {
  text: string;
  /** False when any row failed. Warnings and informational rows never fail doctor. */
  allOk: boolean;
}

export function formatDoctor(
  checks: readonly Check[],
  opts: { verbose: boolean; version: string },
): DoctorOutput {
  const allOk = checks.every((c) => c.ok);
  return {
    text: opts.verbose ? verbose(checks, opts.version, allOk) : brief(checks, opts.version, allOk),
    allOk,
  };
}

function verbose(checks: readonly Check[], version: string, allOk: boolean): string {
  let out = `browxai doctor (v${version}) — environment & connectivity\n\n`;
  for (const c of checks) {
    const glyph = c.info ? "−" : c.warn ? "⚠" : c.ok ? "✓" : "✗";
    out += `  ${glyph} ${c.name.padEnd(12)} ${c.detail}\n`;
    if ((!c.ok || c.warn) && c.fix) out += `    fix: ${c.fix}\n`;
    if (c.info && c.enable) out += `    enable with: ${c.enable}\n`;
  }
  out += `\n${
    allOk
      ? `all checks passed. Next: add browxai to your MCP client, see ${docsUrl.gettingStartedConnect}`
      : `fix the ✗ items above, then run \`browxai doctor\` again. Common errors: ${docsUrl.troubleshooting}`
  }\n`;
  return out;
}

function brief(checks: readonly Check[], version: string, allOk: boolean): string {
  const areas = summarize(checks)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => RANK[x.a.state] - RANK[y.a.state] || x.i - y.i)
    .map(({ a }) => a);
  const width = Math.max(...areas.map((a) => a.label.length)) + 2;
  let out = `browxai doctor (v${version})\n\n`;
  for (const a of areas) {
    if (a.state === "ok") {
      out += `  ${GLYPH[a.state]} ${a.label}\n`;
      continue;
    }
    out += `  ${GLYPH[a.state]} ${a.label.padEnd(width)}`;
    out += `${one(a.shown[0]!.detail)}\n`;
    for (const [n, row] of a.shown.entries()) {
      if (n > 0) out += `    ${row.name}: ${one(row.detail)}\n`;
      if (row.fix) out += `    next: ${row.fix}\n`;
    }
  }
  const failed = areas.filter((a) => a.state === "fail").length;
  out += "\n";
  if (allOk) {
    const lead = areas.some((a) => a.state === "warn")
      ? "Nothing failed, but read the ⚠ above."
      : "All good.";
    out +=
      `${lead} To add browxai to Claude Code: claude mcp add browxai -- npx -y browxai\n` +
      `For another client, run \`npx browxai init <dir>\` or see ${docsUrl.gettingStartedConnect}. Every row: \`browxai doctor --verbose\`.\n`;
  } else {
    out +=
      `${failed} ${failed === 1 ? "area needs" : "areas need"} a fix. Fix ${failed === 1 ? "it" : "them"}, then run \`browxai doctor\` again.\n` +
      `Common errors: ${docsUrl.troubleshooting}. Every row: \`browxai doctor --verbose\`.\n`;
  }
  return out;
}

/** A row detail on one line. */
function one(detail: string): string {
  return detail.replace(/\s+/g, " ").trim();
}
