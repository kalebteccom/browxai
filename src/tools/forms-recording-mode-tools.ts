import { SESSION_ARG } from "./schemas.js";
import type { RegisterHost, GateHost, SessionHost, ServerServicesHost } from "./host.js";

/**
 * Recording-mode tools: `start_recording` / `end_recording` / `record_annotate`.
 * Capture subsequent action tool calls as a draft flow-file. Split out of
 * `forms-recording-tools` (RFC 0004 P3 / D3 SRP); registered through the shared
 * `ToolHost` seam in the same source order.
 */
export function registerFormsRecordingModeTools(
  host: RegisterHost & GateHost & SessionHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, entryFor } = host;

  // ---------- recording mode () ----------

  register(
    "start_recording",
    {
      capability: "human",
      description:
        "Begin recording subsequent action tool calls as a draft flow-file. Every successful navigate/click/fill/press/hover/select/wait_for adds a step (with the resolved selectorHint when a target was given). Call `end_recording` to emit a YAML draft. `record_annotate` attaches annotations to the most-recent step. Calibration-walk → flow-file scaffolding.",
      inputSchema: {
        flowName: z.string().describe('Name of the flow being recorded, e.g. "login-and-search"'),
        ...SESSION_ARG,
      },
    },
    async ({ flowName, session }) => {
      const g = gateCheck("start_recording");
      if (g) return g;
      const r = (await entryFor(session)).recorder.start(flowName);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  register(
    "end_recording",
    {
      capability: "human",
      description:
        "Stop the current recording and emit the draft flow-file YAML. Returns `{ name, yaml, stepCount }`. Review the locators block (entries flagged `stability: medium|low` deserve a second look) and add prerequisites/assertions before committing the flow into a site-docs workspace.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("end_recording");
      if (g) return g;
      try {
        const r = (await entryFor(session)).recorder.end();
        return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: e instanceof Error ? e.message : String(e) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "record_annotate",
    {
      capability: "human",
      description:
        "Attach a doc annotation (copy + optional arrow position + optional target ref) to the most-recent recorded step, or to a specific `stepId`. No-op if no recording is active.",
      inputSchema: {
        copy: z.string().describe("Annotation copy"),
        arrow: z
          .string()
          .optional()
          .describe("Arrow position hint (top|top-left|left|bottom-right|...)"),
        target: z
          .string()
          .optional()
          .describe("Ref to anchor the annotation to (overrides the step's default)"),
        stepId: z.string().optional().describe("Annotate a specific step; default = most-recent"),
        ...SESSION_ARG,
      },
    },
    async ({ copy, arrow, target, stepId, session }) => {
      const g = gateCheck("record_annotate");
      if (g) return g;
      const r = (await entryFor(session)).recorder.annotate({ stepId, copy, arrow, target });
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );
}
