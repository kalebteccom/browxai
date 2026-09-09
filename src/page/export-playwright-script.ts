// Trace-export: lower a session's recorded action trace into a runnable
// `@playwright/test` spec file. Adjacent to `export_session_report` (which
// bundles QA evidence) and to `end_recording` (which emits the site-docs
// flow-file YAML); this one emits TypeScript a code-as-action consumer can
// run as the seed for a skill-compilation loop.
//
// Lowering principles:
//   - Each recorded step lowers to ONE Playwright call. We deliberately do not
//     re-synthesise the wider browxai action envelope (ActionResult /
//     snapshotDelta / network slice) — a `.spec.ts` is a single deterministic
//     walk, not an observed session.
//   - Locator strings reuse the recorded `selectorHint` (the BEST stable
//     selector resolved at action time). Mirrors `parseSelectorHint` in
//     `./locator.ts` so an exported call resolves the same way browxai itself
//     would: attribute → `page.locator('[attr="..."]')`, role+name → `page
//     .getByRole('role', { name: '...' })`, role-only → `page.getByRole('role')`,
//     anything else → `page.locator('<raw>')`.
//   - Selector stability is surfaced in-source. A recorded `stability: "low"`
//     (or any step where the recorder had to fall back to tier-5 / role-only)
//     gets a `// TODO: fragile selector — review before relying on this in
//     CI` comment above the call, so the consumer SEES the brittle spots
//     rather than having to cross-reference the YAML.
//   - Coords-mode actions are not recorded by the action window (see
//     actions.ts: NON_TARGETED_ACTIONS / hasReplayableTarget), so the export
//     never has to lower a non-replayable target — by construction.
//   - Recorded READS lower too, so a read-shaped session exports as a function
//     rather than a macro: `extract` becomes a live per-field re-read bound to
//     a const, `find` becomes a named locator, `eval_js` becomes a
//     `page.evaluate` of the recorded expression, and `snapshot` becomes a
//     comment (a serialised a11y tree is not a script step). The declared
//     values are logged at the end of the test body — that log IS the
//     exported function's return.
//
// Output shape: a single `.spec.ts` source string. The caller can return it
// inline AND/OR write it to a workspace-rooted path (same posture as
// `dump_storage_state` — workspace-rooted, escape-rejected).

import { locatorNameFor } from "./recording.js";
import type {
  RecordedStep,
  RecordedActionStep,
  RecordedReadStep,
  RecordedRead,
} from "./recording.js";
import type { DispatchedAction } from "./actionresult.js";

/** Tier-1/tier-2 selectorHints recorded at the time of the call. The
 *  recorder writes `stability` alongside each step; we treat `"low"` (and
 *  any missing-stability step that has a selectorHint) as fragile. */
type Stability = NonNullable<RecordedStep["stability"]>;

export interface LoweredStep {
  /** Source lines for this step — each entry is one line in the emitted file
   *  (no trailing newlines). Always wrapped in the test body's indentation
   *  by the caller; the lines themselves are flush-left. */
  lines: string[];
  /** True when the step's selector was tier-5 / role-only / otherwise low-
   *  confidence at recording time. The caller surfaces this as a TODO
   *  comment above the lines. */
  fragile: boolean;
  /** Diagnostic — was this step lowered to a real Playwright call, or to a
   *  `// TODO:` placeholder because we don't know how to lower its action
   *  type? Drives the result's `unhandled` counter so the agent can see
   *  whether the export captured everything. */
  handled: boolean;
  /** Identifier this step binds a read VALUE to (`extract` / `eval_js`).
   *  Collected into the trailing result log so the spec emits what it read. */
  resultVar?: string;
  /** Identifier this step binds a LOCATOR to (`find`). */
  locatorVar?: string;
}

export interface LowerResult {
  /** Complete `.spec.ts` source. Always includes the `@playwright/test`
   *  import + a single `test(...)` shell, even when the trace is empty
   *  (the body is then just a `// No steps recorded.` placeholder). */
  source: string;
  /** Diagnostics for the caller. */
  stats: {
    steps: number;
    handled: number;
    unhandled: number;
    fragile: number;
  };
}

/** Lower a recorded trace to a Playwright spec source string. Pure; the
 *  caller decides whether to write it to disk. */
export function lowerTraceToSpec(
  flowName: string,
  steps: ReadonlyArray<RecordedStep>,
): LowerResult {
  const body: string[] = [];
  let handled = 0;
  let unhandled = 0;
  let fragile = 0;

  if (steps.length === 0) {
    body.push("    // No steps recorded. Run actions or reads while a recording is");
    body.push("    // active, then re-export to populate this spec.");
  }

  const varNames = assignVarNames(steps);
  const locatorVars: string[] = [];
  const resultVars: string[] = [];

  for (const step of steps) {
    const lowered = lowerStep(step, varNames.get(step.id));
    if (lowered.fragile) {
      fragile += 1;
      body.push(
        "    // TODO: fragile selector — review before relying on this in CI " +
          "(recorded stability: " +
          (step.stability ?? "unknown") +
          ").",
      );
    }
    for (const line of lowered.lines) {
      body.push("    " + line);
    }
    if (lowered.locatorVar) locatorVars.push(lowered.locatorVar);
    if (lowered.resultVar) resultVars.push(lowered.resultVar);
    if (lowered.handled) handled += 1;
    else unhandled += 1;
  }
  body.push(...renderReadTail(locatorVars, resultVars));

  const source = renderSpec(flowName, body, specNotes(steps));
  return {
    source,
    stats: { steps: steps.length, handled, unhandled, fragile },
  };
}

/** Trailing lines that make the declared reads load-bearing: the result log is
 *  the exported function's return value, and the `void` line keeps a
 *  `noUnusedLocals` tsconfig quiet about locators the flow never acted on. */
function renderReadTail(locatorVars: string[], resultVars: string[]): string[] {
  const lines: string[] = [];
  if (locatorVars.length > 0) {
    lines.push(`    void [${locatorVars.join(", ")}];`);
  }
  if (resultVars.length > 0) {
    lines.push("    // What this flow read.");
    lines.push(`    console.log(JSON.stringify({ ${resultVars.join(", ")} }, null, 2));`);
  }
  return lines;
}

/** Per-step identifiers for the reads that bind one, deduped across the trace
 *  (two `find`s on the same target would otherwise redeclare a const). */
function assignVarNames(steps: ReadonlyArray<RecordedStep>): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const step of steps) {
    if (step.kind !== "read" || step.read.type === "snapshot") continue;
    const base = varNameFor(step);
    let name = base;
    // bound: `used` only ever holds one name per earlier step, so the suffix
    // can collide at most `steps.length - 1` times before it is free.
    for (let n = 2; used.has(name); n += 1) name = `${base}_${n}`;
    used.add(name);
    names.set(step.id, name);
  }
  return names;
}

function varNameFor(step: RecordedReadStep): string {
  return identifier(step.read.type === "find" ? locatorNameFor(step) : step.id);
}

function identifier(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(s) ? s : `_${s}`;
}

/** Pure step lowering. Exported for the unit tests. */
/** Navigation/history actions need no target. Returns null for non-nav types. */
function lowerNavigation(a: DispatchedAction): LoweredStep | null {
  switch (a.type) {
    case "navigate":
      return handledLines([`await page.goto(${jsString(a.url ?? "")});`]);
    case "goBack":
      return handledLines(["await page.goBack();"]);
    case "goForward":
      return handledLines(["await page.goForward();"]);
    default:
      return null;
  }
}

export function lowerStep(step: RecordedStep, varName?: string): LoweredStep {
  if (step.kind === "read") return lowerRead(step, varName ?? varNameFor(step));
  const a = step.action;
  const nav = lowerNavigation(a);
  if (nav) return nav;
  switch (a.type) {
    case "click":
      return targeted(step, (loc) => [`await ${loc}.click();`]);
    case "fill":
      return targeted(step, (loc) => [`await ${loc}.fill(${jsString(a.value ?? "")});`]);
    case "hover":
      return targeted(step, (loc) => [`await ${loc}.hover();`]);
    case "select":
      return lowerSelect(step, a.value ?? "");
    case "press":
      return lowerPress(step, a.value ?? "");
    case "waitFor":
      return lowerWaitFor(step, a.value ?? "");
    case "chooseOption":
      return lowerChooseOption(step, a.value ?? "");
    default:
      // Unknown action type — emit a TODO placeholder so the spec still parses,
      // and bump the `unhandled` counter so the caller sees the gap.
      return {
        lines: [
          `// TODO: unhandled action type "${a.type}" — no Playwright lowering wired. ` +
            `Original descriptor: ${JSON.stringify(a)}.`,
        ],
        fragile: false,
        handled: false,
      };
  }
}

/** `select` records values as a comma-joined string; lower to `selectOption([...])`
 *  (the array form is unambiguous and accepts a single value too). */
function lowerSelect(step: RecordedActionStep, value: string): LoweredStep {
  const values = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  const literal = "[" + values.map(jsString).join(", ") + "]";
  return targeted(step, (loc) => [`await ${loc}.selectOption(${literal});`]);
}

/** `press` may target an element (`locator.press`) or the page (`page.keyboard.press`). */
function lowerPress(step: RecordedActionStep, key: string): LoweredStep {
  if (step.selectorHint) {
    return targeted(step, (loc) => [`await ${loc}.press(${jsString(key)});`]);
  }
  return handledLines([`await page.keyboard.press(${jsString(key)});`]);
}

/** `waitFor` lowers to a page-level visible-text wait (`text:<...>`) or an
 *  element-visible wait. */
function lowerWaitFor(step: RecordedActionStep, value: string): LoweredStep {
  if (value.startsWith("text:")) {
    const text = value.slice("text:".length);
    return handledLines([
      `await page.getByText(${jsString(text)}).first().waitFor({ state: "visible" });`,
    ]);
  }
  return targeted(step, (loc) => [`await ${loc}.waitFor({ state: "visible" });`]);
}

/** `choose_option` is a compound (open-trigger → click-option) emitted as two
 *  clicks with a review-the-wait comment. */
function lowerChooseOption(step: RecordedActionStep, optionText: string): LoweredStep {
  const loc = locatorExprFor(step);
  return {
    lines: [
      "// choose_option lowered as trigger-click + option-click; review the wait between them.",
      `await ${loc}.click();`,
      `await page.getByRole("option", { name: ${jsString(optionText)} }).first().click();`,
    ],
    fragile: isFragile(step),
    handled: true,
  };
}

type ExtractRead = Extract<RecordedRead, { type: "extract" }>;

function lowerRead(step: RecordedReadStep, varName: string): LoweredStep {
  const read = step.read;
  switch (read.type) {
    case "find":
      return lowerFind(step, read.query, varName);
    case "extract":
      return lowerExtract(step, read, varName);
    case "eval_js":
      return lowerEvalJs(read.expr, varName);
    case "snapshot":
      return lowerSnapshotRead(read.scope);
  }
}

/** `find` lowers to the named locator the YAML draft would call it by. */
function lowerFind(step: RecordedReadStep, query: string, varName: string): LoweredStep {
  if (!step.selectorHint) {
    return {
      lines: [
        `// TODO: find(${jsString(query)}) resolved no candidate at record time — ` +
          `no locator to lower; write one by hand.`,
      ],
      fragile: true,
      handled: false,
    };
  }
  return {
    lines: [`// find(${jsString(query)})`, `const ${varName} = ${locatorExprFor(step)};`],
    fragile: isFragile(step),
    handled: true,
    locatorVar: varName,
  };
}

/** A serialised a11y tree is not a script step — `snapshot` is the agent
 *  orienting itself, and there is nothing to run. It lowers to a comment and
 *  is counted unhandled so the stats stay honest about that. */
function lowerSnapshotRead(scope?: string): LoweredStep {
  // The scope is agent-supplied; a newline in it would split the comment and
  // leave the rest of the line as invalid TypeScript.
  const where = scope ? ` (scope: ${scope.replace(/[\r\n]/g, " ")})` : "";
  return {
    lines: [`// snapshot${where} — agent orientation read; no runtime equivalent in a spec.`],
    fragile: false,
    handled: false,
  };
}

/** The expression is passed through as a string, exactly as `eval_js` hands it
 *  to the page, so the exported call has the same semantics browxai ran. */
function lowerEvalJs(expr: string, varName: string): LoweredStep {
  return {
    lines: [
      "// Recorded from `eval_js` — see the eval-capability note in the header.",
      `const ${varName} = await page.evaluate(${jsString(expr)});`,
    ],
    fragile: false,
    handled: true,
    resultVar: varName,
  };
}

/** `extract` is the read that carries a return value, so it lowers to a live
 *  per-field re-read bound to a const. Only fields with an explicit
 *  `x-browx-source.selector` can lower — the implicit name-as-query rule is
 *  browxai's ranker, which a plain Playwright spec has no access to. */
function lowerExtract(step: RecordedReadStep, read: ExtractRead, varName: string): LoweredStep {
  const properties = asRecord(read.schema.properties);
  if (asString(read.schema.type) !== "object" || !properties) {
    return {
      lines: [
        `// TODO: extract schema is not a top-level object — only object schemas with ` +
          `scalar leaves lower today. Recorded schema: ${JSON.stringify(read.schema)}.`,
      ],
      fragile: false,
      handled: false,
    };
  }
  const refScope = read.scope !== undefined && /^e\d+$/.test(read.scope);
  const root = read.scope && !refScope ? `page.locator(${jsString(read.scope)})` : "page";
  const fields = Object.entries(properties).map(([key, sub]) => extractField(key, sub, root));
  const lines = [
    `// extract → \`${varName}\`. Leaf values come back as page text; browxai's`,
    `// per-type coercion ("$1,234.50" → 1234.5) is not reproduced here.`,
  ];
  if (refScope) {
    lines.push(
      `// TODO: the recorded scope was ref "${read.scope}" — refs are session-local, so ` +
        `the fields below read page-wide. Narrow the root locator.`,
    );
  }
  lines.push(`const ${varName} = {`, ...fields.map((f) => f.line), `};`);
  return {
    lines,
    // `fragile` is the selector-stability signal; a ref scope is a different
    // problem and carries its own TODO above.
    fragile: false,
    handled: fields.every((f) => f.handled),
    resultVar: varName,
  };
}

function extractField(key: string, sub: unknown, root: string): { line: string; handled: boolean } {
  const prop = asRecord(sub);
  const type = prop ? asString(prop.type) : undefined;
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : jsString(key);
  if (type === "object" || type === "array") {
    return {
      line: `  ${name}: null, // TODO: nested ${type} — only scalar leaves lower today.`,
      handled: false,
    };
  }
  const hint = prop ? asRecord(prop["x-browx-source"]) : null;
  const selector = hint === null ? undefined : asString(hint.selector);
  if (hint === null || selector === undefined) {
    return {
      line:
        `  ${name}: null, // TODO: no selector recorded — this field resolved by ` +
        `browxai's name-as-query rule; add an \`x-browx-source.selector\` or a locator.`,
      handled: false,
    };
  }
  return {
    line: `  ${name}: ${leafReadExpr(`${root}.locator(${jsString(selector)}).first()`, hint)},`,
    handled: true,
  };
}

/** Mirrors the read-mode precedence in the extract resolver: attr → prop /
 *  value → visible text. */
function leafReadExpr(target: string, hint: Record<string, unknown>): string {
  const attr = asString(hint.attr);
  if (attr !== undefined) return `await ${target}.getAttribute(${jsString(attr)})`;
  const prop = asString(hint.prop);
  if (hint.value === true || prop === "value") return `await ${target}.inputValue()`;
  if (prop !== undefined) {
    return `await ${target}.evaluate((el) => (el as unknown as Record<string, unknown>)[${jsString(prop)}])`;
  }
  return `(await ${target}.innerText()).trim()`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function targeted(step: RecordedActionStep, build: (locatorExpr: string) => string[]): LoweredStep {
  if (!step.selectorHint) {
    // The recorder only stores a step without a selectorHint for
    // navigation-class actions, which are handled above. If we land here
    // it's a target-shaped action whose target the recorder couldn't
    // resolve (extremely unusual — guard anyway).
    return {
      lines: [
        `// TODO: target action "${step.action.type}" has no recorded selectorHint — ` +
          `cannot lower to a Playwright locator; replace this line manually.`,
      ],
      fragile: true,
      handled: false,
    };
  }
  const loc = locatorExprFor(step);
  return { lines: build(loc), fragile: isFragile(step), handled: true };
}

function handledLines(lines: string[]): LoweredStep {
  return { lines, fragile: false, handled: true };
}

function isFragile(step: RecordedStep): boolean {
  const s: Stability | undefined = step.stability;
  return s === "low";
}

/** Lower a recorded `selectorHint` into a Playwright locator expression
 *  rooted at the `page` identifier. Mirrors `parseSelectorHint` in
 *  `./locator.ts`. */
export function locatorExprFor(step: RecordedStep): string {
  const hint = step.selectorHint ?? "";
  return locatorExprFromHint(hint);
}

/** Pure; exported for unit tests. */
export function locatorExprFromHint(hint: string): string {
  const s = hint.trim();

  // Attribute form — `[data-testid="..."]` and the wider attribute family
  // find() emits (`data-cy`, `data-test`, etc.). Pass the whole hint through
  // as a CSS selector; Playwright's `.locator()` handles it natively.
  const attrMatch = s.match(/^\[([a-zA-Z][a-zA-Z0-9-]*)=("([^"]*)"|'([^']*)')\]$/);
  if (attrMatch) {
    return `page.locator(${jsString(s)})`;
  }

  // Role + name form — `role=button[name="Submit"]`. Lower to `getByRole`
  // with the unescaped name; same parse used by `parseSelectorHint`.
  const roleNameMatch = s.match(
    /^role=([a-zA-Z][a-zA-Z0-9-]*)\[name=("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\]$/,
  );
  if (roleNameMatch) {
    const role = roleNameMatch[1]!;
    const rawName = roleNameMatch[3] ?? roleNameMatch[4] ?? "";
    const name = rawName.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    return `page.getByRole(${jsString(role)}, { name: ${jsString(name)} })`;
  }

  // Role-only — `role=button`. Tier-5 / low-stability shape.
  const roleOnlyMatch = s.match(/^role=([a-zA-Z][a-zA-Z0-9-]*)$/);
  if (roleOnlyMatch) {
    return `page.getByRole(${jsString(roleOnlyMatch[1]!)})`;
  }

  // Fallthrough — raw locator string.
  return `page.locator(${jsString(s)})`;
}

/** TypeScript double-quoted string literal. Escapes the JSON-unsafe subset
 *  plus `$` and backticks (not needed for double quotes, but cheap to be
 *  conservative — the output round-trips through `JSON.stringify` which
 *  already handles `"` and `\`). */
function jsString(value: string): string {
  return JSON.stringify(value);
}

/** Header notes that depend on what the trace contains. `eval_js` sits behind
 *  browxai's off-by-default `eval` capability; the exported `page.evaluate`
 *  call has no such gate, so the provenance has to be stated in-source. */
function specNotes(steps: ReadonlyArray<RecordedStep>): string[] {
  const hasEval = steps.some((s) => s.kind === "read" && s.read.type === "eval_js");
  if (!hasEval) return [];
  return [
    `// This spec contains steps lowered from \`eval_js\`, which browxai gates`,
    `// behind the off-by-default \`eval\` capability — the recording could only`,
    `// have produced them with \`eval\` granted, and replaying the flow through`,
    `// browxai needs it again. Playwright runs the expressions ungated: read`,
    `// them before you run this.`,
    `//`,
  ];
}

/** Render the final `.spec.ts` source. Body lines are inserted verbatim
 *  (already indented by the caller). */
function renderSpec(flowName: string, bodyLines: string[], notes: string[]): string {
  const safeName = flowName.replace(/[\r\n]/g, " ").replace(/`/g, "\\`");
  const lines: string[] = [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `// Generated by browxai \`export_playwright_script\`. Each step below was`,
    `// lowered from a recorded browxai action or read; selectors come from the`,
    `// recorder's selectorHint at the time of the call. \`// TODO: fragile`,
    `// selector\` comments flag tier-5 / role-only fallbacks — review before`,
    `// relying on this spec in CI.`,
    `//`,
    `// First run in a fresh project: \`npx playwright install chromium\`. A fresh`,
    `// \`@playwright/test\` install ships no browsers, so without it the run dies`,
    `// on "Executable doesn't exist" before it reaches the page.`,
    `//`,
    ...notes,
    `// \`expect\` is imported so adding assertions does not require editing`,
    `// the import line; the generated body does not assert by itself.`,
    `void expect;`,
    ``,
    `test(${jsString(safeName)}, async ({ page }) => {`,
    ...bodyLines,
    `});`,
    ``,
  ];
  return lines.join("\n");
}

// Re-exports so callers keep a single import line: the structural parse-check
// lives in its own module, and `RecordedStep` / `DispatchedAction` are the
// types every caller of the lowering needs.
export { parseCheck } from "./export-playwright-parse-check.js";
export type { RecordedStep, DispatchedAction };
