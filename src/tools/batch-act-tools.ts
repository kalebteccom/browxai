import { captureDomMap, diffDomMaps } from "../page/dom_diff.js";
import { sampleMetric, ELEMENT_METRICS } from "../page/sample.js";
import { runFlakeCheck } from "../util/flake-check.js";
import { SESSION_ARG, REF_OR_SELECTOR } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  EgressHost,
  ServerServicesHost,
  ToolResponse,
} from "./host.js";

/** A structured `{ok:false, error}` envelope as a tool text response. */
function batchJsonError(error: string): ToolResponse {
  return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error }, null, 2) }] };
}

/**
 * Act-then-trace + flake-check compound primitives: act_and_sample / act_and_diff
 * / flake_check. Each dispatches an inner batch-allowed action and reports a
 * sampled metric / DOM diff / determinism verdict. Split out of
 * `extensions-batch-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order. The host owns the
 * closures; this module owns the registrations.
 */
export function registerBatchActTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & EgressHost & ServerServicesHost,
): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    asTarget,
    toolHandlers,
    egressFor,
    batchAllowedTools: BATCH_ALLOWED_TOOLS,
  } = host;

  // The per-call cap shared with `batch` — `flake_check` reuses the same whitelist
  // + ceiling (kept a local literal in each family module, byte-identical to the
  // prior single declaration).
  const BATCH_MAX_CALLS = 32;

  // ---------- act-then-trace ----------

  register(
    "act_and_sample",
    {
      capability: "read",
      description:
        "run ONE action and capture a metric trace *across its transition*, in one call — closes the state-capture-latency blind spot (a separate read lands after the spinner/pending UI already resolved). The sampler (fixed-enum, no agent JS) starts, the inner action dispatches concurrently, both are awaited. `action` is `{tool,args}` from the batch whitelist (no `batch`/`await_human`/recording/self); the inner tool's capability + deadline + the confirm hooks still apply. Sample target via `ref`/`selector`/`named` (or omit for the document scroller; not coords). Returns `{ action: <inner result>, ...sampleResult }`.",
      inputSchema: {
        action: z.object({
          tool: z.string().describe("Inner tool name (batch whitelist)."),
          args: z
            .record(z.unknown())
            .optional()
            .describe("Inner tool args (same shape as a top-level call)."),
        }),
        ...REF_OR_SELECTOR,
        metric: z.enum(ELEMENT_METRICS).describe("Fixed metric to trace (same enum as `sample`)."),
        durationMs: z.number().int().positive().max(30_000).describe("Trace window (ms, ≤30000)."),
        everyFrame: z
          .boolean()
          .optional()
          .describe("Sample every animation frame (rAF). Default false → fixed interval."),
        intervalMs: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Interval (ms, default 100, min 16). Ignored when everyFrame:true."),
        summary: z
          .boolean()
          .optional()
          .describe(
            "Series-omission control (summary always returned). true=omit series; false=always include; omit=auto-omit for large windows (>300 pts, sets `autoSummarised`).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("act_and_sample");
      if (g) return g;
      const innerTool = args.action.tool;
      if (!BATCH_ALLOWED_TOOLS.has(innerTool) || innerTool === "act_and_sample") {
        return batchJsonError(
          `act_and_sample: inner tool "${innerTool}" not allowed (must be in the batch whitelist; no batch / await_human / recording / self)`,
        );
      }
      const ig = gateCheck(innerTool);
      if (ig) return ig; // enforce the inner tool's own capability gate
      const e = await entryFor(args.session);
      let sampleTarget;
      if (args.ref || args.selector || args.named || args.coords) {
        const t = asTarget(args, "act_and_sample", e.refs);
        if ("coords" in t) {
          return batchJsonError(
            "act_and_sample: sample target can't be coords — use ref/selector/named or omit for the window",
          );
        }
        sampleTarget = t;
      }
      // Start the sampler, then dispatch the inner action concurrently so the
      // trace spans the transition. Sampler self-bounds via durationMs; the
      // inner action self-bounds via the anti-wedge deadline. Both await.
      const samplePromise = sampleMetric(e.session.page(), e.refs, {
        target: sampleTarget,
        metric: args.metric,
        durationMs: args.durationMs,
        everyFrame: args.everyFrame,
        intervalMs: args.intervalMs,
        summary: args.summary,
      });
      const innerArgs = { ...(args.action.args ?? {}), session: args.session };
      const [sRes, aRes] = await Promise.allSettled([
        samplePromise,
        toolHandlers[innerTool]!(innerArgs),
      ]);
      const parseInner = (resp: { content: Array<{ type: string; text?: string }> }): unknown => {
        const first = resp.content[0];
        if (!first || first.type !== "text" || first.text === undefined) return first ?? null;
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      };
      const sampleOut =
        sRes.status === "fulfilled"
          ? sRes.value
          : { error: sRes.reason instanceof Error ? sRes.reason.message : String(sRes.reason) };
      const actionOut =
        aRes.status === "fulfilled"
          ? parseInner(aRes.value)
          : {
              ok: false,
              error: aRes.reason instanceof Error ? aRes.reason.message : String(aRes.reason),
            };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ action: actionOut, sample: sampleOut }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "act_and_diff",
    {
      capability: "read",
      description:
        "Run ONE action and report the DOM changes it caused within a `scope` — for selection-heavy UIs where the state change (which clip/row became selected) shows only as class / `aria-*` / `data-*` / inline-style changes, invisible to snapshot/find/text_search. Captures a structural DOM map before, dispatches the inner action, captures after, diffs. `action` is `{tool,args}` from the batch whitelist (no `batch`/`await_human`/recording/self); the inner tool's capability + deadline still apply. Returns `{ action: <inner result>, diff: { changed:[{path,tag,testId,classDelta,styleDelta,attrDelta}], added, removed, counts } }`.",
      inputSchema: {
        action: z.object({
          tool: z.string().describe("Inner tool name (batch whitelist)."),
          args: z.record(z.unknown()).optional().describe("Inner tool args."),
        }),
        scope: z
          .string()
          .optional()
          .describe(
            "CSS selector to bound the diff (default: document.body). Must exist before AND after the action.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("act_and_diff");
      if (g) return g;
      const innerTool = args.action.tool;
      if (!BATCH_ALLOWED_TOOLS.has(innerTool) || innerTool === "act_and_diff") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `act_and_diff: inner tool "${innerTool}" not allowed (batch whitelist; no batch / await_human / recording / self)`,
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
      const e = await entryFor(args.session);
      const parseInner = (resp: { content: Array<{ type: string; text?: string }> }): unknown => {
        const first = resp.content[0];
        if (!first || first.type !== "text" || first.text === undefined) return first ?? null;
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      };
      try {
        const before = await captureDomMap(e.session.page(), args.scope);
        const innerArgs = { ...(args.action.args ?? {}), session: args.session };
        const actionResp = await toolHandlers[innerTool]!(innerArgs);
        const after = await captureDomMap(e.session.page(), args.scope);
        const diff = diffDomMaps(before, after);
        // Egress sink — `diff.changed[].classDelta` / `styleDelta` / `attrDelta`
        // surface raw attribute / inline-style values (e.g. `aria-label="hunter2"`
        // or `style="background-image: url(?token=hunter2)"`). The inner-action
        // response was already masked by its own handler; the diff is the
        // remaining literal-value channel and is masked here.
        const maskedDiff = egressFor(e).maskDeep(diff);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ action: parseInner(actionResp), diff: maskedDiff }, null, 2),
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

  // ---------- flake-check ----------

  register(
    "flake_check",
    {
      capability: "action",
      description:
        "Run the same call sequence N times and report what shifted between runs — for diagnosing intermittent CI flakes BEFORE chasing them through logs. Inner calls are dispatched through the `batch` whitelist (capability + confirm hooks unchanged); each run uses `stopOnError:false` internally so a mid-sequence failure does NOT hide the variance picture for later steps. Returns per-step success-rate, distinct errors, distinct resolution signatures, the earliest `firstDivergence` step where ok shifted across runs, and a `cachedResolvers[]` artifact — `{step → resolved ref/selectorHint}` for steps where every run agreed AND succeeded. The artifact mirrors the `ActionDescriptor` shape for `plan` steps so a follow-up call can re-execute against a fresh snapshot. `stopOnAllGreen: K` short-circuits when K consecutive runs are all-green (skips redundant work once you've proved the sequence is stable).",
      inputSchema: {
        calls: z
          .array(
            z.object({
              tool: z.string().describe("Tool name (must be in the batch whitelist)"),
              args: z
                .record(z.unknown())
                .optional()
                .describe("Args for the inner tool, same shape as a top-level call"),
              label: z
                .string()
                .optional()
                .describe("opaque label echoed in the result entry for cross-referencing"),
              expect: z
                .object({
                  valueEquals: z.string().optional(),
                  displayTextIncludes: z.string().optional(),
                  controlDisplayTextIncludes: z.string().optional(),
                  containerTextIncludes: z.string().optional(),
                  controlChanged: z.boolean().optional(),
                })
                .optional()
                .describe(
                  "optional post-call assertions on the inner ActionResult — same shorthand vocabulary as `batch`.",
                ),
            }),
          )
          .min(1)
          .max(BATCH_MAX_CALLS)
          .describe(`Up to ${BATCH_MAX_CALLS} inner calls. Same shape and whitelist as \`batch\`.`),
        n: z
          .number()
          .int()
          .min(3)
          .max(20)
          .describe(
            "How many times to repeat the call sequence. Bounded [3, 20] — fewer than 3 can't surface intermittent flakes; more than 20 burns server time without sharpening the picture.",
          ),
        stopOnAllGreen: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Short-circuit when this many consecutive runs all-pass. Off by default."),
      },
    },
    async ({
      calls,
      n,
      stopOnAllGreen,
    }: {
      calls: Array<{
        tool: string;
        args?: Record<string, unknown>;
        label?: string;
        expect?: import("../util/batch.js").BatchExpect;
      }>;
      n: number;
      stopOnAllGreen?: number;
    }) => {
      const g = gateCheck("flake_check");
      if (g) return g;
      // Reject self-nesting + the same human-blocking / recording tools `batch`
      // already excludes. The whitelist is the source of truth.
      for (const c of calls) {
        if (!BATCH_ALLOWED_TOOLS.has(c.tool)) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error: `flake_check: inner tool "${c.tool}" not allowed (batch whitelist; no batch / flake_check / await_human / recording)`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }
      const report = await runFlakeCheck(calls, {
        n,
        ...(stopOnAllGreen !== undefined ? { stopOnAllGreen } : {}),
        allowed: BATCH_ALLOWED_TOOLS,
        handlers: toolHandlers,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
