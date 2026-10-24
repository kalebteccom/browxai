import { withDeadline } from "../util/deadline.js";
import { screenshotMarks, type MarkCandidate } from "../page/set-of-marks.js";
import { sampleMetric, ELEMENT_METRICS } from "../page/sample.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";
import { requirePage } from "../engine/index.js";

/**
 * Capture + report — region capture & marks composition. `screenshot_region`
 * (viewport-rect PNG), `screenshot_marks` (set-of-marks overlay), the
 * `name_region` / `region` named-rect binding, and `cross_session_sample`
 * (one DOM metric across every open session). Registered through the shared
 * `ToolHost` seam.
 */
export function registerCaptureReportMarksTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    cfgActionTimeout,
    config,
    toolHandlers,
    batchAllowedTools: BATCH_ALLOWED_TOOLS,
  } = host;

  const BOX_SCHEMA = z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  });

  register(
    "screenshot_region",
    {
      capability: "read",
      description:
        "Take a PNG screenshot of a viewport rectangle `box`, for canvas, virtualised timelines and unlabelled positioned regions where an element crop does not apply. Use `screenshot` for the whole viewport or one element.",
      inputSchema: {
        box: BOX_SCHEMA.describe("Viewport rect {x,y,width,height} in CSS px."),
        ...SESSION_ARG,
      },
    },
    async ({ box, session }) => {
      const g = gateCheck("screenshot_region");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const buf = await withDeadline(
          requirePage(e.session).screenshot({ clip: box, type: "png" }),
          cfgActionTimeout(),
          "screenshot_region",
        );
        return {
          content: [
            {
              type: "image" as const,
              data: Buffer.from(buf).toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
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
    "screenshot_marks",
    {
      capability: "read",
      batchable: true,
      description:
        'Take a PNG with numbered boxes painted over candidate elements, so a vision read can point at refs ("click 2") instead of estimating coordinates. Each candidate is a bare `{ref}` (its bbox comes from the current snapshot) or a full `find` candidate row passed through. `label:"index"` (default) paints 1..N and returns an `{index→ref}` mapping, `"ref"` paints the `eN` ref, `"role"` paints the role. The numbers share the `eN` ref namespace, so `mapping["2"] === "e7"`. A candidate with `bbox:null` (clipped or off-screen) stays in `marks` with `painted:false`. A temporary in-page overlay is removed before return. Use `screenshot` when you do not need marks.',
      inputSchema: {
        candidates: z
          .array(z.union([z.object({ ref: z.string() }).passthrough(), z.object({}).passthrough()]))
          .min(1)
          .max(50)
          .describe(
            "Either `{ref}` rows (looked up against the current snapshot for bbox) OR full find() candidate rows (passed through). Mix-and-match allowed. Cap 50.",
          ),
        label: z
          .enum(["index", "ref", "role"])
          .optional()
          .describe(
            "How to label each painted box. `index` (default) = 1..N array position, paired with the `{index→ref}` mapping in the result. `ref` = paint the existing `eN` ref directly. `role` = paint the candidate's role.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("screenshot_marks");
      if (g) return g;
      const e = await entryFor(args.session);
      const candidates = args.candidates as unknown as MarkCandidate[];
      try {
        const result = await withDeadline(
          screenshotMarks(
            requirePage(e.session),
            e.snapshotSubstrate,
            e.refs,
            {
              candidates,
              label: args.label,
              testAttributes: config.testAttributes,
            },
            e.session.cdp ? e.session.cdp() : undefined,
          ),
          cfgActionTimeout(),
          "screenshot_marks",
        );
        const content: Array<
          { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
        > = [
          {
            type: "text",
            text: JSON.stringify(
              { marks: result.marks, mapping: result.mapping, warnings: result.warnings },
              null,
              2,
            ),
          },
          { type: "image", data: result.imageBase64, mimeType: result.mimeType },
        ];
        return { content };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
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
    "name_region",
    {
      capability: "human",
      description:
        "Bind a viewport rectangle to a mnemonic so a sub-agent can re-select the same media segment / timeline row without re-deriving coordinates (drift). Resolve it later with `region`. Per-session.",
      inputSchema: {
        name: z.string().describe('Mnemonic, e.g. "matching_audio_clip".'),
        box: BOX_SCHEMA,
        ...SESSION_ARG,
      },
    },
    async ({ name, box, session }) => {
      const g = gateCheck("name_region");
      if (g) return g;
      const e = await entryFor(session);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, ...e.regions.set(name, box) }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "region",
    {
      capability: "human",
      description:
        "Resolve a `name_region` mnemonic to its `{ box, center }`. Pass `center` to a coords-based action (`click({coords})`) to act on the bound region.",
      inputSchema: { name: z.string(), ...SESSION_ARG },
    },
    async ({ name, session }) => {
      const g = gateCheck("region");
      if (g) return g;
      const e = await entryFor(session);
      const r = e.regions.get(name);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              r
                ? { ok: true, ...r }
                : {
                    ok: false,
                    error: `no region named "${name}" — call name_region first`,
                    known: e.regions.list().map((x) => x.name),
                  },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  register(
    "cross_session_sample",
    {
      capability: "read",
      description:
        "Run an action in one session and trace a metric in another session over the same window, to assert that a change in session A reaches session B within a time budget. Use `act_and_sample` when one session does both. The inner `action` runs in `actionSession`; the document-scroller `metric` is traced in `sampleSession`. Load the page in each session first. Returns `{ action: <inner result>, sample }`.",
      inputSchema: {
        action: z
          .object({
            tool: z.string().describe("Inner tool name (batch whitelist)."),
            args: z
              .record(z.string(), z.unknown())
              .optional()
              .describe("Inner tool args (same shape as a top-level call)."),
          })
          .describe(
            "The inner call `{tool, args}`. Any batchable tool except `batch`, `await_human`, recording tools and this tool.",
          ),
        actionSession: z.string().describe("Session id the action runs in."),
        sampleSession: z.string().describe("Session id whose page is sampled."),
        metric: z
          .enum(ELEMENT_METRICS)
          .describe("Fixed metric (document scroller of sampleSession)."),
        durationMs: z
          .number()
          .int()
          .positive()
          .max(30_000)
          .describe("Trace window in ms (max 30000)."),
        everyFrame: z
          .boolean()
          .optional()
          .describe("Sample every animation frame. Default false: sample on a fixed interval."),
        intervalMs: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe(
            "Sample interval in ms (default 100, min 16). Ignored when everyFrame is true.",
          ),
      },
    },
    async (args) => {
      const g = gateCheck("cross_session_sample");
      if (g) return g;
      const innerTool = args.action.tool;
      if (!BATCH_ALLOWED_TOOLS.has(innerTool) || innerTool === "cross_session_sample") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `cross_session_sample: inner tool "${innerTool}" not allowed (batch, await_human and recording tools cannot be inner tools, nor can the tool itself)`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const ig = gateCheck(innerTool);
      if (ig) return ig;
      const sampleEntry = await entryFor(args.sampleSession);
      const samplePromise = sampleMetric(requirePage(sampleEntry.session), sampleEntry.refs, {
        metric: args.metric,
        durationMs: args.durationMs,
        everyFrame: args.everyFrame,
        intervalMs: args.intervalMs,
      });
      const innerArgs = { ...(args.action.args ?? {}), session: args.actionSession };
      const parseInner = (resp: { content: Array<{ type: string; text?: string }> }): unknown => {
        const first = resp.content[0];
        if (!first || first.type !== "text" || first.text === undefined) return first ?? null;
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      };
      const [sRes, aRes] = await Promise.allSettled([
        samplePromise,
        toolHandlers[innerTool]!(innerArgs),
      ]);
      const sample =
        sRes.status === "fulfilled"
          ? sRes.value
          : { error: sRes.reason instanceof Error ? sRes.reason.message : String(sRes.reason) };
      const action =
        aRes.status === "fulfilled"
          ? parseInner(aRes.value)
          : {
              ok: false,
              error: aRes.reason instanceof Error ? aRes.reason.message : String(aRes.reason),
            };
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ action, sample }, null, 2) }],
      };
    },
  );
}
