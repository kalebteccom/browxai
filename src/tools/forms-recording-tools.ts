import type { ToolHost } from "./host.js";
import { registerFormsFillTools } from "./forms-fill-tools.js";
import { registerFormsPlanTools } from "./forms-plan-tools.js";
import { registerFormsRecordingModeTools } from "./forms-recording-mode-tools.js";
import { registerFormsRefsTools } from "./forms-refs-tools.js";

/**
 * Form-fill, plan/execute, recording, named-ref, and find-feedback tools:
 * fill_form / plan / execute / start_recording / end_recording /
 * record_annotate / name_ref / list_named_refs / find_feedback.
 *
 * RFC 0004 P3 / D3 (SRP): the registrations were split by cohesive family into
 * four sibling modules (fill / plan-execute / recording-mode / refs). This module
 * stays the single entry point `server.ts` + `tool-metadata.ts` call, and invokes
 * each family in the EXACT prior source order so the registered-name set + the
 * derived maps stay byte-identical. The host owns the closures (gate, confirm,
 * ports); the family modules own the registrations.
 */
export function registerFormsRecordingTools(host: ToolHost): void {
  registerFormsFillTools(host);
  registerFormsPlanTools(host);
  registerFormsRecordingModeTools(host);
  registerFormsRefsTools(host);
}
