import { withDeadline } from "../util/deadline.js";
import { screenshotMarks, type MarkCandidate } from "../page/set-of-marks.js";
import { sampleMetric, ELEMENT_METRICS } from "../page/sample.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

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
        "PNG screenshot of an arbitrary viewport rectangle (not an element) — for virtualised timelines / canvas / unlabelled positioned regions where an element-cropped shot doesn't apply.",
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
          e.session.page().screenshot({ clip: box, type: "png" }),
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
        'Composed PNG with numbered bounding boxes painted over caller-supplied candidates — the set-of-marks primitive multimodal agents reach for when they want to ground a vision read against a small palette of stable refs ("click 2" instead of estimating a coordinate). Each candidate is either a bare `{ref}` (looked up against the current snapshot for its bbox) OR a full `find()` candidate row passed through (`{ref, role, name, testId, bbox}` — fast path, no extra tree walk). `label:"index"` (default) paints 1..N positions paired with an `{index→ref}` mapping; `label:"ref"` paints the existing `eN` directly; `label:"role"` paints the role for visual grounding. The numbering scheme SHARES the existing `name_ref` / `eN` namespace — no parallel ID space — so `mapping["2"] === "e7"` and the agent can address either way. Pure compose on top of `find()` / `snapshot()` (no new browser interaction beyond a transient in-page overlay removed before return). Candidates with `bbox:null` (clipped / off-screen) are kept in `marks` with `painted:false` so the mapping stays complete. Read-only (`read`).',
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
            e.session.page(),
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
        "Drive an action in one session and sample a metric in ANOTHER over the same window, in one call — for realtime-propagation assertions (an action in session A should reflect in session B within a freshness budget). `action` is `{tool,args}` from the batch whitelist, dispatched in `actionSession`; the document-scroller `metric` is traced in `sampleSession`. Returns `{ action: <inner result>, sample }`.",
      inputSchema: {
        action: z.object({ tool: z.string(), args: z.record(z.unknown()).optional() }),
        actionSession: z.string().describe("Session the action runs in."),
        sampleSession: z.string().describe("Session whose page is sampled."),
        metric: z
          .enum(ELEMENT_METRICS)
          .describe("Fixed metric (document scroller of sampleSession)."),
        durationMs: z.number().int().positive().max(30_000),
        everyFrame: z.boolean().optional(),
        intervalMs: z.number().int().positive().max(5000).optional(),
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
                  error: `cross_session_sample: inner tool "${innerTool}" not allowed (batch whitelist; no batch / await_human / recording / self)`,
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
      const samplePromise = sampleMetric(sampleEntry.session.page(), sampleEntry.refs, {
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
