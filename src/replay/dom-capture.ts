// DOM stream capture (RFC 0007). rrweb records the page; every rrweb event is
// carried verbatim as the payload of one `dom/rrweb` envelope from
// `./schema.js`. The envelope, the clock and the schema version stay ours, so
// the recorder is swappable without changing the artifact format.
//
// rrweb arrives as a UMD BUNDLE injected via `addInitScript`, not as a browxai
// page-side function literal, so the stringified-arrow trap
// (docs/ai-context/page-side-functions/dom-export-trap.md) does not apply to
// the bundle. It DOES apply to the way events come back: they cross to Node
// through an `exposeBinding` whose page-side call passes a JSON STRING, the
// same shape every `src/session/*-attach.ts` binding uses, because a function
// or an exotic object cannot be serialised across CDP.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { log } from "../util/logging.js";
import type { ReplayEvent } from "./schema.js";

/** Page-side globals. Kept in one place because the init script, the stop
 *  script and the Node-side binding registration all have to agree. */
const EMIT_BINDING = "__browx_rrweb_emit";

const INSTALL_FLAG = "__browx_rrweb_installed";
const STOP_FN = "__browx_rrweb_stop";

/** A page that has not navigated yet. `page.url()` is synchronous and reads the
 *  last committed URL, so this never races the emit path. */
function isBlankDocument(page: Page): boolean {
  const url = page.url();
  return url === "" || url === "about:blank";
}

export const DOM_EVENT_TYPE = "dom/rrweb";
export const DOM_PAYLOAD_VERSION = 1;

/** `input[type=password]` is masked whatever the caller asks for. */
const ALWAYS_MASKED_SELECTOR = "input[type=password]";

/** Every rrweb input-type key except `select` — masking a `<select>` also drops
 *  `option.selected`, which costs replay fidelity for no privacy gain. */
const MASKABLE_INPUT_TYPES = [
  "color",
  "date",
  "datetime-local",
  "email",
  "month",
  "number",
  "range",
  "search",
  "tel",
  "text",
  "time",
  "url",
  "week",
  "textarea",
  "password",
] as const;

export interface DomCaptureOptions {
  /** Unix ms. Every emitted `t` is relative to it (`ReplayManifest.clockOrigin`). */
  clockOrigin: number;
  /** Every rrweb event, wrapped in the browxai envelope. The registered-secret
   *  mask does NOT run here — the ONE chokepoint is `Redactor.mask` in
   *  `src/replay/redact.ts`, and `session.ts` routes this callback's output
   *  through `redactEvent` before appending to the log. Keeping the mask off
   *  this file was the fix for the drift that leaked page text past the
   *  bounded-depth cap. */
  onEvent: (event: ReplayEvent<unknown>) => void;
  /** Extra CSS selectors masked on top of `input[type=password]`. */
  maskSelectors?: string[];
  /** RFC 0005 target identity for a page. Defaults to a stable synthetic id;
   *  the session layer passes the pool's real CDP target id. */
  targetIdFor?: (page: Page) => string | undefined;
  /** How many targets the session currently holds. `targetId` is written only
   *  when this is > 1. Defaults to the context's page count. */
  targetCount?: () => number;
  now?: () => number;
}

export interface DomCaptureHandle {
  detach(): Promise<void>;
  /** Envelopes handed to `onEvent` since attach. */
  readonly eventCount: number;
}

interface Attachment {
  sink: (json: string, page: Page | undefined) => void;
}

/** One binding per context. A second `attachDomCapture` on the same context
 *  re-points the sink instead of re-registering, because Playwright rejects a
 *  duplicate `exposeBinding` name and the page-side guard would refuse the
 *  second recorder anyway. */
const attachments = new WeakMap<BrowserContext, Attachment>();

let bundleCache: string | undefined;

/** The rrweb UMD bundle source. Resolved through the package entry and then by
 *  sibling filename: `rrweb`'s `exports` map has no subpath for the UMD build,
 *  so resolving `rrweb/dist/...` directly throws ERR_PACKAGE_PATH_NOT_EXPORTED. */
export function rrwebBundleSource(): string {
  if (bundleCache !== undefined) return bundleCache;
  const require = createRequire(import.meta.url);
  const entry = require.resolve("rrweb");
  bundleCache = readFileSync(join(dirname(entry), "rrweb.umd.min.cjs"), "utf-8");
  return bundleCache;
}

/** Wrap the bundle so it always publishes `globalThis.rrweb`. The UMD header
 *  prefers CommonJS and AMD when it finds them, and a page that ships RequireJS
 *  would otherwise capture rrweb into an anonymous module and leave no global. */
function wrapBundle(bundle: string): string {
  return `(function () {\nvar define = void 0, exports = void 0, module = void 0;\n${bundle}\n}).call(globalThis);`;
}

function starterScript(maskSelectors: string[]): string {
  const config = JSON.stringify({
    binding: EMIT_BINDING,
    flag: INSTALL_FLAG,
    stop: STOP_FN,
    always: ALWAYS_MASKED_SELECTOR,
    extra: maskSelectors.join(","),
    inputTypes: MASKABLE_INPUT_TYPES,
  });
  return `(function () {
  var C = ${config};
  var w = globalThis;
  if (w[C.flag]) return;
  var rr = w.rrweb;
  if (!rr || typeof rr.record !== "function") return;
  w[C.flag] = true;

  var pending = [];
  var waiting = false;
  function flush() {
    var fn = w[C.binding];
    if (typeof fn !== "function") { setTimeout(flush, 20); return; }
    waiting = false;
    while (pending.length) { try { fn(pending.shift()); } catch (e) { return; } }
  }
  function send(line) {
    var fn = w[C.binding];
    if (typeof fn === "function" && !pending.length) { try { fn(line); } catch (e) {} return; }
    if (pending.length > 5000) pending.shift();
    pending.push(line);
    if (!waiting) { waiting = true; flush(); }
  }

  var maskSel = C.always + (C.extra ? "," + C.extra : "");
  function masked(el) {
    try { return !!(el && el.matches && (el.matches(maskSel) || (el.closest && el.closest(maskSel)))); }
    catch (e) { return true; }
  }
  var inputOptions = {};
  for (var i = 0; i < C.inputTypes.length; i++) inputOptions[C.inputTypes[i]] = true;

  w[C.stop] = rr.record({
    emit: function (e) { try { send(JSON.stringify(e)); } catch (err) {} },
    maskInputOptions: inputOptions,
    maskInputFn: function (text, el) {
      try { return masked(el) ? "*".repeat(String(text).length) : text; }
      catch (e) { return "*".repeat(String(text || "").length); }
    },
    maskTextSelector: C.extra || null,
    inlineStylesheet: true,
    recordCrossOriginIframes: true,
    collectFonts: false,
  });
})();`;
}

/** Shadow DOM and same-origin iframes need no flag: rrweb's serialiser walks
 *  `shadowRoot` and same-origin frame documents from the top-level recorder.
 *  `recordCrossOriginIframes` is what stops a same-origin subframe from
 *  starting a SECOND recorder and emitting a duplicate full snapshot — in a
 *  subframe that path returns a no-op, and a cross-origin subframe forwards to
 *  the parent instead. Playwright's `addInitScript` runs in every frame, so
 *  without it every iframe would emit its own stream. */
function initScript(maskSelectors: string[]): string {
  return `${wrapBundle(rrwebBundleSource())}\n${starterScript(maskSelectors)}`;
}

/** Wrap one rrweb event in the browxai envelope. `targetId` is written only on
 *  a multi-target session, and is ABSENT (not `undefined`) otherwise so the
 *  serialised line stays small on the common single-tab path. */
export function toReplayEvent(
  payload: unknown,
  ctx: { t: number; targetId?: string | undefined; multiTarget: boolean },
): ReplayEvent<unknown> {
  const event: ReplayEvent<unknown> = {
    t: Math.max(0, Math.round(ctx.t)),
    type: DOM_EVENT_TYPE,
    v: DOM_PAYLOAD_VERSION,
    payload,
  };
  if (ctx.multiTarget && ctx.targetId !== undefined) event.targetId = ctx.targetId;
  return event;
}

/** The rrweb event's own `timestamp` is when the page saw it; Node arrival time
 *  is later by the binding round-trip. Prefer the former so a DOM mutation and
 *  a CDP network event land in the right order on one timeline. */
export function eventTimestamp(payload: unknown, clockOrigin: number, fallback: number): number {
  const ts = (payload as { timestamp?: unknown } | null)?.timestamp;
  const at = typeof ts === "number" && Number.isFinite(ts) ? ts : fallback;
  return at - clockOrigin;
}

function syntheticTargetIds(): (page: Page) => string {
  const ids = new WeakMap<Page, string>();
  let next = 0;
  return (page) => {
    let id = ids.get(page);
    if (id === undefined) {
      next += 1;
      id = `dom-target-${next}`;
      ids.set(page, id);
    }
    return id;
  };
}

/**
 * Inject rrweb into every page of `context` and emit each rrweb event as one
 * `dom/rrweb` envelope. Injection is `addInitScript` on the CONTEXT, so the
 * bundle is re-injected on every new document and runs before any page script:
 * a bundle that lands late produces a full snapshot of an already-mutated DOM
 * and the replay starts from a page that never existed.
 */
export async function attachDomCapture(
  context: BrowserContext,
  options: DomCaptureOptions,
): Promise<DomCaptureHandle> {
  const maskSelectors = (options.maskSelectors ?? []).filter((s) => s.trim().length > 0);
  const now = options.now ?? (() => Date.now());
  const fallbackTargetId = syntheticTargetIds();
  const targetIdFor = options.targetIdFor ?? fallbackTargetId;
  const targetCount = options.targetCount ?? (() => context.pages().length);

  let count = 0;
  let detached = false;

  const sink = (json: string, page: Page | undefined): void => {
    if (detached) return;
    // Capture attaches to the CONTEXT, so a page sitting on `about:blank`
    // records a meta + full snapshot before the session navigates anywhere.
    // rrweb replays from the last snapshot at or before the playhead, so those
    // two events make every replay open on a blank frame. Dropping them costs
    // nothing: there is no page state worth reviewing, and the real navigation
    // emits its own snapshot immediately after.
    if (page !== undefined && isBlankDocument(page)) return;
    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch (err) {
      log.warn("replay.dom-capture: unparseable rrweb payload", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // Masking runs downstream through `Redactor.mask` (the ONE chokepoint).
    // rrweb's own options cover the DOM side (`input[type=password]` + any
    // extra `maskSelectors`); the registered-secret pass runs on the assembled
    // envelope in `session.ts`, so a value that rrweb ignores (a token
    // rendered as page text, a header echoed into a data attribute) is still
    // stripped before the event reaches disk.
    const targetId = page ? targetIdFor(page) : undefined;
    count += 1;
    options.onEvent(
      toReplayEvent(payload, {
        t: eventTimestamp(payload, options.clockOrigin, now()),
        targetId,
        multiTarget: targetCount() > 1,
      }),
    );
  };

  const existing = attachments.get(context);
  if (existing) {
    existing.sink = sink;
  } else {
    const attachment: Attachment = { sink };
    attachments.set(context, attachment);
    await installBinding(context, attachment);
    await installInitScript(context, maskSelectors);
  }

  return {
    get eventCount() {
      return count;
    },
    async detach() {
      detached = true;
      await stopRecorders(context);
    },
  };
}

async function installBinding(context: BrowserContext, attachment: Attachment): Promise<void> {
  try {
    await context.exposeBinding(EMIT_BINDING, (source, payload: string) => {
      attachment.sink(payload, source.page);
    });
  } catch (err) {
    // Already-registered is the expected failure on BYOB multi-attach, where
    // another browxai process owns the binding on the same Chrome. The page
    // side then queues forever rather than emitting into the void.
    log.warn("replay.dom-capture: exposeBinding failed; DOM stream will be empty", {
      binding: EMIT_BINDING,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function installInitScript(context: BrowserContext, maskSelectors: string[]): Promise<void> {
  const content = initScript(maskSelectors);
  try {
    await context.addInitScript({ content });
  } catch (err) {
    log.warn("replay.dom-capture: addInitScript failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  // `addInitScript` only reaches documents created after this call; a page that
  // is already open needs the bundle evaluated directly. Its full snapshot is
  // of the current DOM, not the pristine one — the init-script path is the only
  // one that gets the pristine snapshot.
  for (const page of context.pages()) {
    await page.evaluate(content).catch(() => undefined);
  }
}

async function stopRecorders(context: BrowserContext): Promise<void> {
  const stopper = `(function () {
    var w = globalThis;
    try { if (typeof w["${STOP_FN}"] === "function") w["${STOP_FN}"](); } catch (e) {}
    w["${INSTALL_FLAG}"] = false;
  })();`;
  try {
    for (const page of context.pages()) {
      await page.evaluate(stopper).catch(() => undefined);
    }
  } catch {
    /* context already torn down */
  }
}
