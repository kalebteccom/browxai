/// <reference lib="dom" />
// Canvas-app automation primitives — capability `canvas`.
//
// The substrate. Five MCP tools + a pure-math diff, split across cohesive
// sibling modules and re-exported here so `../page/canvas.js` stays the single
// public barrel (callers and tests import unchanged):
//
//   - `canvas_capture`           — framebuffer / 2D ImageData / PNG bytes
//                                  of a `<canvas>` element. App-agnostic.
//                                  → ./canvas-capture.js
//   - `canvas_diff`              — pixel/region delta between two RGBA
//                                  captures. Pure function over bytes;
//                                  no page contact. → ./canvas-diff.js
//   - `gesture_chain`            — multi-step pointer program (down /
//                                  move / wheel / wait / up). Custom
//                                  paint strokes, lasso paths, gestures
//                                  the canned `drag` / `gesture_swipe`
//                                  family doesn't cover. → ./canvas-gesture.js
//   - `canvas_world_to_screen` + `canvas_screen_to_world` —
//                                  affine transform helpers, two modes:
//                                  explicit (caller passes transform)
//                                  or discovery (probe common app-side
//                                  globals — Figma / Tldraw / Excalidraw
//                                  shapes; documented as heuristic).
//                                  → ./canvas-transform.js
//   - `canvas_query`             — dispatcher to a canvas-app adapter
//                                  plugin. The router lives in
//                                  server.ts (it has the plugin handler
//                                  map); only the structured no-adapter
//                                  error shape lives here. → ./canvas-transform.js
//
// Design principle (project-wide, see CLAUDE.md
// `feedback_design_for_problem_class`): the primitives are app-agnostic.
// Discovery probes common globals — those are HEURISTIC; the structured
// failure path tells the caller to pass `transform` explicitly OR install
// a canvas-app adapter plugin.
//
// BYO-vision pattern (docs only this cycle, see docs/tool-reference.md
// "Canvas-app automation — BYO vision pattern"): browxai does NOT bundle
// OCR or a hosted vision API. `canvas_capture` is the pixel source;
// composition with the host agent's own multimodal vision is the loop.
//
// Bounded:
//   - canvas_capture refuses canvases larger than 16384×16384 pixels.
//   - gesture_chain caps at 200 steps, floors `move` step delays at 5 ms,
//     bounds `wait` steps at 5000 ms.

export type {
  CanvasFormat,
  CanvasCaptureArgs,
  CanvasCapturePngResult,
  CanvasCaptureRgbaResult,
  CanvasCaptureResult,
  PageCaptureRaw,
  CanvasCapturePage,
} from "./canvas-capture.js";
export { CANVAS_MAX_DIMENSION, PAGE_CAPTURE_FN, canvasCapture } from "./canvas-capture.js";

export type { CanvasDiffRegion, CanvasDiffArgs, CanvasDiffResult } from "./canvas-diff.js";
export { diffRgba, canvasDiff } from "./canvas-diff.js";

export type {
  GestureChainStepKind,
  GestureChainStep,
  GestureChainArgs,
  GestureChainResult,
  ValidateGestureChainResult,
  GestureChainPage,
} from "./canvas-gesture.js";
export {
  GESTURE_CHAIN_MAX_STEPS,
  GESTURE_CHAIN_MIN_MOVE_MS,
  GESTURE_CHAIN_MAX_WAIT_MS,
  validateGestureChain,
  runGestureChain,
} from "./canvas-gesture.js";

export type {
  CanvasTransform,
  CanvasAdapterHint,
  CanvasWorldToScreenArgs,
  CanvasScreenToWorldArgs,
  CanvasWorldToScreenResult,
  CanvasScreenToWorldResult,
  CanvasDiscoverPage,
  CanvasQueryArgs,
  CanvasQueryNoAdapterError,
} from "./canvas-transform.js";
export {
  applyWorldToScreen,
  applyScreenToWorld,
  PAGE_DISCOVER_TRANSFORM_FN,
  canvasWorldToScreen,
  canvasScreenToWorld,
  noAdapterError,
} from "./canvas-transform.js";
