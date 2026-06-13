import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import {
  canvasCapture,
  canvasDiff,
  canvasScreenToWorld,
  canvasWorldToScreen,
  noAdapterError,
  runGestureChain,
  type GestureChainStep,
} from "../page/canvas.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

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
      description:
        "Extract framebuffer or 2D ImageData from a `<canvas>` element on the page. Three output formats: `png` (`canvas.toDataURL` — encoded image suitable for handoff to a host-agent multimodal vision call), `2d-imagedata` (raw RGBA bytes via `getImageData` — feed to `canvas_diff` for pixel math), `webgl-framebuffer` (raw RGBA via `gl.readPixels` on a WebGL/WebGL2 context, flipped into top-left order to match `2d-imagedata` convention). `ref` optional (canvas element ref from a prior `snapshot()`/`find()`); `selector` is a fallback selector path; omitting both targets the first `<canvas>` in the document. Bounded: canvases larger than 16384×16384 pixels refuse with a structured `too-large` error (defensive cap — most editors stay well below this; a multi-megapixel buffer round-tripped through base64 is genuinely a problem). PNG-format inputs to `canvas_diff` are byte-equality only this cycle (decoded-pixel diff is a follow-up); for per-pixel math + bbox, prefer `2d-imagedata` or `webgl-framebuffer`. Tainted canvases (cross-origin images without CORS) refuse with a `taint-or-encode` / `taint-or-read` error. WebGL contexts created without `preserveDrawingBuffer:true` may read back as zero bytes; `canvas_capture` requests `preserveDrawingBuffer:true` when it acquires the context but can't undo a prior context's choice. App-agnostic — for app-specific extraction (scene-graph node bounds, layer ids, frame names) install a canvas-app adapter plugin and call through `canvas_query`. Capability `canvas` (+ `read`).",
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
          canvasCapture(e.session.page(), {
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
      description:
        "Compute pixel/region delta between two captured RGBA payloads. Pure function — no page contact. Inputs are base64 RGBA byte arrays from a prior `canvas_capture({format:'2d-imagedata'})` or `canvas_capture({format:'webgl-framebuffer'})`. `width` + `height` are required (the byte buffer alone does not carry dimensions). `region` is an optional sub-rectangle (in image px, top-left origin); over-flow regions clamp to image bounds. → `{ ok, changedPixelCount, changedBytes, percentageChanged, bboxOfChanges:{x,y,w,h}|null, warnings[] }`. `changedBytes` is the sum of absolute per-channel deltas (useful for 'how much changed', not just 'did anything'). For PNG-format inputs: pass `inputFormat:'png'` — this cycle compares base64 byte equality only and surfaces a warning; per-pixel diff over PNG is a follow-up. Capability `read` (no canvas-pixel touch of its own; pure math over caller-supplied bytes).",
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
      description:
        "Multi-step pointer program — drive a sequence of `down` / `move` / `up` / `wait` / `wheel` events through the standard Playwright mouse pipeline. For custom paint strokes, lasso paths, hand-drawn gestures, signature widgets — anything the canned `drag` / `double_click` / `gesture_swipe` family doesn't cover. Each step: `{kind, x?, y?, deltaX?, deltaY?, ms?, pointerId?}`. `down` / `up` / `move` require numeric `x` + `y`; `move` accepts an optional `ms` pacing delay (floored at 5 ms — tighter pacing rarely changes app behaviour and starves the renderer); `wait` accepts `ms` (clamped at 5000 ms — split longer waits across calls); `wheel` requires non-zero `deltaX` or `deltaY` and accepts optional `x` + `y` to move the pointer first. Bounded at 200 steps total — split larger programs across multiple calls. → `{ ok, stepsExecuted, totalDurationMs, warnings[] }`. `pointerId` is accepted on input but the v1 implementation routes through Playwright's single-mouse pipeline (multi-pointer fan-out is a future extension — for multi-touch today use `touch_*` / `gesture_pinch`). Capability `canvas` (+ `action`).",
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
          runGestureChain(e.session.page(), { steps: args.steps as GestureChainStep[] }),
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
      description:
        "Translate a world-space coordinate to a screen-space coordinate via an affine transform. Two modes: **explicit** (caller passes `transform: {scale, panX, panY, originX?, originY?}` — math: `screenX = (worldX + panX) * scale + originX`); **discovery** (omit `transform` — the page-side probe walks common app-side globals: `app.viewport.zoom` + `app.viewport.center` (Figma / Excalidraw shape), `app.scale` + `app.offset` (Tldraw shape), `app.transform.matrix` (generic 6-element affine). On discovery success, returns `{ok, screenX, screenY, transformDiscovered, adapterHint: 'figma'|'tldraw'|'excalidraw'|'generic', warnings:[\"discovery probes are HEURISTIC — …\"]}`. On discovery failure: `{ok:false, error:'no transform discoverable — pass `transform` explicitly OR use a canvas-app adapter plugin', code:'no-transform'}`. Discovery is HEURISTIC by design — for production, pass `transform` explicitly or install a canvas-app adapter plugin. Capability `canvas` (+ `read`).",
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
          canvasWorldToScreen(e.session.page(), {
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
      description:
        "Inverse of `canvas_world_to_screen`. Translate a screen-space coordinate to a world-space coordinate. Two modes: **explicit** (`transform: {scale, panX, panY, originX?, originY?}` — math: `worldX = (screenX - originX) / scale - panX`); **discovery** (omit `transform` — same page-side probe as the forward call). Discovery success: `{ok, worldX, worldY, transformDiscovered, adapterHint, warnings:[…HEURISTIC…]}`. Discovery failure: `{ok:false, error:'no transform discoverable — pass `transform` explicitly OR use a canvas-app adapter plugin', code:'no-transform'}`. Round-trips with `canvas_world_to_screen` to within floating-point precision under the same explicit transform. Capability `canvas` (+ `read`).",
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
          canvasScreenToWorld(e.session.page(), {
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
      description:
        "Dispatcher routing to a canvas-app adapter plugin's handler. `adapter` is the namespace of a loaded plugin (e.g. `\"figma\"`); the tool looks up `<adapter>.<op>` in the live plugin tool registry and forwards `args`. If no plugin matches: `{ok:false, error:'no canvas adapter registered for <adapter>; install @browxai/plugin-<adapter> or pass a registered adapter namespace', code:'no-adapter', requestedAdapter, requestedOp}`. The inner plugin tool's capability is enforced via the plugin call-graph gate when reached. The host ships the dispatcher; the first-party canvas-app adapter plugins (`@browxai/plugin-figma`, `@browxai/plugin-tldraw`, `@browxai/plugin-excalidraw`) install separately — see docs/plugins-first-party.md for each adapter's op surface. Capability `canvas` (+ the inner tool's own capability via the plugin runtime gate).",
      inputSchema: {
        adapter: z.string().describe('Plugin namespace to route to (e.g. `"figma"`).'),
        op: z
          .string()
          .describe(
            "Operation name under the plugin's namespace — combined as `<adapter>.<op>` for the registry lookup.",
          ),
        args: z.record(z.unknown()).optional().describe("Forwarded as the inner tool's args."),
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
