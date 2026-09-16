// SafariElementSubstrate — the ElementSubstrate position for the safari engine,
// which is a REFUSAL on all four members.
//
// Safari declares no `element` sub-interface, so `subInterfaceGate` refuses every
// consumer tool upstream and this class is never reached on the shipped path. It
// exists anyway, and it refuses rather than answering, because of a defect this
// port's own prior art found in the sibling port: `SafariNoopNetworkSubstrate`
// answers `http.recent()` with `{summary:{total:0,…}, requests:[]}` under a
// comment saying "the gate refuses the tools first" — and for `network_read` the
// gate did not. An agent asking a Safari session what traffic it saw was told
// "none", which is indistinguishable from a true negative. For a product whose
// output is QA evidence, a plausible empty answer is the worst failure mode
// available; a refusal that names the engine is the correct one.
//
// So: no empty `Rect`, no `matches: 0`, no `visible: false`. Four refusals
// carrying `engine-unsupported` and a hint naming what to do instead. If Safari
// later grows a real WebDriver-Classic element implementation — `POST
// /session/:id/elements` for resolution, `GET /element/:id/rect` for bounds,
// `/text` and `/attribute/:name` for the reads — it replaces this class and
// safari's capability row adds `element` in the same commit. That is a feature
// with its own tests and its own CHANGELOG entry, not a refactor.
//
// Dependency direction (architecture doctrine §1): tool handler → ElementSubstrate
// (the port in `element-substrate-types.ts`) → this implementation. This file
// never imports back from the `element-substrate.js` barrel.

import type {
  ElementBoundsResult,
  ElementCountResult,
  ElementProbeResult,
  ElementRefusal,
  ElementResolution,
  ElementSubstrate,
} from "./element-substrate-types.js";

const REFUSAL: ElementRefusal = {
  kind: "refusal",
  reason: "engine-unsupported",
  error:
    'the safari engine declares no "element" sub-interface — it resolves elements over WebDriver ' +
    "Classic element ids, which no ElementSubstrate implementation drives yet",
  hint:
    "Use a chromium, firefox, webkit or android session for element resolution, measurement and " +
    "the verify_* family. `snapshot`, `find`, `navigate`, `click`, `fill` and `press` work on safari.",
};

export class SafariElementSubstrate implements ElementSubstrate {
  readonly engine = "safari";

  async resolve(): Promise<ElementResolution> {
    return REFUSAL;
  }

  async bounds(): Promise<ElementBoundsResult> {
    return REFUSAL;
  }

  async probe(): Promise<ElementProbeResult> {
    return REFUSAL;
  }

  async count(): Promise<ElementCountResult> {
    return REFUSAL;
  }
}
