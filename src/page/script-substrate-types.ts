// The ScriptSubstrate port — the engine-agnostic seam beneath page-side JS
// evaluation (`eval_js` today; `exposeBinding` / `addInitScript` later). The
// `eval_js` handler asks a substrate to evaluate an expression and gets back the
// page-controlled value; an engine-specific implementation does the work. The
// handler never names Playwright, safaridriver, or an engine — it calls
// `scriptFor(e).evaluate(expr)`, the same shape as `actionsFor(e).click(args)`.
//
// Dependency direction (architecture doctrine §1): tool handler → ScriptSubstrate
// (this port) → implementation → Playwright | safaridriver. Split out of
// `script-substrate.ts` so the port module names no vendor type; the two
// implementations live in `script-substrate-playwright.ts` and
// `script-substrate-safari.ts`. Re-exported through `./script-substrate.js` so
// callers import unchanged. (RFC 0009 P1.)

/** The script capability port. One instance wraps one session's engine handle;
 *  the method carries no engine type, so the handler above this seam is
 *  engine-blind. Mirrors the ActionSubstrate / CaptureSubstrate shape. The
 *  returned value is page-controlled (untrusted); the handler treats it the same
 *  as snapshot text. The deadline race + error envelope stay in the handler — the
 *  substrate only performs the raw evaluation. */
export interface ScriptSubstrate {
  readonly engine: string;
  evaluate(expr: string): Promise<unknown>;
}
