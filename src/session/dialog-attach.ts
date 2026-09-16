// Per-session dialog policy — the Playwright attach/binding adapter.
//
// `alert` / `confirm` / `prompt` block every subsequent browser event until
// handled — without a server-side listener, the session deadlocks. This module
// installs `page.on('dialog')` per page on every navigation/new-target and
// routes each fired dialog through the per-session `DialogPolicyState` that
// lives in `dialog-policy.ts`. Re-exported through the `dialog.ts` barrel.
// (RFC 0009 P1 — the realm split that keeps the decision state vendor-free.)

import type { BrowserContext, Dialog, Page } from "playwright-core";
import { log } from "../util/logging.js";
import type { DialogRecord, DialogPolicyState } from "./dialog-policy.js";

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
