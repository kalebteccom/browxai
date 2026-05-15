// Confirmation hooks — Phase-2 policy. Routes potentially-irreversible operations
// through `await_human({kind:"confirm"})` before they dispatch. See `docs/threat-model.md`
// "The capability set" → confirm_required.
//
// Hooks defined:
//   - navigate_off_allowlist: navigate() to a URL outside BROWX_ALLOWED_ORIGINS
//   - byob_action: any action while attached over BROWX_ATTACH_CDP
//   - file_download / file_upload: (slot reserved; future tools)
//
// Configuring via env: BROWX_CONFIRM_REQUIRED (handled in src/util/capabilities.ts).

import { isOriginAllowed, type OriginPolicy } from "./origin.js";
import type { ConfirmHook } from "../util/capabilities.js";
import type { BrowxBridge } from "../helper/bridge.js";
import { log } from "../util/logging.js";

export interface ConfirmContext {
  hooks: ReadonlySet<ConfirmHook>;
  policy: OriginPolicy;
  bridge: BrowxBridge | null;
  /** True iff the active session attached over CDP (BYOB). */
  isByob: boolean;
}

export interface ConfirmDecision {
  /** Action proceeds if true. */
  ok: boolean;
  /** Short reason (logged). */
  reason: string;
  /** True iff a human confirmation was sought. */
  asked: boolean;
}

/**
 * Decide whether navigate() may proceed. If the URL is on-allowlist (or there's no
 * allowlist), proceeds without asking. If off-allowlist:
 *   - if `navigate_off_allowlist` is in `hooks`, asks for human confirm via the bridge;
 *   - otherwise proceeds with a stderr warning.
 *
 * Returns `{ ok: false }` only when the human declined; never auto-denies (this is
 * defense-in-depth, not a boundary).
 */
export async function confirmNavigation(url: string, ctx: ConfirmContext): Promise<ConfirmDecision> {
  if (isOriginAllowed(url, ctx.policy)) {
    return { ok: true, reason: "on-allowlist", asked: false };
  }
  if (!ctx.hooks.has("navigate_off_allowlist")) {
    log.warn(`navigate: ${url} is off the allowed-origins list; no confirm hook set, proceeding`);
    return { ok: true, reason: "off-allowlist; no hook", asked: false };
  }
  if (!ctx.bridge) {
    // No bridge means no way to confirm — fail closed.
    return { ok: false, reason: "off-allowlist; no helper bridge to confirm; blocked", asked: false };
  }
  log.info(`confirm navigate (off-allowlist): ${url} — call __browx.confirm(true) to proceed`);
  try {
    const sig = await ctx.bridge.awaitSignal("respond", 5 * 60_000);
    const value = sig.data && typeof sig.data === "object" && "value" in (sig.data as Record<string, unknown>)
      ? (sig.data as { value: unknown }).value
      : sig.data;
    return value === true
      ? { ok: true, reason: "human-approved", asked: true }
      : { ok: false, reason: "human-declined", asked: true };
  } catch (e) {
    return {
      ok: false,
      reason: `confirm timed out / failed: ${e instanceof Error ? e.message : String(e)}`,
      asked: true,
    };
  }
}

/**
 * Decide whether a generic action may proceed in BYOB mode. Returns ok:true when not
 * in BYOB, or when the hook isn't set. Otherwise blocks on human confirm.
 *
 * Note: this is a *coarse* gate — every action in BYOB hits it. In practice most
 * adopters either set the hook (and confirm once per session) or omit it (and trust
 * the BYOB attach decision they already opted into).
 */
export async function confirmByobAction(
  toolName: string,
  ctx: ConfirmContext,
): Promise<ConfirmDecision> {
  if (!ctx.isByob) return { ok: true, reason: "not byob", asked: false };
  if (!ctx.hooks.has("byob_action")) {
    return { ok: true, reason: "byob; no confirm hook", asked: false };
  }
  if (!ctx.bridge) {
    return { ok: false, reason: "byob; no helper bridge to confirm; blocked", asked: false };
  }
  log.info(`confirm byob ${toolName} — call __browx.confirm(true) to proceed`);
  try {
    const sig = await ctx.bridge.awaitSignal("respond", 5 * 60_000);
    const value = sig.data && typeof sig.data === "object" && "value" in (sig.data as Record<string, unknown>)
      ? (sig.data as { value: unknown }).value
      : sig.data;
    return value === true
      ? { ok: true, reason: "human-approved", asked: true }
      : { ok: false, reason: "human-declined", asked: true };
  } catch (e) {
    return {
      ok: false,
      reason: `confirm timed out / failed: ${e instanceof Error ? e.message : String(e)}`,
      asked: true,
    };
  }
}

/** Count of requests in an action window whose origin escaped the allowlist. */
export function countEgressOffAllowlist(
  requests: Array<{ url: string }>,
  policy: OriginPolicy,
): number {
  if (policy.allowed.length === 0) return 0;
  return requests.filter((r) => !isOriginAllowed(r.url, policy)).length;
}
