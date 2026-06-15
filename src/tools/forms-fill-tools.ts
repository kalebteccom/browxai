import type { z as zType } from "zod";
import { confirmByobAction } from "../policy/confirm.js";
import { fillForm, type FillFormField } from "../page/fill-form.js";
import type { ActionTarget } from "../page/locator.js";
import { RefRegistry } from "../page/refs.js";
import { ACTION_OPTS } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  EnvelopeHost,
  ServerServicesHost,
} from "./host.js";

/**
 * Multi-field form-fill tool: `fill_form`. Compose N field fills (plus an optional
 * final submit click) into one action window, with atomic pre-resolution. Split
 * out of `forms-recording-tools` (RFC 0004 P3 / D3 SRP); registered through the
 * shared `ToolHost` seam in the same source order.
 */
export function registerFormsFillTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & EnvelopeHost & ServerServicesHost,
): void {
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
}
