// Calibration-walk → flow-file scaffold — wishlist W-C2.
//
// Records action-tool calls during a session and emits a draft `flow-file.yaml`
// the agent can hand to site-docs (or any consumer with a similar YAML shape).
//
// The recording captures: the action's type/target, the resolved selectorHint
// (so flow-files transcribe mechanically), the URL, and an optional human-readable
// note. Annotations are agent-supplied via `record_annotate({ copy, arrow })`.
//
// Format: minimal site-docs-flavoured YAML (the canonical shape lives in the
// site-docs repo; consumers can post-process if they need a different dialect).

import type { ActionDescriptor } from "./actionresult.js";
import type { FindCandidate } from "./find.js";

export interface RecordedStep {
  id: string;
  action: ActionDescriptor;
  url: string;
  selectorHint?: string;
  /** Stability of the locator at calibration time. Phase-1.5 W-D1 friend. */
  stability?: FindCandidate["stability"];
  /** Optional agent-supplied annotation for the doc emission. */
  annotation?: { copy: string; arrow?: string; target?: string };
  ts: number;
}

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

  active(): boolean { return this.name !== null; }

  /** Record an action that just happened. The caller (server.ts action handlers)
   *  passes the descriptor + the URL it ended at + whatever selectorHint was
   *  used to resolve the target. Best-effort: if no recording is active, this
   *  is a no-op. */
  record(descriptor: ActionDescriptor, url: string, hint?: { selectorHint: string; stability?: FindCandidate["stability"] }): void {
    if (!this.name) return;
    const id = this.suggestId(descriptor);
    this.steps.push({ id, action: descriptor, url, selectorHint: hint?.selectorHint, stability: hint?.stability, ts: Date.now() });
  }

  /** Attach an annotation to the most-recent step (or by id). */
  annotate(args: { stepId?: string; copy: string; arrow?: string; target?: string }): { ok: boolean; error?: string } {
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

  private suggestId(d: ActionDescriptor): string {
    const base =
      d.type === "navigate" ? "open" :
      d.type === "click" ? "click" :
      d.type === "fill" ? "fill" :
      d.type === "press" ? "press" :
      d.type === "hover" ? "hover" :
      d.type === "select" ? "select" :
      d.type === "waitFor" ? "wait" :
      d.type;
    return `${base}-${++this.autoCounter}`;
  }

  /** Render the recording as YAML. Minimal site-docs-flavoured shape; consumers
   *  can post-process. We don't pull in a YAML library to keep deps lean — the
   *  output is small + predictable. */
  private toYaml(): string {
    const lines: string[] = [];
    lines.push(`name: ${this.name}`);
    lines.push(`# Drafted via browxai recording — review locator stability + add prerequisites/assertions before committing.`);
    // Locators block — pulled from steps that have a selectorHint.
    const locatorEntries = this.collectLocators();
    if (locatorEntries.length > 0) {
      lines.push("locators:");
      for (const { name, hint, stability } of locatorEntries) {
        const stabilityTag = stability && stability !== "high" ? `   # stability: ${stability} — review`: "";
        lines.push(`  ${name}: ${quote(hint)}${stabilityTag}`);
      }
    }
    lines.push("steps:");
    for (const step of this.steps) {
      lines.push(`  - id: ${step.id}`);
      lines.push(`    action: ${step.action.type}`);
      const valueOrUrl = step.action.url ?? step.action.value;
      if (valueOrUrl !== undefined) lines.push(`    value: ${quote(valueOrUrl)}`);
      if (step.selectorHint && step.action.type !== "navigate") {
        const locName = this.locatorNameFor(step);
        lines.push(`    target: $${locName}`);
      }
      if (step.annotation) {
        lines.push(`    annotation:`);
        lines.push(`      copy: ${quote(step.annotation.copy)}`);
        if (step.annotation.arrow) lines.push(`      arrow: ${step.annotation.arrow}`);
        if (step.annotation.target) lines.push(`      target: ${step.annotation.target}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  private collectLocators(): Array<{ name: string; hint: string; stability?: FindCandidate["stability"] }> {
    const seen = new Map<string, { name: string; hint: string; stability?: FindCandidate["stability"] }>();
    for (const step of this.steps) {
      if (!step.selectorHint || step.action.type === "navigate") continue;
      const name = this.locatorNameFor(step);
      if (!seen.has(name)) seen.set(name, { name, hint: step.selectorHint, stability: step.stability });
    }
    return [...seen.values()];
  }

  private locatorNameFor(step: RecordedStep): string {
    // Derive a stable locator name from the selectorHint: extract the testId/
    // role+name if obvious, else mash the step id.
    const hint = step.selectorHint ?? "";
    // Tier-1 attribute selector: require `data-*` prefix so we don't match
    // e.g. `[name="Submit"]` inside a role=… hint.
    const testId = hint.match(/\[(data-[a-z-]+)="([^"]+)"\]/);
    if (testId) return slugify(testId[2]!);
    const roleName = hint.match(/role=([a-z]+)\[name="([^"]+)"\]/i);
    if (roleName) return slugify(`${roleName[1]}_${roleName[2]}`);
    return slugify(step.id);
  }
}

function slugify(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase() || "step";
}

function quote(s: string): string {
  // Minimal YAML scalar quoting — wrap in double quotes if contains spaces /
  // special chars; otherwise leave bare. Always quote for predictability.
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
