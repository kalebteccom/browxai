import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import {
  canvasCapture,
  canvasDiff,
  canvasScreenToWorld,
  canvasWorldToScreen,
  noAdapterError,
  runGestureChain,
} from "../page/canvas.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";
import { requirePage } from "../engine/index.js";

/**
 * Canvas-app automation primitives.
 *
 * Five MCP tools + a pure-RGBA diff:
 *
 *   - `canvas_capture`           — framebuffer / 2D ImageData / PNG bytes.
 *   - `canvas_diff`              — pixel/region delta over RGBA captures
 *                                  (PNG inputs deferred — base64 byte
 *                                  equality only, see warnings).
 *   - `gesture_chain`            — multi-step pointer program (custom
 *                                  paint strokes, lasso paths, gestures
 *                                  the canned `drag` / `gesture_swipe`
 *                                  family doesn't cover).
 *   - `canvas_world_to_screen` + `canvas_screen_to_world` —
 *                                  affine helpers, two modes: explicit
 *                                  (caller passes transform) or
 *                                  discovery (page-side probe of common
 *                                  app globals — Figma / Tldraw /
 *                                  Excalidraw / generic).
 *   - `canvas_query`             — dispatcher to a canvas-app adapter
 *                                  plugin (landed separately).
 *
 * Capability `canvas` — off-by-default, loud-warned at boot. Same posture
 * class as `eval` / `network-body` / `secrets` / `extensions` /
 * `device-emulation` / `diagnostics`. `canvas_diff` is pure-byte math
 * and rides `read` (no canvas-pixel touch of its own).
 *
 * The primitives are app-agnostic — discovery probes common globals but
 * those are heuristic; the structured failure path tells the caller to
 * pass `transform` explicitly OR install a canvas-app adapter plugin.
 * Honours the `feedback_design_for_problem_class` rule: build for the
 * problem class (canvas-app substrate), don't hard-bind to any one app.
 *
 * BYO-vision: browxai does NOT bundle OCR or a hosted vision API.
 * `canvas_capture` is the pixel source; composition with the host
 * agent's own multimodal vision is the loop (see `docs/tool-reference.md`
 * "Canvas-app automation — BYO vision pattern").
 */
export function registerCanvasTools(host: ToolHost): void {
  const { z, register, gateCheck, entryFor, cfgActionTimeout, toolHandlers } = host;

  register(
    "canvas_capture",
    {
      capability: "canvas",
      description:
        "Extract pixels from a `<canvas>` element. Use `screenshot` for what the viewport shows and this for the canvas buffer itself. Requires the `canvas` capability (off by default) and `read`. `format`: `png` (`canvas.toDataURL`, an encoded image for a vision call), `2d-imagedata` (raw RGBA bytes through `getImageData`, for `canvas_diff` pixel math) or `webgl-framebuffer` (raw RGBA through `gl.readPixels`, flipped to top-left order like `2d-imagedata`). `ref` (a canvas from `snapshot` or `find`) or `selector` picks the canvas; with neither, the first `<canvas>` in the document. Canvases over 16384x16384 pixels are refused with a `too-large` error. A canvas tainted by cross-origin images without CORS is refused with `taint-or-encode` or `taint-or-read`. A WebGL context created without `preserveDrawingBuffer:true` may read back as zeros; this tool asks for it when it creates the context but cannot change an existing one. `canvas_diff` compares PNG inputs by byte equality only, so use `2d-imagedata` or `webgl-framebuffer` for per-pixel diffs. For app-specific data (scene-graph node bounds, layer ids, frame names), install a canvas adapter plugin and call it through `canvas_query`.",
      inputSchema: {
        ref: z
          .string()
          .optional()
          .describe(
            "Stable [eN] ref of the canvas element. Omit to use the first `<canvas>` (with a `selector` fallback when supplied).",
          ),
        selector: z
          .string()
          .optional()
          .describe("Fallback CSS selector path used when `ref` does not resolve."),
        format: z
          .enum(["png", "webgl-framebuffer", "2d-imagedata"])
          .describe(
            "`png` → base64 PNG bytes (handoff to vision); `2d-imagedata` → base64 RGBA bytes (pixel math); `webgl-framebuffer` → base64 RGBA from `gl.readPixels`, flipped to top-left to match imagedata convention.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("canvas_capture");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          canvasCapture(requirePage(e.session), {
            ref: args.ref,
            selector: args.selector,
            format: args.format,
          }),
          cfgActionTimeout(),
          "canvas_capture",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
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
    "canvas_diff",
    {
      capability: "read",
      description:
        'Compute the pixel and region delta between two captured RGBA payloads. Pure function: it does not touch the page. Inputs are base64 RGBA byte arrays from `canvas_capture({format:"2d-imagedata"})` or `canvas_capture({format:"webgl-framebuffer"})`; `width` and `height` are required for them because the bytes carry no dimensions. `region` is an optional sub-rectangle in image px (top-left origin), clamped to the image. Returns `{ ok, changedPixelCount, changedBytes, percentageChanged, bboxOfChanges:{x,y,w,h}|null, warnings[] }`; `changedBytes` sums absolute per-channel deltas, a measure of how much changed. For PNG inputs pass `inputFormat:"png"`: it compares base64 byte equality only and adds a warning. Capability `read`.',
      inputSchema: {
        beforeBase64: z
          .string()
          .describe("Base64 RGBA bytes (or PNG when `inputFormat:'png'`) from a prior capture."),
        afterBase64: z.string().describe("Base64 RGBA bytes (or PNG) from a later capture."),
        width: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Pixel width of the captures. Required for RGBA inputs."),
        height: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Pixel height of the captures. Required for RGBA inputs."),
        region: z
          .object({
            x: z.number(),
            y: z.number(),
            w: z.number(),
            h: z.number(),
          })
          .optional()
          .describe("Optional sub-rectangle (image px, top-left origin)."),
        inputFormat: z
          .enum(["rgba", "png"])
          .optional()
          .describe(
            "Defaults `rgba`. Pass `png` for PNG-format inputs (this cycle: base64 byte equality only + warning).",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("canvas_diff");
      if (g) return g;
      try {
        const r = canvasDiff({
          beforeBase64: args.beforeBase64,
          afterBase64: args.afterBase64,
          ...(args.width !== undefined ? { width: args.width } : {}),
          ...(args.height !== undefined ? { height: args.height } : {}),
          ...(args.region ? { region: args.region } : {}),
          ...(args.inputFormat ? { inputFormat: args.inputFormat } : {}),
        });
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
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
    "gesture_chain",
    {
      capability: "canvas",
      description:
        "Run a scripted pointer program through the Playwright mouse pipeline: a list of `down`, `move`, `up`, `wait` and `wheel` steps, for paint strokes, lasso paths, signatures and other gestures that `drag`, `double_click` and `gesture_swipe` do not cover. Requires the `canvas` capability (off by default) and `action`. Each step is `{kind, x?, y?, deltaX?, deltaY?, ms?, pointerId?}`. `down`, `up` and `move` need numeric `x` and `y`; `move` takes an optional `ms` pacing delay (minimum 5); `wait` takes `ms` (max 5000; split longer waits across calls); `wheel` needs a non-zero `deltaX` or `deltaY` and optional `x` and `y` to move the pointer first. At most 200 steps per call. `pointerId` is accepted but there is a single mouse pointer: use `touch_*` or `gesture_pinch` for multi-touch. Returns `{ ok, stepsExecuted, totalDurationMs, warnings[] }`.",
      inputSchema: {
        steps: z
          .array(
            z.object({
              kind: z.enum(["down", "move", "up", "wait", "wheel"]),
              x: z.number().optional(),
              y: z.number().optional(),
              deltaX: z.number().optional(),
              deltaY: z.number().optional(),
              ms: z.number().nonnegative().optional(),
              pointerId: z.number().int().nonnegative().optional(),
            }),
          )
          .describe("Step list. Max 200 steps; `move` floored at 5 ms; `wait` clamped at 5000 ms."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("gesture_chain");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          runGestureChain(requirePage(e.session), { steps: args.steps }),
          cfgActionTimeout(),
          "gesture_chain",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
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
    "canvas_world_to_screen",
    {
      capability: "canvas",
      description:
        "Convert a world-space coordinate to screen space with an affine transform. Requires the `canvas` capability (off by default) and `read`. Two modes. Explicit: pass `transform: {scale, panX, panY, originX?, originY?}`, with `screenX = (worldX + panX) * scale + originX`. Discovery: omit `transform` and a page probe looks for common app globals (`app.viewport.zoom` and `app.viewport.center` for Figma or Excalidraw, `app.scale` and `app.offset` for Tldraw, `app.transform.matrix` as a 6-element affine). Success returns `{ok, screenX, screenY, transformDiscovered, adapterHint:'figma'|'tldraw'|'excalidraw'|'generic', warnings}`; failure returns `{ok:false, code:'no-transform'}`, so pass `transform` explicitly or use a canvas adapter plugin. Discovery is heuristic: pass `transform` explicitly for anything you depend on. The inverse is `canvas_screen_to_world`.",
      inputSchema: {
        worldX: z.number().describe("World-space X coordinate."),
        worldY: z.number().describe("World-space Y coordinate."),
        ref: z
          .string()
          .optional()
          .describe("Stable canvas ref. Not used for math today; reserved for adapter dispatch."),
        selector: z
          .string()
          .optional()
          .describe(
            "Canvas selector path. Not used for math today; reserved for adapter dispatch.",
          ),
        transform: z
          .object({
            scale: z.number(),
            panX: z.number(),
            panY: z.number(),
            originX: z.number().optional(),
            originY: z.number().optional(),
          })
          .optional()
          .describe("Explicit transform. Omit to trigger heuristic discovery."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("canvas_world_to_screen");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          canvasWorldToScreen(requirePage(e.session), {
            worldX: args.worldX,
            worldY: args.worldY,
            ...(args.ref ? { ref: args.ref } : {}),
            ...(args.selector ? { selector: args.selector } : {}),
            ...(args.transform ? { transform: args.transform } : {}),
          }),
          cfgActionTimeout(),
          "canvas_world_to_screen",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
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
    "canvas_screen_to_world",
    {
      capability: "canvas",
      description:
        "Inverse of `canvas_world_to_screen`: convert a screen-space coordinate to world space. Requires the `canvas` capability (off by default) and `read`. Explicit: `transform: {scale, panX, panY, originX?, originY?}`, with `worldX = (screenX - originX) / scale - panX`. Discovery: omit `transform` and the same page probe as the forward tool runs. Success returns `{ok, worldX, worldY, transformDiscovered, adapterHint, warnings}`; failure returns `{ok:false, code:'no-transform'}`. Round-trips with `canvas_world_to_screen` under the same explicit transform, to floating-point precision.",
      inputSchema: {
        screenX: z.number().describe("Screen-space X coordinate (viewport CSS px)."),
        screenY: z.number().describe("Screen-space Y coordinate (viewport CSS px)."),
        ref: z.string().optional().describe("Stable canvas ref. Reserved for adapter dispatch."),
        selector: z
          .string()
          .optional()
          .describe("Canvas selector path. Reserved for adapter dispatch."),
        transform: z
          .object({
            scale: z.number(),
            panX: z.number(),
            panY: z.number(),
            originX: z.number().optional(),
            originY: z.number().optional(),
          })
          .optional()
          .describe("Explicit transform. Omit to trigger heuristic discovery."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("canvas_screen_to_world");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          canvasScreenToWorld(requirePage(e.session), {
            screenX: args.screenX,
            screenY: args.screenY,
            ...(args.ref ? { ref: args.ref } : {}),
            ...(args.selector ? { selector: args.selector } : {}),
            ...(args.transform ? { transform: args.transform } : {}),
          }),
          cfgActionTimeout(),
          "canvas_screen_to_world",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
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
    "canvas_query",
    {
      capability: "canvas",
      description:
        "Route a call to a canvas-app adapter plugin. `adapter` is the namespace of a loaded plugin (such as `\"figma\"`); the tool looks up `<adapter>.<op>` in the live plugin tool registry and forwards `args`. With no matching plugin it returns `{ok:false, code:'no-adapter', requestedAdapter, requestedOp}`: install `@browxai/plugin-<adapter>` (figma, tldraw or excalidraw; see docs/plugins-first-party.md) and check `plugins_list`. Requires the `canvas` capability (off by default); the inner plugin tool's own capability is enforced when it is reached.",
      inputSchema: {
        adapter: z.string().describe('Plugin namespace to route to (e.g. `"figma"`).'),
        op: z
          .string()
          .describe(
            "Operation name under the plugin's namespace — combined as `<adapter>.<op>` for the registry lookup.",
          ),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Forwarded as the inner tool's args."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("canvas_query");
      if (g) return g;
      const targetName = `${args.adapter}.${args.op}`;
      const fn = toolHandlers[targetName];
      if (!fn) {
        const body = noAdapterError(args.adapter, args.op);
        const json = JSON.stringify(body);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...body, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      }
      // Forward through the live (wrapped) handler — this routes through
      // the plugin runtime's capability gate + metrics + diagnostics
      // wrap, identical to a direct MCP call on the inner tool.
      const inner = await fn({
        ...(args.args ?? {}),
        ...(args.session !== undefined ? { session: args.session } : {}),
      });
      return inner;
    },
  );
}
