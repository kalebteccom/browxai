// Prints one summary after a keystone run: how many keystones ran, how many
// skipped, and per skipped file the reason its gate gave (keystone-gate.ts).
// The default reporter shows a skipped file as one `↓` line among the passes;
// this puts the count and the reasons where a reader of the CI log looks last.
//
//   keystone: <run> run, <skipped> skipped
//     skipped <n>  test/keystone/<file>: <reason>
//
// One shard prints the summary of its own slice.
//
// It only reports. A keystone that must run fails through its gate
// (BROWX_REQUIRE_BROWSER=1), not here.

import type { Reporter, TestModule, Vitest } from "vitest/node";

// Loads the `skipReason` field onto vitest's TaskMeta.
import type {} from "./keystone-gate.js";

export interface SkipRow {
  file: string;
  count: number;
  reasons: string[];
}

export interface SkipSummary {
  run: number;
  skipped: number;
  rows: SkipRow[];
}

/** A test as the summary sees it: its file, its end state and its skip reason. */
export interface TestOutcome {
  file: string;
  state: string;
  skipReason?: string;
}

export const NO_REASON = "no reason given";

export function summarizeSkips(outcomes: Iterable<TestOutcome>): SkipSummary {
  let run = 0;
  let skipped = 0;
  const byFile = new Map<string, { count: number; reasons: Set<string> }>();
  for (const o of outcomes) {
    if (o.state !== "skipped") {
      run++;
      continue;
    }
    skipped++;
    const row = byFile.get(o.file) ?? { count: 0, reasons: new Set<string>() };
    row.count++;
    row.reasons.add(o.skipReason ?? NO_REASON);
    byFile.set(o.file, row);
  }
  const rows = [...byFile]
    .map(([file, r]) => ({ file, count: r.count, reasons: [...r.reasons].sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { run, skipped, rows };
}

export function formatSkipSummary(s: SkipSummary): string {
  const lines = [`keystone: ${s.run} run, ${s.skipped} skipped`];
  const width = String(Math.max(0, ...s.rows.map((r) => r.count))).length;
  for (const r of s.rows) {
    lines.push(`  skipped ${String(r.count).padStart(width)}  ${r.file}: ${r.reasons.join("; ")}`);
  }
  return lines.join("\n");
}

function* outcomes(modules: ReadonlyArray<TestModule>): Generator<TestOutcome> {
  for (const m of modules) {
    for (const t of m.children.allTests()) {
      yield { file: m.relativeModuleId, state: t.result().state, skipReason: t.meta().skipReason };
    }
  }
}

export default class SkipReporter implements Reporter {
  private vitest?: Vitest;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const text = formatSkipSummary(summarizeSkips(outcomes(modules)));
    if (this.vitest) this.vitest.logger.log(`\n${text}`);
    else console.log(`\n${text}`);
  }
}
