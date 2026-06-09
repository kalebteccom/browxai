// Per-session dialog policy. `alert` / `confirm` / `prompt` block every
// subsequent browser event until handled — without a server-side listener, the
// session deadlocks. This module installs `page.on('dialog')` per page on every
// navigation/new-target and routes each fired dialog through a per-session
// `DialogPolicyState`.
//
// Policy modes:
//   - "accept"                       — accept every dialog (confirm/prompt → OK)
//   - "dismiss"                      — dismiss every dialog (confirm/prompt → Cancel)
//   - "accept-prompt-with:<text>"    — accept with the given text answer for
//                                      prompts; accept for alert/confirm
//   - "raise"  (DEFAULT)             — DISMISS the dialog server-side (so the
//                                      page unblocks) but mark the action as
//                                      failed with a structured failure hint,
//                                      so a dialog never silently changes app
//                                      state under an unaware caller.
//
// Per-action capture: every fired dialog is appended to a buffer with a
// timestamp. `dialogsSince(ts)` slices the buffer for the action-window —
// mirrors the ConsoleBuffer pattern. The `raise`-mode flag (`raisedSince(ts)`)
// lets the action layer convert the action to `ok:false` without re-parsing
// the dialog records.

import type { BrowserContext, Dialog, Page } from "playwright-core";
import { log } from "../util/logging.js";

export type DialogMode = "accept" | "dismiss" | "raise" | "accept-prompt-with";

/** Public, runtime-mutable shape. `mode:"accept-prompt-with"` requires `text`. */
export interface DialogPolicy {
  mode: DialogMode;
  /** Required for `accept-prompt-with`. Used as the answer for prompts;
   *  alert/confirm still accept (no answer needed). */
  text?: string;
}

/** One captured dialog event, exposed on `ActionResult.dialogs[]`. */
export interface DialogRecord {
  kind: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
  /** What the server actually did. `"raised"` means we dismissed it
   *  server-side (to unblock the page) AND the policy was `raise`, so the
   *  action will be marked failed. */
  handledAs: "accepted" | "dismissed" | "raised";
  /** epoch ms — used by the action-window slice. */
  ts: number;
}

/** Hint emitted on `ActionResult.failure.hint` when `raise` mode fired.
 *  Stable, agent-facing string — referenced in docs/tool-reference.md. */
export const UNHANDLED_DIALOG_HINT =
  "unhandled dialog — set dialogPolicy (open_session/set_dialog_policy) to " +
  '"accept", "dismiss", or "accept-prompt-with:<text>" before driving ' +
  "an action that may trigger one. The dialog was dismissed server-side so " +
  "the page is not deadlocked, but its app effect is the cancel branch.";

/** Mutable per-session state. The handler reads `current()` on every fire,
 *  so a `set_dialog_policy` call takes effect on the very next dialog. */
export class DialogPolicyState {
  private policy: DialogPolicy;
  private buffer: DialogRecord[] = [];
  /** Hard cap so a chatty page can't grow this without bound. The
   *  per-action slice is the only consumer — older records are noise. */
  private readonly cap: number;
  /** Pages we've already installed the handler on. Lets the
   *  `context.on('page')` wiring be idempotent — re-attaching to an existing
   *  page (BYOB reconnect, profile-restore) doesn't double-fire. */
  private wired = new WeakSet<Page>();

  constructor(initial: DialogPolicy = { mode: "raise" }, cap = 200) {
    this.policy = normalise(initial);
    this.cap = cap;
  }

  current(): DialogPolicy {
    return { ...this.policy };
  }

  set(next: DialogPolicy): DialogPolicy {
    this.policy = normalise(next);
    return this.current();
  }

  /** Append a dialog record. Caps the buffer at `cap`. */
  record(rec: DialogRecord): void {
    this.buffer.push(rec);
    if (this.buffer.length > this.cap) this.buffer.shift();
  }

  /** Slice records with `ts >= since`. Used by the action-window. */
  since(since: number): DialogRecord[] {
    return this.buffer.filter((r) => r.ts >= since);
  }

  /** True if any record in `[since, now]` was handled in `raise` mode.
   *  When true, the action-window flips the result to `ok:false`. */
  raisedSince(since: number): boolean {
    return this.buffer.some((r) => r.ts >= since && r.handledAs === "raised");
  }

  /** Has this page already been wired? Idempotent install guard. */
  hasPage(p: Page): boolean {
    return this.wired.has(p);
  }
  /** Mark a page as wired. */
  markPage(p: Page): void {
    this.wired.add(p);
  }
}

/** Parse the spec's compact string form (`"accept-prompt-with:<text>"`) into
 *  the runtime `DialogPolicy` shape. Idempotent — also accepts the object form. */
export function parseDialogPolicyArg(v: string | DialogPolicy | undefined): DialogPolicy {
  if (!v) return { mode: "raise" };
  if (typeof v === "object") return normalise(v);
  if (v === "accept" || v === "dismiss" || v === "raise") return { mode: v };
  if (v.startsWith("accept-prompt-with:")) {
    const text = v.slice("accept-prompt-with:".length);
    return { mode: "accept-prompt-with", text };
  }
  throw new Error(
    `dialogPolicy: invalid value "${v}" — expected "accept" | "dismiss" | "raise" | "accept-prompt-with:<text>"`,
  );
}

function normalise(p: DialogPolicy): DialogPolicy {
  if (p.mode === "accept-prompt-with" && (p.text === undefined || p.text === null)) {
    throw new Error('dialogPolicy: mode "accept-prompt-with" requires `text`');
  }
  return p.mode === "accept-prompt-with" ? { mode: p.mode, text: p.text } : { mode: p.mode };
}

/** Install the `page.on('dialog')` handler on a single page if not already
 *  wired. Safe to call repeatedly; no-op when the page is already known. */
export function installDialogHandler(page: Page, state: DialogPolicyState): void {
  if (state.hasPage(page)) return;
  state.markPage(page);
  page.on("dialog", (d: Dialog) => {
    handleDialog(d, state).catch((err) => {
      // never throw out of an event handler — a dispatch error must not crash
      // the page or the server. Log and move on; the next dialog reuses the
      // same handler.
      log.warn("session.dialog: handler error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

/** Wire the dialog handler into every page in a context, plus a `context.on(
 *  'page')` listener that wires future pages. Call once per session-creation;
 *  the `context.on('page')` install is idempotent because `installDialogHandler`
 *  short-circuits already-wired pages. */
export function attachDialogPolicy(context: BrowserContext, state: DialogPolicyState): void {
  for (const page of context.pages()) installDialogHandler(page, state);
  context.on("page", (page) => installDialogHandler(page, state));
}

async function handleDialog(d: Dialog, state: DialogPolicyState): Promise<void> {
  const policy = state.current();
  const kind = d.type() as DialogRecord["kind"];
  const message = d.message();
  const defaultValue = d.defaultValue() || undefined;
  const ts = Date.now();

  switch (policy.mode) {
    case "accept": {
      // For alert: accept (no-op). For confirm: OK. For prompt: empty answer.
      // Callers who want a specific prompt answer set "accept-prompt-with".
      await d.accept().catch(() => undefined);
      state.record({ kind, message, defaultValue, handledAs: "accepted", ts });
      return;
    }
    case "dismiss": {
      await d.dismiss().catch(() => undefined);
      state.record({ kind, message, defaultValue, handledAs: "dismissed", ts });
      return;
    }
    case "accept-prompt-with": {
      // Only prompts read the text answer; alert/confirm ignore the second arg
      // — Playwright accepts either with or without the prompt text.
      const text = policy.text ?? "";
      if (kind === "prompt") {
        await d.accept(text).catch(() => undefined);
      } else {
        await d.accept().catch(() => undefined);
      }
      state.record({ kind, message, defaultValue, handledAs: "accepted", ts });
      return;
    }
    case "raise":
    default: {
      // Dismiss server-side so the page unblocks (the spec's anti-deadlock
      // guarantee) AND mark the action as failed via the buffer flag.
      await d.dismiss().catch(() => undefined);
      state.record({ kind, message, defaultValue, handledAs: "raised", ts });
      return;
    }
  }
}
