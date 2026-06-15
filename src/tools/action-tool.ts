// RFC 0004 P3 / D4 (DRY) — the `actionTool()` wrapper.
//
// Every confirm-gated, target-resolving action handler runs the SAME pipeline:
//
//   1. gateCheck(name)                      — capability gate
//   2. entryFor(args.session)               — resolve the session entry
//   3. confirmByobAction(name, …)           — byob confirm hook
//   4. asTarget(args, name, e.refs)         — resolve the wire target
//   5. actionTimeout(args)                  — anti-wedge deadline
//   6. actionsFor(e).<verb>({ … })          — the engine-agnostic dispatch
//   7. asActionResultText(…)                — the standard ActionResult envelope
//
// `actionTool()` owns steps 1–5 and 7 verbatim; the caller's `dispatch` supplies
// ONLY step 6 (the substrate verb + its per-verb args). This is a pure
// extraction-substitution: the four canonical handlers (`click` / `fill` /
// `hover` / `select`) collapse onto it with byte-identical behaviour — same gate,
// same confirm, same target resolution, same deadline, same envelope.
//
// CRITICAL (audit tools-and-seam#10): `engineGate` is present on SOME action
// handlers and ABSENT on others. The four canonical handlers this wrapper serves
// do NOT call `engineGate`, so the wrapper does NOT call it by default — it is an
// OPT-IN param (`engineGate: true`). A handler whose shape differs (navigate /
// press / shortcut / drag / scroll / wait_for / choose_option / …) keeps its own
// hand-written body; the wrapper is applied ONLY where it is byte-identical.

import { confirmByobAction } from "../policy/confirm.js";
import type { SessionEntry } from "../session/registry.js";
import type {
  ResolvedTarget,
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  ToolMeta,
} from "./host.js";
import type { z } from "zod";

/** The narrow host slice an action handler depends on (RFC 0004 P3 / D3 ISP) —
 *  registration, gating, session resolution, action dispatch. */
export type ActionToolHost = RegisterHost & GateHost & SessionHost & ActionHost;

/** The per-call context the dispatch body receives — exactly the values the
 *  canonical handler bodies computed inline before calling the substrate verb. */
export interface ActionDispatchCtx<A> {
  /** The schema-validated args. */
  args: A;
  /** The resolved session entry. */
  e: SessionEntry;
  /** The resolved action target (step 4). */
  target: ResolvedTarget;
  /** The recorder selectorHint for the target (`hintFromTarget(e, target)`). */
  recordingHint: ReturnType<ActionHost["hintFromTarget"]>;
  /** The resolved anti-wedge deadline (step 5). */
  td: ReturnType<ActionHost["actionTimeout"]>;
}

/** Options that toggle the opt-in pipeline steps. */
export interface ActionToolOpts {
  /** Run `engineGate(name, e)` after the session resolves — OFF by default
   *  (the canonical handlers do not engine-gate). Opt-in so a handler that DID
   *  engine-gate keeps that step; the wrapper never ADDS it where it was absent
   *  nor DROPS it where present. */
  engineGate?: boolean;
}

/**
 * Register a confirm-gated, target-resolving action tool. The wrapper runs the
 * fixed pipeline (gate → entry → [engineGate] → confirm → target → timeout →
 * envelope) and the `dispatch` body returns the substrate verb promise (step 6).
 *
 * Byte-identical to the hand-written canonical handler: the only thing the body
 * supplies is the substrate method + its per-verb args, exactly as before.
 */
export function actionTool<S extends z.ZodRawShape>(
  host: ActionToolHost,
  name: string,
  def: { description: string; capability: ToolMeta["capability"]; batchable?: boolean; inputSchema: S },
  dispatch: (ctx: ActionDispatchCtx<z.infer<z.ZodObject<S>>>) => Promise<unknown>,
  opts: ActionToolOpts = {},
): void {
  host.register(
    name,
    {
      capability: def.capability,
      ...(def.batchable !== undefined ? { batchable: def.batchable } : {}),
      description: def.description,
      inputSchema: def.inputSchema,
    },
    async (args) => {
      const g = host.gateCheck(name);
      if (g) return g;
      const e = await host.entryFor((args as { session?: string }).session);
      if (opts.engineGate) {
        const eg = host.engineGate(name, e);
        if (eg) return eg;
      }
      const c = await confirmByobAction(name, host.confirmCtxFor(e));
      if (!c.ok) return host.denyContent(name, c);
      const target = host.asTarget(args, name, e.refs);
      const td = host.actionTimeout(args);
      const recordingHint = host.hintFromTarget(e, target);
      return host.asActionResultText(dispatch({ args, e, target, recordingHint, td }));
    },
  );
}
