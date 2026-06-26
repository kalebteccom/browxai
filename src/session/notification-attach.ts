// Per-session notification policy — server-side attach/binding adapter. Realm
// (3) of the notification policy: the Playwright wiring that exposes the
// page-side check binding, injects the browser-realm init script, and seeds /
// propagates the synchronous decision hint the constructor wrapper reads.
//
// Imports the policy state + types from `./notification-policy.js` and the
// browser-realm constant from `./notification-page-script.js` — both leaf
// files — so the barrel (`./notification.js`) can re-export this without an
// import cycle.

import type { BrowserContext } from "playwright-core";
import { log } from "../util/logging.js";
import {
  type NotificationAskHandler,
  type NotificationPolicyMode,
  type NotificationRecord,
  NotificationPolicyState,
  syncDecisionFor,
} from "./notification-policy.js";
import { NOTIFICATION_PAGE_SCRIPT } from "./notification-page-script.js";

/** Server-side wire-up. Installs:
 *   - `__browx_notification_check` exposeBinding: page-side records +
 *     ask-human resolves to allow/deny via the bridge.
 *   - The page-side init script (above), re-injected by Playwright on every
 *     new document via `addInitScript`.
 *   - Seeds the SYNCHRONOUS decision hint
 *     (`window.__browx_notification_sync_decision`) on every wired page so
 *     the constructor wrapper can throw without awaiting a binding round-
 *     trip; refreshed on `set_notification_policy` via
 *     `propagateSyncDecision`.
 *
 * Idempotent on the same context (the state's `WeakSet<BrowserContext>` guard).
 * Errors during install are logged and swallowed — when bindings fail the
 * wrapper falls back to call-through (browser default).
 */
export async function attachNotificationPolicy(
  context: BrowserContext,
  state: NotificationPolicyState,
  askHandler: NotificationAskHandler,
): Promise<void> {
  if (state.hasContext(context)) return;
  state.markContext(context);

  try {
    await context.exposeBinding("__browx_notification_check", async (_source, payload: string) => {
      try {
        const o = JSON.parse(payload) as {
          title?: string;
          body?: string;
          icon?: string;
          tag?: string;
          origin?: string;
        };
        const title = String(o.title ?? "");
        const origin = o.origin;
        const mode = state.current().mode;
        const ts = Date.now();
        const baseRec: Omit<NotificationRecord, "handledAs"> = {
          title,
          timestamp: ts,
          ...(o.body !== undefined ? { body: o.body } : {}),
          ...(o.icon !== undefined ? { icon: o.icon } : {}),
          ...(o.tag !== undefined ? { tag: o.tag } : {}),
          ...(origin !== undefined ? { origin } : {}),
        };
        switch (mode) {
          case "allow":
            state.record({ ...baseRec, handledAs: "allowed" });
            return "allow";
          case "deny":
            state.record({ ...baseRec, handledAs: "denied" });
            return "deny";
          case "ask-human": {
            const decision = await askHandler({
              title,
              ...(o.body !== undefined ? { body: o.body } : {}),
              ...(o.icon !== undefined ? { icon: o.icon } : {}),
              ...(o.tag !== undefined ? { tag: o.tag } : {}),
              ...(origin !== undefined ? { origin } : {}),
            }).catch(() => "deny" as const);
            state.record({ ...baseRec, handledAs: "asked-human" });
            return decision;
          }
          case "raise":
          default:
            state.record({ ...baseRec, handledAs: "raised" });
            return "deny";
        }
      } catch (err) {
        log.warn("session.notification: check handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return "allow";
      }
    });
  } catch (err) {
    log.warn(
      "session.notification: exposeBinding install failed; constructor falls back to call-through",
      {
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }

  // Init-script — Playwright re-runs it on every new document. Idempotent
  // via the `__browx_notification_installed` guard inside the script.
  try {
    await context.addInitScript({ content: NOTIFICATION_PAGE_SCRIPT });
    // Seed the sync decision before any page script runs, plus apply to
    // already-attached pages so the wrapper installs on the current document.
    await context.addInitScript({ content: syncDecisionSeed(state.current().mode) });
    for (const page of context.pages()) {
      await page.evaluate(syncDecisionSeed(state.current().mode)).catch(() => undefined);
      await page.evaluate(NOTIFICATION_PAGE_SCRIPT).catch(() => undefined);
    }
  } catch (err) {
    log.warn("session.notification: addInitScript failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function syncDecisionSeed(mode: NotificationPolicyMode): string {
  const dec = syncDecisionFor(mode);
  // Init-script: runs before any page script, sets the hint on `window`.
  return `(() => { try { window.__browx_notification_sync_decision = ${JSON.stringify(dec)}; } catch (_) {} })();`;
}

/** Push the current policy's sync decision to every live page in the context
 *  AND register an additional init-script so future new documents see the
 *  fresh value. Called from `set_notification_policy` so a runtime mode flip
 *  takes effect on the very next constructor call without page reload.
 *
 *  Init-scripts accumulate in Playwright (one per call); the seed is ~80
 *  bytes so even hundreds of flips are negligible. The constructor wrapper
 *  reads `window.__browx_notification_sync_decision` at each call, so the
 *  most-recently-evaluated seed wins. */
export async function propagateSyncDecision(
  context: BrowserContext,
  state: NotificationPolicyState,
): Promise<void> {
  const seed = syncDecisionSeed(state.current().mode);
  try {
    await context.addInitScript({ content: seed });
  } catch {
    /* best-effort */
  }
  for (const page of context.pages()) {
    await page.evaluate(seed).catch(() => undefined);
  }
}
