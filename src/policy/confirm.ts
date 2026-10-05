// Confirmation hooks —  policy. Routes potentially-irreversible operations
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
import type { OperatorGrant, OperatorPrompt } from "../helper/operator-channel.js";
import { log } from "../util/logging.js";

export interface ConfirmContext {
  hooks: ReadonlySet<ConfirmHook>;
  policy: OriginPolicy;
  bridge: BrowxBridge | null;
  /** True iff the active session attached over CDP (BYOB). */
  isByob: boolean;
  /** Pre-approvals from `approve_actions`. When a scope is granted, confirm
   *  hooks for that scope auto-approve without asking the human. Granting is
   *  gated on the off-by-default `self-approval` capability, because the agent
   *  whose actions the hook is meant to stop is the one calling the tool. */
  approvals?: ApprovalStore;
  /** The session the call runs in. A session-scoped operator grant is stored
   *  and matched under it. */
  sessionId?: string;
}

/**
 * session-scoped pre-approvals. The non-Claude verification path
 * surfaced that `__browx.confirm(true)` is operator-driven — a non-Claude MCP
 * client can't drive it from inside a blocked action call. This store lets
 * the client pre-approve confirm scopes for a TTL window. Each grant +
 * consume is logged for audit.
 *
 * Pre-approval is *not* an override; the confirm hook still runs, finds the
 * grant, and returns ok:true with `reason: "pre-approved"`. The human channel
 * is the fallback when no pre-approval covers the scope. The only writer is
 * `approve_actions`, behind the `self-approval` capability.
 */
export class ApprovalStore {
  /** Workspace grants (`approve_actions`, an operator `workspace` grant) cover
   *  every session of this process. Session grants cover one session id. The
   *  two never merge: a session grant is checked first and falls through to the
   *  workspace grant. Nothing is wider than the process's one workspace. */
  private grants = new Map<
    string,
    {
      scope: ConfirmHook;
      sessionId?: string;
      expiresAt: number;
      grantedAt: number;
      uses: number;
    }
  >();

  private static key(scope: ConfirmHook, sessionId?: string): string {
    return sessionId === undefined ? `w:${scope}` : `s:${scope}:${sessionId}`;
  }

  /** Grant a scope for `ttlSeconds`. Overwrites any prior grant for the same
   *  scope and session. With `sessionId` the grant covers that session only. */
  grant(scope: ConfirmHook, ttlSeconds: number, sessionId?: string): void {
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    const expiresAt = Date.now() + ttl * 1000;
    this.grants.set(ApprovalStore.key(scope, sessionId), {
      scope,
      ...(sessionId !== undefined ? { sessionId } : {}),
      expiresAt,
      grantedAt: Date.now(),
      uses: 0,
    });
    log.info(
      `approve_actions: scope="${scope}"${sessionId !== undefined ? ` session="${sessionId}"` : ""} ttl=${ttl}s expires=${new Date(expiresAt).toISOString()}`,
    );
  }

  /** Revoke a previously-granted workspace scope. Returns true if a live grant existed. */
  revoke(scope: ConfirmHook): boolean {
    const had = this.grants.delete(ApprovalStore.key(scope));
    if (had) log.info(`approve_actions: revoked scope="${scope}"`);
    return had;
  }

  /** Drop every grant held by one session. Run when the session closes, so a
   *  later session that reuses the id does not inherit it. */
  revokeSession(sessionId: string): number {
    let n = 0;
    for (const [key, g] of this.grants) {
      if (g.sessionId !== sessionId) continue;
      this.grants.delete(key);
      n++;
    }
    return n;
  }

  /** Check (and consume) a grant. Returns true when an unexpired grant covers
   *  the scope for this session, or for the whole workspace — the call is counted
   *  toward audit. Returns false (and evicts the grant) when the grant has expired. */
  consume(scope: ConfirmHook, sessionId?: string): boolean {
    if (sessionId !== undefined && this.take(ApprovalStore.key(scope, sessionId), scope)) {
      return true;
    }
    return this.take(ApprovalStore.key(scope), scope);
  }

  private take(key: string, scope: ConfirmHook): boolean {
    const grant = this.grants.get(key);
    if (!grant) return false;
    if (Date.now() > grant.expiresAt) {
      this.grants.delete(key);
      log.info(`approve_actions: scope="${scope}" expired`);
      return false;
    }
    grant.uses++;
    return true;
  }

  /** Snapshot of live grants for audit / `list_approvals` style tooling. */
  list(): Array<{
    scope: ConfirmHook;
    sessionId?: string;
    grantedAt: number;
    expiresAt: number;
    uses: number;
    remainingMs: number;
  }> {
    const now = Date.now();
    const out: ReturnType<ApprovalStore["list"]> = [];
    for (const grant of this.grants.values()) {
      if (now > grant.expiresAt) continue;
      out.push({
        scope: grant.scope,
        ...(grant.sessionId !== undefined ? { sessionId: grant.sessionId } : {}),
        grantedAt: grant.grantedAt,
        expiresAt: grant.expiresAt,
        uses: grant.uses,
        remainingMs: grant.expiresAt - now,
      });
    }
    return out;
  }
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
export async function confirmNavigation(
  url: string,
  ctx: ConfirmContext,
): Promise<ConfirmDecision> {
  if (isOriginAllowed(url, ctx.policy)) {
    return { ok: true, reason: "on-allowlist", asked: false };
  }
  if (!ctx.hooks.has("navigate_off_allowlist")) {
    log.warn(`navigate: ${url} is off the allowed-origins list; no confirm hook set, proceeding`);
    return { ok: true, reason: "off-allowlist; no hook", asked: false };
  }
  if (ctx.approvals?.consume("navigate_off_allowlist", ctx.sessionId)) {
    return { ok: true, reason: "pre-approved", asked: false };
  }
  return askHuman(ctx, "off-allowlist", `confirm navigate (off-allowlist): ${url}`, {
    kind: "approval",
    scope: "navigate_off_allowlist",
    tool: "navigate",
    summary: `navigate to ${url} (off the allowed-origins list)`,
    grantable: "navigate_off_allowlist",
  });
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
  if (ctx.approvals?.consume("byob_action", ctx.sessionId)) {
    return { ok: true, reason: "pre-approved", asked: false };
  }
  return askHuman(ctx, "byob", `confirm byob ${toolName}`, {
    kind: "approval",
    scope: "byob_action",
    tool: toolName,
    summary: `${toolName} on an attached browser`,
    grantable: "byob_action",
  });
}

/** Extend the confirm scope the operator approved, when the answer carried a
 *  grant. A session grant needs the session id; without one it is dropped, never
 *  widened to the workspace. */
function applyGrant(ctx: ConfirmContext, scope: ConfirmHook, grant: OperatorGrant): void {
  if (!ctx.approvals) return;
  if (grant.scope === "workspace") ctx.approvals.grant(scope, grant.ttlSeconds);
  else if (ctx.sessionId !== undefined) ctx.approvals.grant(scope, grant.ttlSeconds, ctx.sessionId);
}

/** Block on the human channel for a yes/no. Fails closed when the session has
 *  no bridge or no human channel (an engine without CDP and no operator
 *  channel): nothing the page can reach may stand in for the human. */
async function askHuman(
  ctx: ConfirmContext,
  label: string,
  prompt: string,
  operator: OperatorPrompt,
): Promise<ConfirmDecision> {
  if (!ctx.bridge || !ctx.bridge.humanChannelAvailable()) {
    return {
      ok: false,
      reason: `${label}; no human channel on this session to confirm; blocked`,
      asked: false,
    };
  }
  const ticket = ctx.bridge.newTicket();
  log.info(`${prompt} — ${ctx.bridge.answerHint(`__browx.confirm(true, "${ticket}")`)}`);
  try {
    const sig = await ctx.bridge.awaitSignal("respond", 5 * 60_000, ticket, operator);
    const value =
      sig.data && typeof sig.data === "object" && "value" in (sig.data as Record<string, unknown>)
        ? (sig.data as { value: unknown }).value
        : sig.data;
    if (value !== true) return { ok: false, reason: "human-declined", asked: true };
    if (sig.grant && operator.kind === "approval" && operator.grantable) {
      applyGrant(ctx, operator.grantable, sig.grant);
    }
    return { ok: true, reason: "human-approved", asked: true };
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
