import { inspectElement } from "../page/inspect.js";
import { generateLocator } from "../page/generate-locator.js";
import { watchWindow } from "../page/watch.js";
import { pointProbe } from "../page/point_probe.js";
import { sampleMetric, ELEMENT_METRICS } from "../page/sample.js";
import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { REF_OR_SELECTOR, SESSION_ARG, TIMEOUT_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";
import { requirePage } from "../engine/index.js";
import type { TargetSubstrate } from "../page/target-substrate.js";

type SessionEntry = Awaited<ReturnType<ToolHost["entryFor"]>>;

/** `eval_js` is a read, so an active recording keeps the expression — an
 *  exported script that drops it would silently lose the value the flow was
 *  run for. Called only after the evaluate succeeded. The URL stamp comes from
 *  the target port, so a no-Page engine records the URL it really evaluated
 *  against instead of the "" its absent `page()` forced. */
async function recordEval(e: SessionEntry, target: TargetSubstrate, expr: string): Promise<void> {
  const url = await target.url().catch(() => "");
  e.recorder.recordRead({ type: "eval_js", expr }, url);
}

/**
 * Read / observe — the console ring read + element diagnostics. `console_read`,
 * the DOM-metric sampler + window watcher, element inspection / locator
 * generation / point probing, and the gated `eval_js` escape hatch. Registered
 * through the shared `ToolHost` seam.
 *
 * The network/WS ring reads (`network_read` / `ws_read` / `network_body`) moved
 * to `read-observe-network-tools.ts`. They share a reason to change this module
 * does not: all three need the engine to declare the `network` sub-interface, and
 * all three gate on it. Splitting them out also took this file off the 450-line
 * ceiling it was sitting exactly on.
 */
export function registerReadObserveBufferTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    subInterfaceGate,
    entryFor,
    asTarget,
    scriptFor,
    ctxFor,
    cfgActionTimeout,
    actionTimeout,
    egressFor,
    targetFor,
  } = host;

  register(
    "console_read",
    {
      capability: "read",
      batchable: true,
      description:
        "Read recent console messages from the page's ring buffer, newest `limit` (default 50, max 500), each cut at 8192 characters. Use it after a failed action to look for page errors; each action's ActionResult already carries the console messages from its own window.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Most recent N messages to return (default 50, max 500)."),
        ...SESSION_ARG,
      },
    },
    async ({ limit, session }) => {
      const g = gateCheck("console_read");
      if (g) return g;
      const e = await entryFor(session);
      const rows = e.console.recent(limit ?? 50);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
    },
  );

  register(
    "sample",
    {
      capability: "read",
      batchable: true,
      description:
        "Sample a DOM metric over a time window and return the series, for jank, layout-shift and scroll-drift checks. Use `act_and_sample` to trace across an action and `watch` to catch transient UI. `metric` is a fixed enum (no page JS). With a `ref`, `selector` or `named` target: `scrollTop`, `scrollLeft`, `scrollHeight`, `scrollWidth`, `clientWidth`, `clientHeight`, `bboxX`, `bboxY`, `bboxWidth`, `bboxHeight`. Without one it samples the document scroller (`bbox*` is rejected there). `everyFrame:true` samples on requestAnimationFrame, otherwise every `intervalMs` (default 100, min 16). Caps: 30 s, 2000 points. Returns `{ metric, scope, durationMs, mode, count, series:[{tMs,value}], truncated? }`.",
      inputSchema: {
        ...REF_OR_SELECTOR,
        metric: z.enum(ELEMENT_METRICS).describe("Fixed metric to sample."),
        durationMs: z
          .number()
          .int()
          .positive()
          .max(30_000)
          .describe("Window length in ms (max 30000)."),
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
          .describe(
            "Sampling interval in ms (default 100, min 16). Ignored when `everyFrame` is true.",
          ),
        summary: z
          .boolean()
          .optional()
          .describe(
            "Series-omission control; the reduced summary ({count,min,max,first,last,distinctCount,firstChangeTMs}) is ALWAYS returned. true=omit the full series; false=always include it; omit this arg=auto (the series is dropped for large windows >300 points, with `autoSummarised:true` on the result — re-request with summary:false for the raw set).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("sample");
      if (g) return g;
      const e = await entryFor(args.session);
      const hasTarget = !!(args.ref || args.selector || args.named || args.coords);
      const target = hasTarget ? asTarget(args, "sample", e.refs) : undefined;
      if (target && "coords" in target) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  error:
                    "sample: coords targets unsupported — use a ref/selector/named element, or omit target for the window",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      try {
        const result = await sampleMetric(requirePage(e.session), e.refs, {
          target,
          metric: args.metric,
          durationMs: args.durationMs,
          everyFrame: args.everyFrame,
          intervalMs: args.intervalMs,
          summary: args.summary,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: err instanceof Error ? err.message : String(err) },
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
    "watch",
    {
      capability: "read",
      batchable: true,
      description:
        "Watch the page for a fixed window without acting, and report top-level transient surfaces (dialog, alert, status, toast, tooltip, log) that appear and disappear inside it, which a before-and-after diff misses: double-fired toasts, flashes of content, a notification that never shows. Use `sample` for a numeric metric and `wait_for` to wait for one thing. Returns `{ durationMs, samples, regions:[{ role, name, ref, appearedAtMs, disappearedAtMs }], console, network, wsFrames }`. Max window 60 s.",
      inputSchema: {
        durationMs: z
          .number()
          .int()
          .positive()
          .max(60_000)
          .describe("Window length in ms (max 60000)."),
        sampleMs: z
          .number()
          .int()
          .positive()
          .max(5000)
          .optional()
          .describe("Sampling interval in ms (default 250, min 50)."),
        ...SESSION_ARG,
      },
    },
    async ({ durationMs, sampleMs, session }) => {
      const g = gateCheck("watch");
      if (g) return g;
      const e = await entryFor(session);
      const result = await watchWindow(ctxFor(e), { durationMs, sampleMs });
      // Egress sink — the NetworkTap inside `watchWindow` already saw the
      // secrets registry (via `ctx.secrets`) and sanitised URLs / mutation
      // responseShape keys. The remaining channel that can echo a literal
      // value is `regions[].name` (a11y node names — e.g. a status-region
      // whose visible text reads back the just-filled token). Deep-mask
      // the whole result so any future string leaf is also covered. Routed
      // through the injected egress chokepoint (RFC 0004 P3 / D4) — byte-identical
      // to the prior `caps.enabled.has("secrets") ? e.secrets.applyMaskDeep(...) : ...`.
      const masked = egressFor(e).maskDeep(result);
      return { content: [{ type: "text", text: JSON.stringify(masked, null, 2) }] };
    },
  );

  register(
    "inspect",
    {
      capability: "read",
      batchable: true,
      description:
        "Read an element's computed styles (a whitelist plus any you add with `styles`), box, overflow and clip state. Use it for layout and control state: `cursor: not-allowed` versus `wait`, a flex row's `childCount`, a label that overflows (`overflowing.y`), `display:none`. Use `find` to rank candidates, `text_search` to check text, `overflow_detect` to scan a whole page for overflow, and `eval_js` (needs the `eval` capability) only for values this does not return. Returns `{ found, box, styles, overflowing:{x,y}, visible, childCount }`. Target with `ref`, `selector` or `named`; `coords` is not supported (use `point_probe`).",
      inputSchema: {
        ...REF_OR_SELECTOR,
        styles: z
          .array(z.string())
          .optional()
          .describe(
            'Extra computed-style property names to include beyond the default set (camelCase, e.g. "borderBottomWidth").',
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("inspect");
      if (g) return g;
      const e = await entryFor(args.session);
      const target = asTarget(args, "inspect", e.refs);
      if ("coords" in target) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  found: false,
                  error:
                    "inspect requires a ref, selector or named ref. For a point on the page, use point_probe.",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const { locatorFor } = await import("../page/locator.js");
      const loc = locatorFor(requirePage(e.session), e.refs, target);
      let result;
      try {
        result = await withDeadline(
          inspectElement(loc, args.styles ?? []),
          cfgActionTimeout(),
          "inspect",
        );
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { found: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
      // Egress sink — `styles.content` / `background-image: url(...)` can echo
      // a registered real-value rendered into the computed-style stream.
      // Low-risk channel (the reviewer flagged as NIT) but the masking layer
      // is cheap; pin the invariant per-sink.
      const maskedInspect = egressFor(e).maskDeep(result);
      return { content: [{ type: "text", text: JSON.stringify(maskedInspect, null, 2) }] };
    },
  );

  register(
    "generate_locator",
    {
      capability: "read",
      batchable: true,
      description:
        "Convert a ref (from `snapshot`, `find` or `plan`) into a Playwright locator expression to paste into a `.spec.ts`. Returns `{ ok, playwright, stability, components }`. `playwright` is a real expression rooted on `page`, such as `page.getByRole('button', { name: 'Save' })` or `page.getByTestId('save-btn')`. `stability` is the same high, medium or low label `find` emits (high: testid or role+name; medium: stable structure, or text on a stable role; low: positional or role only). `components` splits the locator into parts so you can build your own chain. An unknown ref returns `{ ok:false, failure:{kind:\"ref-not-found\"} }` without throwing: call `find` again.",
      inputSchema: {
        ref: z.string().describe("Stable `eN` ref from a prior snapshot()/find()/plan() result."),
        ...SESSION_ARG,
      },
    },
    async ({ ref, session }) => {
      const g = gateCheck("generate_locator");
      if (g) return g;
      const e = await entryFor(session);
      const result = generateLocator(ref, (r) => e.refs.locatorOf(r));
      // Secrets masking: the emitted `playwright` string + `components`
      // values can echo a real `name` / `testId` that was registered via the
      // secrets registry. Same exposure class as `find()`'s `selectorHint`
      // and `inspect`'s stringly outputs — mask through the per-session
      // registry on egress (the injected chokepoint — RFC 0004 P3 / D4).
      const masked = egressFor(e).maskDeep(result);
      const tokensEstimate = estimateTokens(JSON.stringify(masked));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ...masked, tokensEstimate }, null, 2) },
        ],
      };
    },
  );

  register(
    "point_probe",
    {
      capability: "read",
      description:
        "Show what is under a viewport coordinate: the full `elementsFromPoint` stack (top first; the first entry is what a real click hits) with each layer's tag, id, testId, role, name, classes, computed pointer-events, visibility, display, z-index, cursor and bbox, plus the nearest scroll container and nearest clickable ancestor. Use it before `click({coords})` on canvas, virtualised or painted UIs instead of trusting a screenshot estimate. `crop:true` adds an 80x80 PNG around the point (default off).",
      inputSchema: {
        coords: z.object({ x: z.number(), y: z.number() }).describe("Viewport point in CSS px."),
        crop: z
          .boolean()
          .optional()
          .describe("Default false. Include a small (80×80) PNG crop (base64) around the point."),
        ...SESSION_ARG,
      },
    },
    async ({ coords, crop, session }) => {
      const g = gateCheck("point_probe");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const result = await withDeadline(
          pointProbe(requirePage(e.session), coords, { crop }),
          cfgActionTimeout(),
          "point_probe",
        );
        // Egress sink — `point_probe.text` / `ancestorText` slice the
        // textContent of the element-under-point + nearest clickable ancestor.
        // Same exposure class as snapshot/find name fields; mask through the
        // session registry before serialising.
        const maskedProbe = egressFor(e).maskDeep(result);
        return { content: [{ type: "text" as const, text: JSON.stringify(maskedProbe, null, 2) }] };
      } catch (err) {
        // structured failure — coordinate + target URL for triage.
        const url = await targetFor(e)
          .url()
          .catch(() => "");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  point: coords,
                  url,
                  error: err instanceof Error ? err.message : String(err),
                },
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
    "eval_js",
    {
      capability: "eval",
      batchable: true,
      description:
        "Run a JavaScript expression in the page's main frame and return its JSON-serialisable value. Requires the `eval` capability (off by default). Last resort: use `inspect` for computed styles and layout, `find` or `snapshot` for structure, `extract` for data, and action tools for interaction. Typical use is calling a function the app exposes (`window.__app.save()`). The return value comes from the page, so treat it as untrusted text. `element.click()` and other programmatic DOM events here are not trusted events and often skip framework handlers (Vue `@click`, React synthetic events): use `click` for a real click.",
      inputSchema: {
        expr: z
          .string()
          .describe("JS expression to evaluate. Wrap in `(() => { … })()` for statements."),
        returnType: z
          .enum(["json", "void"])
          .default("json")
          .describe(
            "'json' returns the value (must be JSON-serializable); 'void' discards it (use for fire-and-forget calls).",
          ),
        ...TIMEOUT_ARG,
        ...SESSION_ARG,
      },
    },
    async ({ expr, returnType, timeoutMs, session }) => {
      const g = gateCheck("eval_js");
      if (g) return g;
      const e = await entryFor(session);
      const sg = subInterfaceGate("eval_js", "script", e);
      if (sg) return sg;
      // page.evaluate has NO Playwright timeout — a never-resolving expr
      // would wedge forever. Race it against the anti-wedge deadline.
      const td = actionTimeout({ timeoutMs });
      // soft warning: a programmatic .click() in eval_js does not fire
      // framework (@click / synthetic-event) handlers — a recurring false
      // "feature broken" negative. Point at the real `click` tool.
      const clickWarn = /\.click\s*\(\s*\)/.test(expr)
        ? "eval_js `.click()` does not fire framework click handlers (Vue/React/custom-element) — no app handler runs. If you're testing a click, use the `click` tool instead; this is a known false-negative source."
        : undefined;
      const warn =
        td.warning && clickWarn ? `${td.warning} ${clickWarn}` : (td.warning ?? clickWarn);
      try {
        if (returnType === "void") {
          await withDeadline(scriptFor(e).evaluate(expr), td.ms, "eval_js").catch(() => undefined);
          await recordEval(e, targetFor(e), expr);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { ok: true, returnType: "void", ...(warn ? { warning: warn } : {}) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const value = await withDeadline(scriptFor(e).evaluate(expr), td.ms, "eval_js");
        await recordEval(e, targetFor(e), expr);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: true, value, ...(warn ? { warning: warn } : {}) },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                  ...(warn ? { warning: warn } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
