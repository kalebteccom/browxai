// The attached-session hold, run once for every tool by the `register` wrapper.
//
// A tool that changes an attached browser waits for a human while the
// `byob_action` confirm hook is set. Which tools are held is derived from the
// capability each one declares at `host.register`, so a new tool under a held
// capability is held without its handler doing anything. A tool that changes
// nothing in the browser opts out with `byobConfirm: false` at its registration,
// and `test/architecture/byob-hold-completeness.test.ts` pins that list.

import { confirmByobAction, type ConfirmContext } from "../policy/confirm.js";
import type { SessionEntry } from "../session/registry.js";
import type { Capability } from "../util/capabilities.js";
import type { ToolResponse } from "./host.js";

/** Capabilities whose tools change the page, the browser or its state. A tool
 *  under one of these is held in an attached session unless it opts out. */
export const BYOB_HOLD_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  "action",
  "navigation",
  "eval",
  "file-io",
  "clipboard",
  "canvas",
  "extensions",
  "device-emulation",
]);

/** Whether a tool is held in an attached session. The registration's own
 *  `byobConfirm` wins when it is set; otherwise the capability decides. */
export function shouldHold(
  capability: Capability | undefined,
  def: { byobConfirm?: boolean | undefined },
): boolean {
  if (def.byobConfirm !== undefined) return def.byobConfirm;
  return capability !== undefined && BYOB_HOLD_CAPABILITIES.has(capability);
}

/** The host closures the hold runs through. */
export interface ByobHoldDeps {
  /** False when no session of this server can be held: the hook is not set, or
   *  the server cannot attach. The call then resolves no session here. */
  armed: boolean;
  entryFor: (sessionId?: string) => Promise<SessionEntry>;
  engineGate: (toolName: string, e: SessionEntry) => ToolResponse | null;
  confirmCtxFor: (e: SessionEntry) => ConfirmContext;
  denyContent: (toolName: string, decision: { reason: string }) => ToolResponse;
}

/** The session a call names. Every held tool takes it as `session`. */
function sessionArg(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const session = (args as { session?: unknown }).session;
  return typeof session === "string" ? session : undefined;
}

/**
 * Run the hold for one call of a held tool. Returns the refusal to send back,
 * or null when the handler may run.
 *
 * The engine gate and the tool's own `precheck` run before the prompt, so a
 * human is never asked to approve a call the session's engine or the tool's
 * argument rules would refuse anyway. A session that is not attached returns
 * null without any check: its handler runs as it always did.
 */
export async function holdAttached(
  toolName: string,
  args: unknown,
  deps: ByobHoldDeps,
  precheck?: (e: SessionEntry) => ToolResponse | null,
): Promise<ToolResponse | null> {
  if (!deps.armed) return null;
  const e = await deps.entryFor(sessionArg(args));
  const ctx = deps.confirmCtxFor(e);
  if (!ctx.isByob) return null;
  const refused = deps.engineGate(toolName, e) ?? precheck?.(e) ?? null;
  if (refused) return refused;
  const decision = await confirmByobAction(toolName, ctx);
  return decision.ok ? null : deps.denyContent(toolName, decision);
}
