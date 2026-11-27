// `shortcut` — keyboard chord / multi-step sequence with handled-observability.
//
// `press` drives one combo, but (a) multi-step shortcuts are unergonomic and
// (b) the agent can't tell whether the *app* handled the shortcut or what was
// focused — copy/cut/paste especially are opaque (internal vs OS clipboard).
// This dispatches a chord or an ordered sequence and returns a structured
// observability block: the active element, which keydown/copy/cut/paste
// listeners fired, and whether the app called preventDefault.
//
// Clipboard (capability `clipboard`, off by default) is per-session and
// transactional — see clipboard.ts. Observability works without the
// capability; only the OS-clipboard read/write + per-session buffer engage
// when it's enabled. No agent JS (fixed server-injected trace script).

import type { Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import { locatorFor, type ActionTarget } from "./locator.js";
import { ClipboardBuffer, osClipboardWrite, type ClipOp } from "./clipboard.js";
import { capabilitiesAssignment } from "../util/capabilities.js";
import { clipPageText, pageReadLength, PLAIN_CUT, type TextCut } from "../util/frame-cap.js";

type ChordKind = "copy" | "cut" | "paste" | "other";

/** Classify a Playwright chord ("Control+C", "Meta+V", "Control+Shift+K").
 *  copy/cut/paste require a Control or Meta modifier on c / x / v. */
export function classifyChord(chord: string): ChordKind {
  const parts = chord.split("+").map((s) => s.trim().toLowerCase());
  const key = parts[parts.length - 1];
  const mod = parts.slice(0, -1);
  const accel = mod.includes("control") || mod.includes("meta");
  if (!accel) return "other";
  if (key === "c") return "copy";
  if (key === "x") return "cut";
  if (key === "v") return "paste";
  return "other";
}

/** Longest element `name` read from text content, in characters. The page
 *  reads `NAME_MAX + slack + 1` characters and marks the name `nameFromText`;
 *  the server masks it, then cuts it (`clipSumm`). */
const NAME_MAX = 40;

const elSumm = (nameRead: number): string => `function (el) {
  if (!el || !el.tagName) return null;
  var aria = el.getAttribute && el.getAttribute('aria-label');
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    testId: el.getAttribute ? (el.getAttribute('data-testid') || undefined) : undefined,
    role: el.getAttribute ? (el.getAttribute('role') || undefined) : undefined,
    name: aria || (el.textContent ? el.textContent.trim().slice(0, ${nameRead}) : undefined) || undefined,
    nameFromText: !aria,
  };
}`;

/** Mask an element summary's text-content name, then cut it to `NAME_MAX`. */
function clipSumm(el: (ElSumm & { nameFromText?: boolean }) | null, cut: TextCut): ElSumm | null {
  if (!el) return el;
  const { nameFromText, ...out } = el;
  if (nameFromText && out.name !== undefined) out.name = clipPageText(out.name, NAME_MAX, cut);
  return out;
}

const installTrace = (slack: number): string => `(() => {
  var summ = ${elSumm(pageReadLength(NAME_MAX, slack))};
  var W = window;
  var st = { events: [], active: summ(document.activeElement) };
  W.__browx_kbt = st;
  var rec = function (type) {
    return function (e) {
      st.events.push({ type: type, key: e.key, defaultPrevented: !!e.defaultPrevented, target: summ(e.target) });
    };
  };
  var L = { keydown: rec('keydown'), copy: rec('copy'), cut: rec('cut'), paste: rec('paste') };
  W.__browx_kbt_l = L;
  // bubble phase on document: runs after element/app handlers, so
  // defaultPrevented reflects whether the app handled the event.
  document.addEventListener('keydown', L.keydown, false);
  document.addEventListener('copy', L.copy, false);
  document.addEventListener('cut', L.cut, false);
  document.addEventListener('paste', L.paste, false);
})()`;

const READ_TRACE = `(() => {
  var s = window.__browx_kbt || { events: [], active: null };
  return { events: s.events, active: s.active };
})()`;

const CLEANUP_TRACE = `(() => {
  var L = window.__browx_kbt_l;
  if (L) {
    document.removeEventListener('keydown', L.keydown, false);
    document.removeEventListener('copy', L.copy, false);
    document.removeEventListener('cut', L.cut, false);
    document.removeEventListener('paste', L.paste, false);
  }
  delete window.__browx_kbt; delete window.__browx_kbt_l;
})()`;

const READ_SELECTION = `(() => {
  var a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && typeof a.selectionStart === 'number') {
    return a.value.substring(a.selectionStart, a.selectionEnd) || a.value || '';
  }
  var s = window.getSelection && window.getSelection();
  return s ? s.toString() : '';
})()`;

interface ElSumm {
  tag: string;
  id?: string;
  testId?: string;
  role?: string;
  name?: string;
}
interface KbEvent {
  type: string;
  key: string;
  defaultPrevented: boolean;
  target: ElSumm | null;
}

export interface ShortcutArgs {
  keys: string | string[];
  target?: ActionTarget;
}

export interface ShortcutResult {
  ok: boolean;
  keys: string[];
  activeElement: ElSumm | null;
  events: KbEvent[];
  /** true when a copy/cut/paste event fired OR the app called preventDefault
   *  on a keydown — i.e. the app actually responded to the shortcut. */
  handled: boolean;
  clipboard?: {
    op: ClipOp | "paste";
    /** chars captured into the per-session buffer (copy/cut). */
    capturedChars?: number;
    /** chars written to the OS clipboard from the per-session buffer (paste). */
    chars?: number;
    fromSessionBuffer?: boolean;
    osSync: boolean;
    osTool: string;
  };
  clipboardNote?: string;
}

export async function runShortcut(
  page: Page,
  refs: RefRegistry,
  args: ShortcutArgs,
  opts: { clipboardEnabled: boolean; clipboard: ClipboardBuffer; cut?: TextCut },
): Promise<ShortcutResult> {
  const cut = opts.cut ?? PLAIN_CUT;
  const chords = Array.isArray(args.keys) ? args.keys : [args.keys];

  if (args.target) {
    try {
      await locatorFor(page, refs, args.target).focus({ timeout: 2000 });
    } catch {
      /* best-effort focus; page-level shortcut still valid */
    }
  }

  await page.evaluate(installTrace(cut.slack)).catch(() => undefined);

  let clip: ShortcutResult["clipboard"] | undefined;
  for (const chord of chords) {
    if (classifyChord(chord) === "paste" && opts.clipboardEnabled) {
      const buf = opts.clipboard.get();
      if (buf) {
        // transactional: set the OS clipboard from THIS session's buffer
        // immediately before the paste keystroke, so the app pastes this
        // session's content regardless of concurrent sessions.
        const w = await osClipboardWrite(buf.text);
        clip = {
          op: "paste",
          chars: buf.text.length,
          fromSessionBuffer: true,
          osSync: w.ok,
          osTool: w.tool,
        };
      }
    }
    await page.keyboard.press(chord).catch(() => undefined);
  }

  const copyChord = chords.find((c) => classifyChord(c) === "copy" || classifyChord(c) === "cut");
  if (copyChord && opts.clipboardEnabled) {
    // READ_SELECTION returns a string by construction (see definition above);
    // narrow before coercion so we don't `[object Object]` if the page eval
    // ever returns a non-primitive.
    const raw: unknown = await page.evaluate(READ_SELECTION).catch(() => "");
    const sel = typeof raw === "string" ? raw : "";
    const op = classifyChord(copyChord) as ClipOp;
    opts.clipboard.set(sel, op);
    const w = await osClipboardWrite(sel);
    clip = { op, capturedChars: sel.length, osSync: w.ok, osTool: w.tool };
  }

  const trace = (await page.evaluate(READ_TRACE).catch(() => ({ events: [], active: null }))) as {
    events: KbEvent[];
    active: ElSumm | null;
  };
  await page.evaluate(CLEANUP_TRACE).catch(() => undefined);

  const handled = trace.events.some(
    (e) =>
      e.type === "copy" ||
      e.type === "cut" ||
      e.type === "paste" ||
      (e.type === "keydown" && e.defaultPrevented),
  );

  return {
    ok: true,
    keys: chords,
    activeElement: clipSumm(trace.active, cut),
    events: trace.events.map((ev) => ({ ...ev, target: clipSumm(ev.target, cut) })),
    handled,
    ...(clip ? { clipboard: clip } : {}),
    ...(opts.clipboardEnabled || !chords.some((c) => classifyChord(c) !== "other")
      ? {}
      : {
          clipboardNote:
            "clipboard capability disabled: keys were dispatched and observed, but the OS clipboard was not read or written and the per-session buffer did not change. " +
            `To enable it, set ${capabilitiesAssignment("clipboard")} and restart the server.`,
        }),
  };
}
