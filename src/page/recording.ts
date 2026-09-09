// Calibration-walk → flow-file scaffold.
//
// Records tool calls during a session and emits a draft `flow-file.yaml` the
// agent can hand to site-docs (or any consumer with a similar YAML shape).
//
// Two step kinds land in the trace:
//   - `action` — a dispatched action (navigate/click/fill/…): its type/target,
//     the resolved selectorHint (so flow-files transcribe mechanically), the
//     URL, and an optional human-readable note.
//   - `read` — a read tool (extract/find/snapshot/eval_js). Reads dispatch no
//     action, so without this arm a session whose purpose was to READ exports
//     as a script that navigates and returns nothing. The trace holds the
//     read's INTENT (schema / query / expression / scope) and the locator it
//     resolved — never the returned page data, which keeps the recorder out of
//     the secrets-and-PII business.
//
// Annotations are agent-supplied via `record_annotate({ copy, arrow })`.
//
// Format: minimal site-docs-flavoured YAML (the canonical shape lives in the
// site-docs repo; consumers can post-process if they need a different dialect).

import type { DispatchedAction } from "./actionresult.js";
import type { FindCandidate } from "./find.js";

/** A read tool call worth replaying. Carries what the caller asked for, not
 *  what the page answered. */
export type RecordedRead =
  | { type: "extract"; schema: Record<string, unknown>; scope?: string }
  | { type: "find"; query: string }
  | { type: "snapshot"; scope?: string }
  | { type: "eval_js"; expr: string };

interface RecordedStepBase {
  id: string;
  url: string;
  selectorHint?: string;
  /** Stability of the locator at calibration time. */
  stability?: FindCandidate["stability"];
  /** Optional agent-supplied annotation for the doc emission. */
  annotation?: { copy: string; arrow?: string; target?: string };
  ts: number;
}

export interface RecordedActionStep extends RecordedStepBase {
  kind: "action";
  action: DispatchedAction;
}

export interface RecordedReadStep extends RecordedStepBase {
  kind: "read";
  read: RecordedRead;
}

export type RecordedStep = RecordedActionStep | RecordedReadStep;

export class Recorder {
  private steps: RecordedStep[] = [];
  private name: string | null = null;
  private autoCounter = 0;

  start(flowName: string): { ok: true; name: string } {
    if (this.name) {
      // Replace silently — calibration restarts are common.
    }
    this.name = flowName;
    this.steps = [];
    this.autoCounter = 0;
    return { ok: true, name: flowName };
  }

  active(): boolean {
    return this.name !== null;
  }

  /** Read-only access to the recorded trace + the flow name without ending
   *  the recording. Used by trace-export tools (e.g. the Playwright-script
   *  exporter) that need to lower the steps to a runnable artefact while the
   *  recording is still in progress. Returns null when no recording is
   *  active. */
  inspect(): { name: string; steps: ReadonlyArray<RecordedStep> } | null {
    if (!this.name) return null;
    return { name: this.name, steps: this.steps.slice() };
  }

  /** Record an action that just happened. The caller (the action window)
   *  passes the descriptor + the URL it ended at + whatever selectorHint was
   *  used to resolve the target. Best-effort: if no recording is active, this
   *  is a no-op. */
  record(
    descriptor: DispatchedAction,
    url: string,
    hint?: { selectorHint: string; stability?: FindCandidate["stability"] },
  ): void {
    if (!this.name) return;
    this.steps.push({
      kind: "action",
      id: `${actionIdBase(descriptor)}-${++this.autoCounter}`,
      action: descriptor,
      url,
      selectorHint: hint?.selectorHint,
      stability: hint?.stability,
      ts: Date.now(),
    });
  }

  /** Record a read tool call. `hint` carries the locator the read resolved
   *  (for `find`, the top candidate) — that is what a named locator is
   *  lowered from on export. No-op when no recording is active. */
  recordRead(
    read: RecordedRead,
    url: string,
    hint?: { selectorHint: string; stability?: FindCandidate["stability"] },
  ): void {
    if (!this.name) return;
    this.steps.push({
      kind: "read",
      id: `${read.type}-${++this.autoCounter}`,
      read,
      url,
      selectorHint: hint?.selectorHint,
      stability: hint?.stability,
      ts: Date.now(),
    });
  }

  /** Attach an annotation to the most-recent step (or by id). */
  annotate(args: { stepId?: string; copy: string; arrow?: string; target?: string }): {
    ok: boolean;
    error?: string;
  } {
    if (!this.name) return { ok: false, error: "no active recording" };
    if (this.steps.length === 0) return { ok: false, error: "no steps recorded yet" };
    const step = args.stepId
      ? this.steps.find((s) => s.id === args.stepId)
      : this.steps[this.steps.length - 1];
    if (!step) return { ok: false, error: `no step with id "${args.stepId}"` };
    step.annotation = { copy: args.copy, arrow: args.arrow, target: args.target };
    return { ok: true };
  }

  /** End the recording. Returns the YAML draft + the step count. */
  end(): { name: string; yaml: string; stepCount: number } {
    if (!this.name) throw new Error("end_recording: no active recording");
    const name = this.name;
    const yaml = this.toYaml();
    const stepCount = this.steps.length;
    this.name = null;
    this.steps = [];
    return { name, yaml, stepCount };
  }

  /** Render the recording as YAML. Minimal site-docs-flavoured shape; consumers
   *  can post-process. We don't pull in a YAML library to keep deps lean — the
   *  output is small + predictable. */
  private toYaml(): string {
    const lines: string[] = [];
    lines.push(`name: ${this.name}`);
    lines.push(
      `# Drafted via browxai recording — review locator stability + add prerequisites/assertions before committing.`,
    );
    // Locators block — pulled from steps that have a selectorHint.
    const locatorEntries = this.collectLocators();
    if (locatorEntries.length > 0) {
      lines.push("locators:");
      for (const { name, hint, stability } of locatorEntries) {
        const stabilityTag =
          stability && stability !== "high" ? `   # stability: ${stability} — review` : "";
        lines.push(`  ${name}: ${quote(hint)}${stabilityTag}`);
      }
    }
    lines.push("steps:");
    for (const step of this.steps) {
      lines.push(`  - id: ${step.id}`);
      lines.push(...(step.kind === "read" ? readStepYaml(step) : actionStepYaml(step)));
      if (step.selectorHint && hasNamedTarget(step)) {
        lines.push(`    target: $${locatorNameFor(step)}`);
      }
      if (step.annotation) lines.push(...annotationYaml(step.annotation));
    }
    return lines.join("\n") + "\n";
  }

  private collectLocators(): Array<{
    name: string;
    hint: string;
    stability?: FindCandidate["stability"];
  }> {
    const seen = new Map<
      string,
      { name: string; hint: string; stability?: FindCandidate["stability"] }
    >();
    for (const step of this.steps) {
      if (!step.selectorHint || !hasNamedTarget(step)) continue;
      const name = locatorNameFor(step);
      if (!seen.has(name))
        seen.set(name, { name, hint: step.selectorHint, stability: step.stability });
    }
    return [...seen.values()];
  }
}

function actionIdBase(d: DispatchedAction): string {
  if (d.type === "navigate") return "open";
  if (d.type === "waitFor") return "wait";
  return d.type;
}

/** A `navigate` needs no target, so a selectorHint the action window happened
 *  to carry alongside it is not a locator worth naming. */
function hasNamedTarget(step: RecordedStep): boolean {
  return step.kind === "read" || step.action.type !== "navigate";
}

function actionStepYaml(step: RecordedActionStep): string[] {
  const lines = [`    action: ${step.action.type}`];
  const valueOrUrl = step.action.url ?? step.action.value;
  if (valueOrUrl !== undefined) lines.push(`    value: ${quote(valueOrUrl)}`);
  return lines;
}

function readStepYaml(step: RecordedReadStep): string[] {
  const read = step.read;
  const lines = [`    read: ${read.type}`];
  switch (read.type) {
    case "extract":
      // JSON is a subset of YAML, so the schema round-trips as a flow mapping.
      lines.push(`    schema: ${JSON.stringify(read.schema)}`);
      if (read.scope) lines.push(`    scope: ${quote(read.scope)}`);
      break;
    case "find":
      lines.push(`    query: ${quote(read.query)}`);
      break;
    case "snapshot":
      if (read.scope) lines.push(`    scope: ${quote(read.scope)}`);
      break;
    case "eval_js":
      lines.push(`    expr: ${quote(read.expr)}   # requires the \`eval\` capability`);
      break;
  }
  return lines;
}

function annotationYaml(annotation: NonNullable<RecordedStep["annotation"]>): string[] {
  const lines = [`    annotation:`, `      copy: ${quote(annotation.copy)}`];
  if (annotation.arrow) lines.push(`      arrow: ${annotation.arrow}`);
  if (annotation.target) lines.push(`      target: ${annotation.target}`);
  return lines;
}

/** Derive a stable locator name from the step's selectorHint: the testId /
 *  role+name when the hint carries one, else a slug of the step id. Shared
 *  with the Playwright exporter so a recorded `find` lowers to the same name
 *  the YAML draft uses. */
export function locatorNameFor(step: RecordedStep): string {
  const hint = step.selectorHint ?? "";
  // Tier-1 attribute selector: require `data-*` prefix so we don't match
  // e.g. `[name="Submit"]` inside a role=… hint.
  const testId = hint.match(/\[(data-[a-z-]+)="([^"]+)"\]/);
  if (testId) return slugify(testId[2]!);
  const roleName = hint.match(/role=([a-z]+)\[name="([^"]+)"\]/i);
  if (roleName) return slugify(`${roleName[1]}_${roleName[2]}`);
  return slugify(step.id);
}

function slugify(s: string): string {
  return (
    s
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "step"
  );
}

function quote(s: string): string {
  // Minimal YAML scalar quoting — wrap in double quotes if contains spaces /
  // special chars; otherwise leave bare. Always quote for predictability.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
