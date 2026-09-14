import { SESSION_ARG } from "./schemas.js";
import type {
  ConfigHost,
  GateHost,
  RegisterHost,
  ServerServicesHost,
  SessionHost,
} from "./host.js";
import type { CaptureTier } from "../replay/schema.js";
import type { ReplayStartOptions } from "../replay/session.js";

const REPLAY_TIERS: readonly CaptureTier[] = ["actions", "replay", "reexecutable"];
/** The compound-capability arm engaged only when the caller opts in with the
 *  `replay` argument. Passed to `gateCheck`; no direct `caps.enabled` read. */
const REPLAY_EXTRA = ["replay"] as const;

/**
 * Recording-mode tools: `start_recording` / `end_recording` / `record_annotate`.
 * Capture subsequent action tool calls as a draft flow-file, and optionally
 * (`replay: {...}`, gated behind the off-by-default `replay` capability) as a
 * `.browx` session-replay artifact. Split out of `forms-recording-tools`
 * (RFC 0004 P3 / D3 SRP); registered through the shared `ToolHost` seam in the
 * same source order.
 */
export function registerFormsRecordingModeTools(
  host: RegisterHost & GateHost & SessionHost & ServerServicesHost & ConfigHost,
): void {
  const { z, register, gateCheck, entryFor, workspace } = host;

  const replayInputSchema = z
    .object({
      tier: z
        .enum(["actions", "replay", "reexecutable"])
        .optional()
        .describe(
          "Capture depth. `actions` = actions + console + annotations only, no DOM stream. " +
            "`replay` (default) adds the DOM stream + network/WS metadata. `reexecutable` " +
            "adds bodies, the largest tier.",
        ),
      sizeCap: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Byte ceiling for the pre-compression event log. Truncation → `size-cap`."),
      eventCap: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Event ceiling. Truncation → `event-cap`."),
      redaction: z
        .object({
          headers: z.array(z.string()).optional(),
          bodyPaths: z.array(z.string()).optional(),
        })
        .optional(),
      maskSelectors: z
        .array(z.string())
        .optional()
        .describe(
          "Extra CSS selectors masked in the DOM stream (input[type=password] is always masked).",
        ),
      dir: z
        .string()
        .optional()
        .describe("Workspace-relative directory for the artifact (defaults to `replays/`)."),
    })
    .optional()
    .describe(
      "Session-replay artifact configuration. **Requires the off-by-default `replay` capability.** " +
        "When set, browxai writes a `.browx` archive on `end_recording`. The archive carries the " +
        "DOM stream, network/WS metadata (bodies at `reexecutable`), console output and action " +
        "calls. **The artifact is as sensitive as the session it recorded** — treat it as production " +
        "data. Registered secrets are masked at capture time before anything reaches disk.",
    );

  register(
    "start_recording",
    {
      capability: "human",
      description:
        "Begin recording subsequent tool calls as a draft flow-file. Every successful navigate/click/fill/press/hover/select/wait_for adds an action step (with the resolved selectorHint when a target was given); every successful extract/find/snapshot/eval_js adds a read step carrying what the call asked for (schema+scope / query / scope / expression) and, for `find`, the locator it resolved. Returned page data is never recorded. Call `end_recording` to emit a YAML draft, or `export_playwright_script` to lower the trace to a runnable `.spec.ts` without ending the recording. `record_annotate` attaches annotations to the most-recent step. Calibration-walk → flow-file scaffolding.\n\nOptional `replay: {...}` engages a `.browx` session-replay artifact alongside the YAML draft. **Requires the `replay` capability** (off by default). The archive carries the DOM stream, network/WS metadata (bodies at `reexecutable`), console output and action calls — real page data, as sensitive as the session was.",
      inputSchema: {
        flowName: z.string().describe('Name of the flow being recorded, e.g. "login-and-search"'),
        replay: replayInputSchema,
        ...SESSION_ARG,
      },
    },
    async ({ flowName, replay, session }) => {
      // Compound gate: the tool's own `human` capability, and — only when the
      // caller opts in via the `replay` argument — the off-by-default `replay`
      // capability. Both refusals ride the same `gateCheck` shape so the
      // metrics classifier buckets them identically as `capability-denied`.
      const g = gateCheck("start_recording", replay ? REPLAY_EXTRA : undefined);
      if (g) return g;
      const entry = await entryFor(session);
      const r = entry.recorder.start(flowName);
      let replayInfo: unknown;
      if (replay) {
        const opts = normalizeReplayOptions(replay);
        replayInfo = await entry.replay.start(opts, workspace);
      }
      const payload = replayInfo ? { ...r, replay: replayInfo } : r;
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    },
  );

  register(
    "end_recording",
    {
      capability: "human",
      description:
        "Stop the current recording and emit the draft flow-file YAML. Returns `{ name, yaml, stepCount }`, plus `replay: { path, bytes, events, ... }` when `start_recording({replay})` engaged the `.browx` writer. Review the locators block (entries flagged `stability: medium|low` deserve a second look) and add prerequisites/assertions before committing the flow into a site-docs workspace. A returned `replay.path` points at a `.browx` archive carrying the session's DOM stream + network metadata + console: as sensitive as the session was, so treat it accordingly.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("end_recording");
      if (g) return g;
      const entry = await entryFor(session);
      try {
        const yamlPart = entry.recorder.end();
        const payload: Record<string, unknown> = { ...yamlPart };
        if (entry.replay.active()) payload.replay = await entry.replay.end(workspace);
        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
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
        "Attach a doc annotation (copy + optional arrow position + optional target ref) to the most-recent recorded step, or to a specific `stepId`. Optional `label` tags a span in an active `.browx` replay artifact — the coverage view in the offline player groups spans by that label (e.g. an acceptance-criterion id). No-op on the YAML side if no recording is active; the label still lands on the replay log if one is running.",
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
        label: z
          .string()
          .optional()
          .describe(
            "Optional acceptance-criterion id / span label. The replay player's coverage " +
              "view groups spans by this. Falls back to `copy` when unset.",
          ),
        phase: z
          .enum(["start", "end"])
          .optional()
          .describe("Replay span phase; defaults to `start`."),
        ...SESSION_ARG,
      },
    },
    async ({ copy, arrow, target, stepId, label, phase, session }) => {
      const g = gateCheck("record_annotate");
      if (g) return g;
      const entry = await entryFor(session);
      const yamlR = entry.recorder.annotate({ stepId, copy, arrow, target });
      if (entry.replay.active()) {
        entry.replay.annotate({ label: label ?? copy, copy, phase: phase ?? "start" });
      }
      return { content: [{ type: "text", text: JSON.stringify(yamlR, null, 2) }] };
    },
  );
}

function normalizeReplayOptions(input: {
  tier?: string;
  sizeCap?: number;
  eventCap?: number;
  redaction?: { headers?: string[]; bodyPaths?: string[] };
  maskSelectors?: string[];
  dir?: string;
}): ReplayStartOptions {
  const opts: ReplayStartOptions = {};
  if (input.tier && REPLAY_TIERS.includes(input.tier as CaptureTier)) {
    opts.tier = input.tier as CaptureTier;
  }
  if (input.sizeCap) opts.sizeCap = input.sizeCap;
  if (input.eventCap) opts.eventCap = input.eventCap;
  if (input.redaction) opts.redaction = { ...input.redaction };
  if (input.maskSelectors) opts.maskSelectors = input.maskSelectors;
  if (input.dir) opts.dir = input.dir;
  return opts;
}
