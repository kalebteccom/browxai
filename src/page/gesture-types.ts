// The gesture vocabulary the ActionSubstrate port declares — touch, swipe and
// pinch as ONE request union, plus the per-kind evidence bodies and the engine
// refusal both adapters emit.
//
// WHY ONE MEMBER AND NOT THREE VERBS. `ActionSubstrate` already names twelve
// verbs, and RFC 0009 left "does it split at fifteen or take a documented ceiling
// exception" open. The prior-art pass supplies a third answer: WebDriver BiDi's
// `input` module is THREE commands total (`performActions`, `releaseActions`,
// `setFiles`) and expresses swipe, pinch and multi-touch as one source-and-action
// sequence passed to `performActions`. The member-count argument is right and the
// repo already has the shape for it — `ElementSubstrate.probe(el, want)` (RFC
// 0009 P2) is one call taking a discriminated request so a fifth reading does not
// add a fifth member.
//
// What is NOT adopted is W3C Actions' literal sequence structure. That structure
// carries a per-source INPUT STATE that `releaseActions` unwinds: a `pointerDown`
// leaves the pointer down in the session's state table, and every later event has
// to re-send every still-active pointer. browxai's touch pipeline has never had
// that table — `touchAction` dispatches ONE `touchPoints` entry per call, so
// finger #2 is absent from every event after the `touch_start` that placed it.
// Adopting the standard's shape faithfully means building the state table and
// changing what five shipped tools put on the wire. That is a behaviour change,
// and this phase forbids one. So: one member, a closed union of the three
// gestures browxai actually dispatches, and the sequence structure left to
// whoever needs `releaseActions`.
//
// The second reason is the consumer. On a native engine (RFC 0008) a swipe is a
// PRIMITIVE — `mobile: dragFromToForDuration`, `XCUIElement.swipeUp` — not three
// touch dispatches. A port that named only `touch` would force every native
// adapter to synthesise swipe from touch events, which is the opposite of what
// the platform exposes. Naming swipe and pinch as their own request kinds lets a
// native adapter answer each with its own primitive.
//
// Every declaration here is plain data: numbers, string unions, plain objects.
// Nothing reaches playwright-core, which is what lets `action-substrate-types.ts`
// name this module and keep `ports-name-no-vendor-type` (reachable) green.
// (RFC 0009 P3.)

/** A viewport point in CSS pixels. */
export interface Point {
  x: number;
  y: number;
}

/** One phase of the raw touch pipeline. `end` is the only phase that may carry no
 *  coordinates — the spec's "all fingers up" form. */
export type TouchPhase = "start" | "move" | "end";

/** `touch_start` / `touch_move` / `touch_end` — one event, one finger. */
export interface TouchRequest {
  kind: "touch";
  phase: TouchPhase;
  coords?: Point;
  /** DOM `TouchEvent.changedTouches[].identifier`; distinct ids fan out to
   *  distinct fingers. Defaults to 1 in the adapter, as it did in the handler. */
  identifier?: number;
}

/** `gesture_swipe` — single-finger drag on the touch pipeline. */
export interface SwipeRequest {
  kind: "swipe";
  from: Point;
  to: Point;
  durationMs?: number;
  steps?: number;
  identifier?: number;
}

/** `gesture_pinch` — two fingers converging on or diverging from `coords`. */
export interface PinchRequest {
  kind: "pinch";
  coords: Point;
  scale: number;
  steps?: number;
  startOffset?: number;
}

export type GestureRequest = TouchRequest | SwipeRequest | PinchRequest;

/** The evidence body a dispatched touch reports. Field-for-field what
 *  `touchAction` returned to the handler before the seam. */
export interface TouchReport {
  ok: boolean;
  action: TouchPhase;
  coords?: Point;
  identifier: number;
}

/** The evidence body a dispatched swipe reports. */
export interface SwipeReport {
  ok: boolean;
  from: Point;
  to: Point;
  steps: number;
  durationMs: number;
}

/** The evidence body a dispatched pinch reports. */
export interface PinchReport {
  ok: boolean;
  coords: Point;
  scale: number;
  steps: number;
  startOffset: number;
  endOffset: number;
}

/** The gesture was dispatched. `report` is the per-kind body the tool renders
 *  VERBATIM — nested rather than spread into the result so the discriminant never
 *  reaches the wire and the rendered JSON is byte-identical to the pre-seam one. */
export interface GestureDispatched {
  kind: "dispatched";
  report: TouchReport | SwipeReport | PinchReport;
}

/** The engine cannot dispatch this gesture. Carries the three fields the shared
 *  engine-refusal envelope renders (`error` / `engine` / `hint`), so a caller
 *  classifies "this engine cannot" by the same shape whether the refusal came
 *  from the gate or from here. */
export interface GestureRefusal {
  kind: "refusal";
  error: string;
  engine: string;
  hint: string;
}

export type GestureResult = GestureDispatched | GestureRefusal;

/** The tool name a request came from. The five registrations map 1:1 onto the
 *  request union, so the adapter can name the tool in its refusal without the
 *  handler passing it — and the refusal text stays identical to the engine gate's,
 *  which is keyed on the tool name. */
export function gestureToolName(req: GestureRequest): string {
  switch (req.kind) {
    case "touch":
      return `touch_${req.phase}`;
    case "swipe":
      return "gesture_swipe";
    case "pinch":
      return "gesture_pinch";
  }
}

/** The named refusal reason for the touch pipeline on an engine with no CDP
 *  escape hatch. Greppable, and the thing a test asserts on instead of prose. */
export const TOUCH_DISPATCH_ENGINE_REFUSAL = "touch-dispatch-needs-cdp";

/** Structured refusal for a gesture on an engine that cannot dispatch it.
 *
 *  `error` is CHARACTER-IDENTICAL to what `assertEngineSupports` produced while
 *  these five tools carried `deep: true`, because that is the string an agent (or
 *  a recorded transcript) may already be matching on. The `hint` is narrower than
 *  the generic deep-tool hint it replaces: it names the one CDP domain this tool
 *  needs instead of listing eight unrelated ones, and it says why there is no
 *  page-JS fallback. Same refusal, same envelope, a reason that fits the tool. */
export function touchDispatchUnsupported(req: GestureRequest, engine: string): GestureRefusal {
  const tool = gestureToolName(req);
  return {
    kind: "refusal",
    error: `tool "${tool}" is not supported on the "${engine}" engine`,
    engine,
    hint:
      `${TOUCH_DISPATCH_ENGINE_REFUSAL}: \`${tool}\` dispatches through CDP ` +
      "`Input.dispatchTouchEvent`, and that escape hatch exists only on chromium-family " +
      "engines. Playwright has no cross-engine touch-event dispatcher, and synthesising the " +
      "events in page JS would produce isTrusted:false events that framework handlers drop " +
      "silently — so there is no fallback and this is a refusal, not a degraded result. " +
      'Re-run on a chromium session (browserType:"chromium", the default), or check the ' +
      "per-engine capability matrix in docs/ai-context/architecture/engine-adapters.md.",
  };
}
