// Server-side attach/binding adapter for the per-session permission policy
// (realm 3 of 3: the Playwright/CDP wiring — the `*-attach` half). This is the
// only realm that touches Playwright (`exposeBinding`, `addInitScript`,
// `grantPermissions`, `clearPermissions`) and the page's native Permissions
// API. It bridges the Node-side policy state (`permission-policy.ts`) and the
// browser-realm wrapper script (`permission-page-script.ts`):
//   - the exposeBindings let the page-script consult the policy state at
//     request time (and block on ask-human),
//   - the init-script injection installs the wrapper script on every document,
//   - `applyCdpBaseline` sets the browser-reported grant/deny baseline,
//   - `readPermissionStates` reads it back via the native Permissions API.

import type { BrowserContext, Page } from "playwright-core";
import { log } from "../util/logging.js";
import {
  SUPPORTED_PERMISSIONS,
  type PermissionAskHandler,
  type PermissionPolicyState,
  type SupportedPermission,
} from "./permission-policy.js";
import { PERMISSION_PAGE_SCRIPT } from "./permission-page-script.js";

/** Server-side wire-up. Installs:
 *   - `__browx_permission_check` exposeBinding: synchronous-from-page consult
 *     that records the request, runs the ask-human handler if the policy is
 *     `ask-human`, and returns the resolved decision (`"allow"` / `"deny"`).
 *   - `__browx_permission_observe` exposeBinding: read-side notice that the
 *     page called `navigator.permissions.query` (no decision returned).
 *   - The page-side init script (see `permission-page-script.ts`), re-injected
 *     by Playwright on every new document via `addInitScript`.
 *
 * Idempotent on the same context (the state's `WeakSet<BrowserContext>` guard).
 * Errors during install are logged and swallowed — the CDP setPermission baseline
 * still enforces grant/deny even when the in-page wrappers fail to wire.
 */
export async function attachPermissionPolicy(
  context: BrowserContext,
  state: PermissionPolicyState,
  askHandler: PermissionAskHandler,
): Promise<void> {
  if (state.hasContext(context)) return;
  state.markContext(context);

  // exposeBinding — synchronous-from-page from Playwright's perspective:
  // page-side awaits the Promise the binding returns. Errors thrown here
  // bubble back to the page as a rejected promise; the wrapper script catches
  // and falls back to "allow" (CDP backstop still enforces).
  try {
    await context.exposeBinding("__browx_permission_check", async (_source, payload: string) => {
      try {
        const o = JSON.parse(payload) as { permission?: string; origin?: string };
        const name = o.permission;
        const origin = o.origin;
        const cdpName =
          name && SUPPORTED_PERMISSIONS.includes(name as SupportedPermission)
            ? (name as SupportedPermission)
            : undefined;
        if (!cdpName) {
          // Unknown permission name — record under "geolocation" sentinel? No:
          // just allow through. Anything outside the v1 set is best-effort.
          return "allow";
        }
        const mode = state.modeFor(cdpName);
        const ts = Date.now();
        switch (mode) {
          case "allow":
            state.record({ permission: cdpName, origin, handledAs: "allowed", ts });
            return "allow";
          case "deny":
            state.record({ permission: cdpName, origin, handledAs: "denied", ts });
            return "deny";
          case "ask-human": {
            const decision = await askHandler(cdpName, origin).catch(() => "deny" as const);
            state.record({ permission: cdpName, origin, handledAs: "asked-human", ts });
            return decision;
          }
          case "raise":
          default:
            state.record({ permission: cdpName, origin, handledAs: "raised", ts });
            return "deny";
        }
      } catch (err) {
        log.warn("session.permission: check handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return "allow";
      }
    });
    await context.exposeBinding("__browx_permission_observe", (_source, _payload: string) => {
      // Read-side breadcrumb only — no decision, no record (the page calling
      // permissions.query() is too noisy to record per-call).
      return undefined;
    });
  } catch (err) {
    log.warn("session.permission: exposeBinding install failed; CDP baseline still enforces", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Init-script — Playwright re-runs it on every new document, including the
  // post-`framenavigated` reload of the same page. Idempotent via the
  // `__browx_permission_installed` guard inside the script.
  try {
    await context.addInitScript({ content: PERMISSION_PAGE_SCRIPT });
    for (const page of context.pages()) {
      await page.evaluate(PERMISSION_PAGE_SCRIPT).catch(() => undefined);
    }
  } catch (err) {
    log.warn("session.permission: addInitScript failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Apply the policy's baseline by computing the set of permissions that should
 *  be GRANTED (mode `allow`) and routing them through Playwright's
 *  `context.grantPermissions`. Permissions in `deny`/`raise`/`ask-human` are
 *  NOT granted — the in-page wrapper rejects them at request time before the
 *  native code runs.
 *
 *  Why not CDP `Browser.setPermission` directly: the underlying CDP method
 *  takes a W3C PermissionDescriptor name (e.g. `geolocation`, `camera`) and
 *  the descriptor schema varies by Chromium build. Playwright's
 *  `grantPermissions` carries the canonical mapping (see Playwright's
 *  `webPermissionToProtocol`) and falls back across Chromium versions —
 *  delegating means we don't have to track the protocol versions ourselves.
 *
 *  Note: `clearPermissions` first then `grantPermissions` is the Playwright
 *  idiom for "REPLACE the granted set" (the underlying CDP call is
 *  `Browser.resetPermissions` + `Browser.grantPermissions`). Both are
 *  context-wide on Chromium so the policy applies to every page.
 *
 *  Best-effort: errors are logged and don't throw — the in-page wrapper still
 *  enforces grant/deny even if the baseline application fails. Re-applied on
 *  `set_permission_policy` and re-attach paths. */
export async function applyCdpBaseline(
  context: BrowserContext,
  state: PermissionPolicyState,
): Promise<void> {
  const allowList: string[] = [];
  for (const name of SUPPORTED_PERMISSIONS) {
    if (state.modeFor(name) === "allow") allowList.push(name);
  }
  try {
    // Clear first so a previous policy's grants don't leak when the next
    // policy reduces the allow list.
    await context.clearPermissions();
  } catch (err) {
    log.warn("session.permission: clearPermissions failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (allowList.length === 0) return;
  try {
    await context.grantPermissions(allowList);
  } catch (err) {
    log.warn("session.permission: grantPermissions failed", {
      permissions: allowList,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Read-side via the page's native `navigator.permissions.query` (W3C
 *  Permissions API). Returns `{ [name]: "granted"|"denied"|"prompt"|"unknown" }`.
 *  Per-permission errors populate the entry with `"unknown"` so the caller
 *  sees a deterministic shape.
 *
 *  Why the Permissions API and not CDP `Browser.getPermissionState`: the CDP
 *  method's PermissionDescriptor schema varies across Chromium builds and
 *  several of our supported names (e.g. `clipboard-write` → `clipboardSan…`)
 *  don't map cleanly. The Permissions API takes the canonical web spec name
 *  directly and is supported across versions. The state it reports reflects
 *  whatever the CDP-level baseline set, so it's the right read-side mirror
 *  for `applyCdpBaseline`.
 *
 *  Note: the in-page wrapper script is a no-op for query() (passes through);
 *  it doesn't override the resulting state, so this read is the canonical
 *  browser-reported state, not a wrapper-side guess. */
export async function readPermissionStates(
  context: BrowserContext,
  page: Page,
  names: SupportedPermission[],
  origin?: string,
): Promise<Record<string, "granted" | "denied" | "prompt" | "unknown">> {
  const out: Record<string, "granted" | "denied" | "prompt" | "unknown"> = {};
  // origin parameter: for now we only support querying the current page's
  // origin (Permissions API has no cross-origin query). When origin is set
  // but doesn't match the page, return unknown for the whole set — the
  // caller can navigate / open a new tab if they need cross-origin state.
  if (origin) {
    try {
      const pageOrigin = new URL(page.url()).origin;
      if (pageOrigin !== origin) {
        for (const n of names) out[n] = "unknown";
        return out;
      }
    } catch {
      for (const n of names) out[n] = "unknown";
      return out;
    }
  }
  void context; // signature-compat: takes context so a future cross-origin
  // CDP path can adopt it without breaking callers.
  for (const n of names) {
    try {
      const state = await page
        .evaluate(async (perm: string): Promise<string> => {
          try {
            const perms: Permissions | undefined = globalThis.navigator?.permissions;
            if (!perms?.query) return "unknown";
            const res: PermissionStatus = await perms.query({ name: perm as PermissionName });
            return res.state;
          } catch {
            return "unknown";
          }
        }, n)
        .catch((): string => "unknown");
      out[n] = state === "granted" || state === "denied" || state === "prompt" ? state : "unknown";
    } catch {
      out[n] = "unknown";
    }
  }
  return out;
}
