import type { z as zType } from "zod";
import { confirmByobAction } from "../policy/confirm.js";
import { withDeadline } from "../util/deadline.js";
import { fillForm, type FillFormField } from "../page/fill-form.js";
import type { ActionTarget } from "../page/locator.js";
import { RefRegistry } from "../page/refs.js";
import { plan as planAction, execute as executeAction, PLAN_VERBS } from "../page/plan.js";
import { ACTION_OPTS, SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Form-fill, plan/execute, recording, named-ref, and find-feedback tools:
 * fill_form / plan / execute / start_recording / end_recording /
 * record_annotate / name_ref / list_named_refs / find_feedback. Every block is
 * registered through the shared `ToolHost` seam; the host owns the closures
 * (gate, confirm, ports), this module owns the registrations.
 */
export function registerFormsRecordingTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    confirmCtxFor,
    denyContent,
    actionTimeout,
    asActionResultText,
    ctxFor,
    hintFromTarget,
    config,
    caps,
    cfgActionTimeout,
  } = host;

  // ---------- multi-field form fill (compose fill into one action window) ----------

  // Per-field target shape — same surface as the single-field tools, minus
  // `coords` (fill needs a real input element, not a viewport point).
  const FILL_FORM_FIELD = z.object({
    ref: z.string().optional().describe("Stable [eN] ref from snapshot()/find()"),
    selector: z.string().optional().describe("CSS / selectorHint fallback"),
    named: z.string().optional().describe("Mnemonic name previously bound with name_ref"),
    contextRef: z.string().optional().describe("Resolve `selector` within the subtree of this ref"),
    value: z
      .string()
      .describe(
        "Value to fill (substring `<NAME>` triggers secrets materialisation when the secrets capability is on)",
      ),
  });
  // The optional submit slot accepts the same target shapes (also no coords —
  // a coord-only submit is fine via a follow-up click, and keeping submit
  // ref/selector-only matches the recorder's replay model).
  const FILL_FORM_SUBMIT = z.object({
    ref: z.string().optional(),
    selector: z.string().optional(),
    named: z.string().optional(),
    contextRef: z.string().optional(),
  });

  /** Project a per-field user arg into an `ActionTarget` (the shape
   *  `fillForm` expects). Mirrors `asTarget` for one field at a time but
   *  scoped to "no coords" — coords on a form field is rejected upstream. */
  const fieldArgToTarget = (
    raw: { ref?: string; selector?: string; named?: string; contextRef?: string },
    label: string,
    refs: RefRegistry,
  ): ActionTarget => {
    const provided = [raw.ref, raw.selector, raw.named].filter(Boolean).length;
    if (provided === 0)
      throw new Error(`fill_form: ${label} requires one of \`ref\` / \`selector\` / \`named\``);
    if (provided > 1)
      throw new Error(
        `fill_form: ${label} — pass exactly one of \`ref\` / \`selector\` / \`named\``,
      );
    if (raw.ref) return { ref: raw.ref };
    if (raw.named) {
      const resolved = refs.refByNameLookup(raw.named);
      if (!resolved)
        throw new Error(
          `fill_form: ${label} — name "${raw.named}" not bound. Call name_ref({name, ref}) first.`,
        );
      return { ref: resolved };
    }
    return raw.contextRef
      ? { selector: raw.selector!, contextRef: raw.contextRef }
      : { selector: raw.selector! };
  };

  register(
    "fill_form",
    {
      capability: "action",
      batchable: true,
      description:
        "Fill N form fields atomically in one action window, with an optional final `submit` click. Replaces the fill/fill/fill/click round-trip pattern with one dispatch — same action-window envelope (navigation/structure/console/network/snapshotDelta) as a single fill, plus an `elements: ElementProbe[]` slot carrying per-field probes in dispatch order. **Atomic pre-resolution**: every field's target (ref/selector/named) is resolved before any DOM write; if any target misses, the call returns `ok:false` with a structured `fieldResolution` block and NO partial fills land. Same posture for the optional `submit` — a missing submit aborts the whole call. **Secrets-masking composes**: a field value like `<SECRET_NAME>` triggers the standard registry substitution at dispatch (capability `secrets`); the recorded descriptor + per-field probe carry the alias, not the real value. Field targets accept `ref`/`selector`/`named` (no `coords` — fill needs a real input element).",
      inputSchema: {
        fields: z
          .array(FILL_FORM_FIELD)
          .min(1)
          .describe(
            "Ordered list of {target, value} pairs. Filled sequentially after atomic pre-resolution.",
          ),
        submit: FILL_FORM_SUBMIT.optional().describe(
          "Optional click target dispatched after every field fills. Aborts atomically if its target misses.",
        ),
        ...ACTION_OPTS,
      },
    },
    async (args) => {
      const g = gateCheck("fill_form");
      if (g) return g;
      const e = await entryFor(args.session);
      const c = await confirmByobAction("fill_form", confirmCtxFor(e));
      if (!c.ok) return denyContent("fill_form", c);

      // Project the schema-validated args into the lower-half's shape. Any
      // target-shape error here surfaces as a structured "invalid args"
      // result rather than a thrown handler — agents debugging a malformed
      // call shouldn't see a stack trace.
      let mappedFields: FillFormField[];
      let mappedSubmit: ActionTarget | undefined;
      try {
        mappedFields = args.fields.map((f: zType.infer<typeof FILL_FORM_FIELD>, i: number) => ({
          target: fieldArgToTarget(f, `fields[${i}]`, e.refs),
          value: f.value,
        }));
        if (args.submit) {
          mappedSubmit = fieldArgToTarget(args.submit, "submit", e.refs);
        }
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

      const td = actionTimeout(args);
      return asActionResultText(
        fillForm(ctxFor(e), {
          fields: mappedFields,
          submit: mappedSubmit,
          mode: args.mode,
          maxResultTokens: args.maxResultTokens,
          deadlineMs: td.ms,
          deadlineWarning: td.warning,
        }),
      );
    },
  );

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
      // that find() would have masked.
      const maskedPlan = caps.enabled.has("secrets") ? e.secrets.applyMaskDeep(outcome) : outcome;
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

  // ---------- recording mode () ----------

  register(
    "start_recording",
    {
      capability: "human",
      description:
        "Begin recording subsequent action tool calls as a draft flow-file. Every successful navigate/click/fill/press/hover/select/wait_for adds a step (with the resolved selectorHint when a target was given). Call `end_recording` to emit a YAML draft. `record_annotate` attaches annotations to the most-recent step. Calibration-walk → flow-file scaffolding.",
      inputSchema: {
        flowName: z.string().describe('Name of the flow being recorded, e.g. "login-and-search"'),
        ...SESSION_ARG,
      },
    },
    async ({ flowName, session }) => {
      const g = gateCheck("start_recording");
      if (g) return g;
      const r = (await entryFor(session)).recorder.start(flowName);
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  register(
    "end_recording",
    {
      capability: "human",
      description:
        "Stop the current recording and emit the draft flow-file YAML. Returns `{ name, yaml, stepCount }`. Review the locators block (entries flagged `stability: medium|low` deserve a second look) and add prerequisites/assertions before committing the flow into a site-docs workspace.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("end_recording");
      if (g) return g;
      try {
        const r = (await entryFor(session)).recorder.end();
        return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: e instanceof Error ? e.message : String(e) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  register(
    "record_annotate",
    {
      capability: "human",
      description:
        "Attach a doc annotation (copy + optional arrow position + optional target ref) to the most-recent recorded step, or to a specific `stepId`. No-op if no recording is active.",
      inputSchema: {
        copy: z.string().describe("Annotation copy"),
        arrow: z
          .string()
          .optional()
          .describe("Arrow position hint (top|top-left|left|bottom-right|...)"),
        target: z
          .string()
          .optional()
          .describe("Ref to anchor the annotation to (overrides the step's default)"),
        stepId: z.string().optional().describe("Annotate a specific step; default = most-recent"),
        ...SESSION_ARG,
      },
    },
    async ({ copy, arrow, target, stepId, session }) => {
      const g = gateCheck("record_annotate");
      if (g) return g;
      const r = (await entryFor(session)).recorder.annotate({ stepId, copy, arrow, target });
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  // ---------- named refs () ----------

  register(
    "name_ref",
    {
      capability: "human",
      batchable: true,
      description:
        'Bind a mnemonic name to a ref. Subsequent action tools accept `named: "<name>"` in place of `ref` / `selector`. Refs are stable across snapshots (by element-key), so the binding survives navigation as long as the element persists. Carry session-wide anchor sets without remembering the bare `eN`s.',
      inputSchema: {
        name: z.string().describe('Mnemonic (e.g. "main_tab", "library_tab")'),
        ref: z.string().describe("The ref to bind to this name"),
        ...SESSION_ARG,
      },
    },
    async ({ name, ref, session }) => {
      const g = gateCheck("name_ref");
      if (g) return g;
      (await entryFor(session)).refs.nameRef(name, ref);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, name, ref }, null, 2) }],
      };
    },
  );

  register(
    "list_named_refs",
    {
      capability: "read",
      batchable: true,
      description: "List all current name → ref bindings created via name_ref.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("list_named_refs");
      if (g) return g;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify((await entryFor(session)).refs.listNames(), null, 2),
          },
        ],
      };
    },
  );

  // ---------- learned find() ranking ----------

  register(
    "find_feedback",
    {
      capability: "human",
      batchable: true,
      description:
        "Tell browxai which candidate was the right answer to a prior `find(query)`. Subsequent finds whose query overlaps the token set will boost candidates matching this winner's identity (testId, or role+name). Session-scoped, in-memory, capped at 100 entries with LRU eviction. The learning is intentionally simple — a 'don't re-do that mistake' signal, not an ML model.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "The query you previously passed to find() (or a paraphrase — token overlap is what matters)",
          ),
        ref: z.string().describe("The ref the agent ended up acting on (the right candidate)"),
        ...SESSION_ARG,
      },
    },
    async ({ query, ref, session }) => {
      const g = gateCheck("find_feedback");
      if (g) return g;
      const e = await entryFor(session);
      const inputs = e.refs.locatorOf(ref);
      if (!inputs) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: `ref "${ref}" not in the registry` },
                null,
                2,
              ),
            },
          ],
        };
      }
      e.feedback.record(query, {
        testId: inputs.testId,
        testIdAttr: inputs.testIdAttr,
        role: inputs.role,
        name: inputs.name,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, recorded: { query, identity: inputs }, memorySize: e.feedback.size() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
