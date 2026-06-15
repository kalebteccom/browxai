import { withDeadline } from "../util/deadline.js";
import { plan as planAction, execute as executeAction, PLAN_VERBS } from "../page/plan.js";
import { ACTION_OPTS, SESSION_ARG } from "./schemas.js";
import { confirmByobAction } from "../policy/confirm.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  EgressHost,
  ConfigHost,
  ServerServicesHost,
} from "./host.js";

/**
 * Plan / execute tools: separate intent capture (`plan`) from dispatch
 * (`execute`). Split out of `forms-recording-tools` (RFC 0004 P3 / D3 SRP);
 * registered through the shared `ToolHost` seam in the same source order.
 */
export function registerFormsPlanTools(
  host: RegisterHost &
    GateHost &
    SessionHost &
    ActionHost &
    EgressHost &
    ConfigHost &
    ServerServicesHost,
): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    confirmCtxFor,
    denyContent,
    actionTimeout,
    ctxFor,
    hintFromTarget,
    egressFor,
    config,
    caps,
    cfgActionTimeout,
  } = host;

  // ---------- plan / execute (separate intent capture from dispatch) ----------

  register(
    "plan",
    {
      capability: "read",
      batchable: true,
      description:
        "Resolve a natural-language `query` for a single element + a target action `verb` into a serialisable `ActionDescriptor` — no dispatch happens. The descriptor binds the picked ref (same `eN` namespace as snapshot/find/name_ref — NOT a parallel id system), the verb's args, evidence (selectorHint, stability, score, top alternatives + any low-confidence warnings), and an `expiresAt` deadline. Hand it back verbatim to `execute` to dispatch; cache it for replay / self-healing; or inspect `evidence` and refuse to dispatch when the stability is too low. NOT a mock dispatch — the value is captured intent, not suppressed effects.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Natural-language description of the element to act on, e.g. 'the Save button'.",
          ),
        verb: z.enum(PLAN_VERBS).describe(`Action verb to bind: ${PLAN_VERBS.join(" / ")}.`),
        verbArgs: z
          .object({
            value: z.string().optional().describe("`fill` value."),
            values: z.array(z.string()).optional().describe("`select` option labels/values."),
            key: z.string().optional().describe("`press` key (Playwright key syntax)."),
            button: z
              .enum(["left", "right", "middle"])
              .optional()
              .describe("`click` mouse button (default left)."),
          })
          .optional()
          .describe(
            "Verb-specific args. Required: `value` for fill, `key` for press, `values` for select. click/hover take none.",
          ),
        contextRef: z
          .string()
          .optional()
          .describe("Limit ranking to descendants of this ref (same semantics as find())."),
        confidenceFloor: z
          .number()
          .nonnegative()
          .optional()
          .describe("Returns ok:false when no candidate scored above this floor."),
        ttlMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Descriptor lifetime in ms (default 60000; clamped to [1000, 1800000])."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("plan");
      if (g) return g;
      const e = await entryFor(args.session);
      let outcome;
      try {
        outcome = await withDeadline(
          planAction(
            e.session.page(),
            e.snapshotSubstrate,
            e.refs,
            {
              query: args.query,
              verb: args.verb,
              verbArgs: args.verbArgs,
              contextRef: args.contextRef,
              confidenceFloor: args.confidenceFloor,
              ttlMs: args.ttlMs,
              testAttributes: config.testAttributes,
              fallbackHints: {
                coords: caps.enabled.has("action"),
                evalJs: caps.enabled.has("eval"),
              },
            },
            e.session.cdp ? e.session.cdp() : undefined,
          ),
          cfgActionTimeout(),
          "plan",
        );
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
      // Egress sink — `plan().evidence` mirrors `find().evidence` (selectorHint
      // / role / name) which IS masked. Match the find-handler's pattern so
      // a planned descriptor's evidence doesn't leak a registered real-value
      // that find() would have masked. Routes through the injected chokepoint
      // (RFC 0004 P3 / D4): `egressFor(e).maskDeep(outcome)` is byte-identical
      // to `caps.enabled.has("secrets") ? e.secrets.applyMaskDeep(outcome) : outcome`.
      const maskedPlan = egressFor(e).maskDeep(outcome);
      return { content: [{ type: "text" as const, text: JSON.stringify(maskedPlan, null, 2) }] };
    },
  );

  register(
    "execute",
    {
      capability: "action",
      batchable: true,
      description:
        'Dispatch a previously-planned `ActionDescriptor` (from `plan`). Re-resolves the bound ref via the same stable-key scheme snapshot/find use; refuses with structured `reason:"expired"` past `expiresAt`, or `reason:"ref-gone"` when the ref is no longer in the session\'s registry — in both cases NO action runs, re-plan against the current snapshot. The underlying action verb\'s capability is enforced (a descriptor with verb:"click" still requires the `action` capability); a successful dispatch returns the same `ActionResult` shape as calling the verb\'s tool directly.',
      inputSchema: {
        descriptor: z
          .object({
            id: z.string(),
            ref: z.string(),
            verb: z.enum(PLAN_VERBS),
            args: z.record(z.unknown()).optional(),
            evidence: z.record(z.unknown()).optional(),
            expiresAt: z.number(),
          })
          .passthrough()
          .describe("The `ActionDescriptor` returned by `plan` — pass it back verbatim."),
        ...ACTION_OPTS,
      },
    },
    async (args) => {
      const g = gateCheck("execute");
      if (g) return g;
      // Surface the *underlying* verb's capability — a descriptor with
      // verb:"click" denied for `action` should report `click` denied, not
      // a generic "execute denied". The verb is parsed off the descriptor
      // before the gate to keep the error attribution clean.
      const verb = args.descriptor.verb;
      if (verb) {
        const vg = gateCheck(verb);
        if (vg) return vg;
      }
      const e = await entryFor(args.session);
      // The descriptor's verb is also subject to the same confirm-hook
      // policy as a direct call to that verb — a `byob_action` policy that
      // blocks `click` also blocks an `execute` of a click descriptor.
      if (verb) {
        const c = await confirmByobAction(verb, confirmCtxFor(e));
        if (!c.ok) return denyContent(`execute(${verb})`, c);
      }
      const td = actionTimeout(args);
      // Compute the recordingHint off the descriptor's bound ref (same
      // shape `click` / `fill` build it).
      const ref = args.descriptor.ref;
      const recordingHint = ref ? hintFromTarget(e, { ref }) : undefined;
      let outcome;
      try {
        outcome = await executeAction(ctxFor(e), args.descriptor, {
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
          recordingHint,
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(outcome, null, 2) }] };
    },
  );
}
