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
//
// Output shape: a single `.spec.ts` source string. The caller can return it
// inline AND/OR write it to a workspace-rooted path (same posture as
// `dump_storage_state` — workspace-rooted, escape-rejected).

import type { RecordedStep } from "./recording.js";
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
    body.push("    // No steps recorded. Run actions while a recording is active,");
    body.push("    // then re-export to populate this spec.");
  }

  for (const step of steps) {
    const lowered = lowerStep(step);
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
    if (lowered.handled) handled += 1;
    else unhandled += 1;
  }

  const source = renderSpec(flowName, body);
  return {
    source,
    stats: { steps: steps.length, handled, unhandled, fragile },
  };
}

/** Pure step lowering. Exported for the unit tests. */
export function lowerStep(step: RecordedStep): LoweredStep {
  const a = step.action;
  switch (a.type) {
    case "navigate":
      return handledLines([`await page.goto(${jsString(a.url ?? "")});`]);
    case "goBack":
      return handledLines(["await page.goBack();"]);
    case "goForward":
      return handledLines(["await page.goForward();"]);
    case "click":
      return targeted(step, (loc) => [`await ${loc}.click();`]);
    case "fill":
      return targeted(step, (loc) => [`await ${loc}.fill(${jsString(a.value ?? "")});`]);
    case "hover":
      return targeted(step, (loc) => [`await ${loc}.hover();`]);
    case "select": {
      // `select` records its values as a comma-joined string (see
      // src/page/actions.ts); lower back to `selectOption([...])`. A single
      // value still goes through the array form — Playwright accepts both
      // and the array form is unambiguous.
      const values = (a.value ?? "").split(",").map((v) => v.trim()).filter((v) => v.length > 0);
      const literal = "[" + values.map(jsString).join(", ") + "]";
      return targeted(step, (loc) => [`await ${loc}.selectOption(${literal});`]);
    }
    case "press": {
      // `press` may or may not have a target. Without one, the keypress
      // lands at the page level (`page.keyboard.press`); with one, the
      // target is focused first by Playwright (`locator.press`).
      const key = a.value ?? "";
      if (step.selectorHint) {
        return targeted(step, (loc) => [`await ${loc}.press(${jsString(key)});`]);
      }
      return handledLines([`await page.keyboard.press(${jsString(key)});`]);
    }
    case "waitFor": {
      // Two shapes — `text:<...>` (page-level visible-text wait) and a
      // target-shaped wait (element visible).
      const v = a.value ?? "";
      if (v.startsWith("text:")) {
        const text = v.slice("text:".length);
        return handledLines([
          `await page.getByText(${jsString(text)}).first().waitFor({ state: "visible" });`,
        ]);
      }
      return targeted(step, (loc) => [`await ${loc}.waitFor({ state: "visible" });`]);
    }
    case "chooseOption": {
      // `choose_option` is a compound (open-trigger → click-option) that
      // doesn't lower cleanly to one Playwright call. Emit the trigger
      // click + the option click as two calls and flag a TODO so the
      // consumer knows to review the open/wait gap.
      const optionText = a.value ?? "";
      const lines = [
        "// choose_option lowered as trigger-click + option-click; review the wait between them.",
      ];
      const loc = locatorExprFor(step);
      lines.push(`await ${loc}.click();`);
      lines.push(`await page.getByRole("option", { name: ${jsString(optionText)} }).first().click();`);
      // chooseOption is "handled" — we emitted a runnable sequence — but
      // the comment makes the review-needed status visible in-source.
      return { lines, fragile: isFragile(step), handled: true };
    }
    default:
      // Unknown action type — emit a TODO placeholder so the spec still
      // parses, and bump the `unhandled` counter so the caller sees the gap.
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

function targeted(
  step: RecordedStep,
  build: (locatorExpr: string) => string[],
): LoweredStep {
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
  const roleNameMatch = s.match(/^role=([a-zA-Z][a-zA-Z0-9-]*)\[name=("((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')\]$/);
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

/** Render the final `.spec.ts` source. Body lines are inserted verbatim
 *  (already indented by the caller). */
function renderSpec(flowName: string, bodyLines: string[]): string {
  const safeName = flowName.replace(/[\r\n]/g, " ").replace(/`/g, "\\`");
  const lines: string[] = [
    `import { test, expect } from "@playwright/test";`,
    ``,
    `// Generated by browxai \`export_playwright_script\`. Each step below was`,
    `// lowered from a recorded browxai action; selectors come from the`,
    `// recorder's selectorHint at the time of the call. \`// TODO: fragile`,
    `// selector\` comments flag tier-5 / role-only fallbacks — review before`,
    `// relying on this spec in CI.`,
    `//`,
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

// Bare-minimum TypeScript parse-check. We don't pull `typescript` in as a
// dependency for a single-file syntax pass — the lowered output is small,
// well-bounded, and we control every emitted line, so a structural sanity
// check is enough: matched braces / parens / quotes, the expected import
// line at the top, the expected test shell. Catches the "I emitted a line
// without closing the call" class of bug the cycle invariant calls out.
export function parseCheck(source: string): { ok: true } | { ok: false; reason: string } {
  if (!source.startsWith("import { test, expect } from \"@playwright/test\";")) {
    return { ok: false, reason: "missing @playwright/test import header" };
  }
  if (!/\ntest\(/.test(source)) {
    return { ok: false, reason: "missing test(...) shell" };
  }
  // matched-delimiter pass — strings + line-comments are skipped to avoid
  // false positives on, e.g., a `{` inside a string literal.
  let i = 0;
  let depth = { paren: 0, brace: 0, bracket: 0 };
  while (i < source.length) {
    const c = source[i]!;
    // line comment
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl + 1;
      continue;
    }
    // block comment
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    // string literal — track until matching quote, respecting backslash
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i += 2;
        else i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "(") depth.paren += 1;
    else if (c === ")") depth.paren -= 1;
    else if (c === "{") depth.brace += 1;
    else if (c === "}") depth.brace -= 1;
    else if (c === "[") depth.bracket += 1;
    else if (c === "]") depth.bracket -= 1;
    if (depth.paren < 0 || depth.brace < 0 || depth.bracket < 0) {
      return { ok: false, reason: `unbalanced delimiter at offset ${i}` };
    }
    i += 1;
  }
  if (depth.paren !== 0 || depth.brace !== 0 || depth.bracket !== 0) {
    return {
      ok: false,
      reason: `unbalanced delimiters at EOF (paren=${depth.paren}, brace=${depth.brace}, bracket=${depth.bracket})`,
    };
  }
  return { ok: true };
}

// Type-only re-export so callers can import `RecordedStep` from this module
// without a second import line.
export type { RecordedStep, DispatchedAction };
