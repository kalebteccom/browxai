import type { z as ZodNamespace } from "zod";
import { requireCdp } from "../engine/index.js";
import {
  verifyVisible,
  verifyText,
  verifyValue,
  verifyCount,
  verifyAttribute,
  verifyPredicate,
  type VerifyResult,
} from "../page/verify.js";
import type { Predicate } from "../util/predicates.js";
import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import type { SessionEntry } from "../session/registry.js";
import { REF_OR_SELECTOR, SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Read / observe — the assertive verify_* family. Fail-emitting siblings of
 * `wait_for`: each asserts a page condition NOW and returns `ok:false` with a
 * structured `failure` on a miss. Read-only; registered through the shared
 * `ToolHost` seam.
 */
export function registerReadObserveVerifyTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    asTarget,
    cfgActionTimeout,
    caps,
    config,
  } = host;

  // ---------- verify-family — assertive read primitives ----------

  // Shared inputs for the element-targeted verify_* tools. Same target shape
  // as the action surface (ref / selector / named — coords not allowed; a
  // verify needs a structural identity, not a pixel).
  const VERIFY_TARGET = {
    ref: REF_OR_SELECTOR.ref,
    selector: REF_OR_SELECTOR.selector,
    named: REF_OR_SELECTOR.named,
    contextRef: REF_OR_SELECTOR.contextRef,
    ...SESSION_ARG,
  };

  /** Wrap a `VerifyResult` in the standard JSON envelope with `tokensEstimate`.
   *  Same `{ok, failure}` shape across the whole family.
   *
   *  Secrets-masking: when `e` is supplied and the `secrets` capability is on,
   *  the body is run through `applyMaskDeep` BEFORE token-counting and
   *  envelope construction. The load-bearing path is `failure.actual` for
   *  `verify_text` / `verify_value` / `verify_attribute` — these echo the
   *  element's real innerText / value / attribute on a miss, which is a
   *  direct value-disclosure of any registered secret. Callers that don't
   *  thread a session entry (no page-derived strings) pass `undefined`. */
  const verifyResultText = (
    res: VerifyResult,
    e?: SessionEntry,
  ): { content: Array<{ type: "text"; text: string }> } => {
    const rawBody = res.ok ? { ok: true as const } : { ok: false as const, failure: res.failure };
    const body = e && caps.enabled.has("secrets") ? e.secrets.applyMaskDeep(rawBody) : rawBody;
    const tokensEstimate = estimateTokens(JSON.stringify(body));
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
      ],
    };
  };

  register(
    "verify_visible",
    {
      capability: "read",
      batchable: true,
      description:
        'Assertive sibling of `wait_for`: fail-emitting (`ok:false` + `failure:{source,kind,expected,actual}`) instead of permissive (`wait_for` returns ok:false on deadline expiry as a normal outcome). Use to terminate retry loops deterministically: "this element MUST be visible right now, else fail loudly." Read-only. `source:"app"` when the element isn\'t visible (the assertion failed against the page); `source:"browxai"` when verify itself couldn\'t run (ref no longer in the snapshot, etc).',
      inputSchema: VERIFY_TARGET,
    },
    async (args) => {
      const g = gateCheck("verify_visible");
      if (g) return g;
      const e = await entryFor(args.session);
      const target = asTarget(args, "verify_visible", e.refs);
      if ("coords" in target) {
        return verifyResultText(
          {
            ok: false,
            failure: {
              source: "browxai",
              kind: "visible",
              expected: "ref/selector/named target",
              actual: "coords target",
            },
          },
          e,
        );
      }
      try {
        const res = await withDeadline(
          verifyVisible(e.session.page(), e.refs, target),
          cfgActionTimeout(),
          "verify_visible",
        );
        return verifyResultText(res, e);
      } catch (err) {
        return verifyResultText(
          {
            ok: false,
            failure: {
              source: "browxai",
              kind: "visible",
              expected: "verify_visible to complete",
              actual: err instanceof Error ? err.message : String(err),
            },
          },
          e,
        );
      }
    },
  );

  register(
    "verify_text",
    {
      capability: "read",
      batchable: true,
      description:
        "Assert the targeted element's visible text matches. Fail-emitting (`ok:false` + structured `failure`) — distinct from `text_search` (which counts matches over the whole page) and `wait_for` (permissive). Default substring + case-insensitive; pass `exact:true` for case-sensitive equality on the trimmed text. Read-only.",
      inputSchema: {
        ...VERIFY_TARGET,
        text: z.string().describe("Text to assert against the element's visible text."),
        exact: z
          .boolean()
          .optional()
          .describe(
            "Default false (case-insensitive substring). When true, case-sensitive equality on trimmed innerText.",
          ),
      },
    },
    async (args) => {
      const g = gateCheck("verify_text");
      if (g) return g;
      const e = await entryFor(args.session);
      const target = asTarget(args, "verify_text", e.refs);
      if ("coords" in target) {
        return verifyResultText(
          {
            ok: false,
            failure: {
              source: "browxai",
              kind: "text",
              expected: "ref/selector/named target",
              actual: "coords target",
            },
          },
          e,
        );
      }
      try {
        const res = await withDeadline(
          verifyText(e.session.page(), e.refs, target, args.text, args.exact === true),
          cfgActionTimeout(),
          "verify_text",
        );
        return verifyResultText(res, e);
      } catch (err) {
        return verifyResultText(
          {
            ok: false,
            failure: {
              source: "browxai",
              kind: "text",
              expected: "verify_text to complete",
              actual: err instanceof Error ? err.message : String(err),
            },
          },
          e,
        );
      }
    },
  );

  register(
    "verify_value",
    {
      capability: "read",
      batchable: true,
      description:
        "Assert the targeted form-control's current value (input/textarea/select/contenteditable). Fail-emitting (`ok:false` + structured `failure`). Use to confirm a controlled-component fill landed without an extra round-trip — pairs with `ActionResult.element.value` from `fill`. Read-only.",
      inputSchema: {
        ...VERIFY_TARGET,
        value: z
          .string()
          .describe("Expected value (strict equality after String() of the DOM-side `value`)."),
      },
    },
    async (args) => {
      const g = gateCheck("verify_value");
      if (g) return g;
      const e = await entryFor(args.session);
      const target = asTarget(args, "verify_value", e.refs);
      if ("coords" in target) {
        return verifyResultText(
          {
            ok: false,
            failure: {
              source: "browxai",
              kind: "value",
              expected: "ref/selector/named target",
              actual: "coords target",
            },
          },
          e,
        );
      }
      try {
        const res = await withDeadline(
          verifyValue(e.session.page(), e.refs, target, args.value),
          cfgActionTimeout(),
          "verify_value",
        );
        return verifyResultText(res, e);
      } catch (err) {
        return verifyResultText(
          {
            ok: false,
            failure: {
              source: "browxai",
              kind: "value",
              expected: "verify_value to complete",
              actual: err instanceof Error ? err.message : String(err),
            },
          },
          e,
        );
      }
    },
  );

  register(
    "verify_count",
    {
      capability: "read",
      batchable: true,
      description:
        'Assert exactly `n` elements match. Pass one of `selector` (raw CSS / Playwright locator) or `text` (case-insensitive visible-text search over the composed a11y tree, same shape as `text_search`). Fail-emitting (`ok:false` + structured `failure`). Use for grid/list invariants — "there are 5 rows after the delete", "no \'Wrong Type\' values left in the table". Read-only.',
      inputSchema: {
        selector: z
          .string()
          .optional()
          .describe("CSS / selectorHint to count. Mutually exclusive with `text`."),
        text: z
          .string()
          .optional()
          .describe("Visible text to count (case-insensitive substring across the a11y tree)."),
        n: z.number().int().nonnegative().describe("Exact expected count."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("verify_count");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const res = await withDeadline(
          verifyCount(e.session.page(), requireCdp(e.session), e.refs, {
            selector: args.selector,
            text: args.text,
            n: args.n,
            testAttributes: config.testAttributes,
          }),
          cfgActionTimeout(),
          "verify_count",
        );
        return verifyResultText(res, e);
      } catch (err) {
        return verifyResultText(
          {
            ok: false,
            failure: {
              source: "browxai",
              kind: "count",
              expected: "verify_count to complete",
              actual: err instanceof Error ? err.message : String(err),
            },
          },
          e,
        );
      }
    },
  );

  register(
    "verify_attribute",
    {
      capability: "read",
      batchable: true,
      description:
        "Assert the targeted element's HTML attribute matches. Pass `value` to require equality; omit `value` to require presence (any value). Fail-emitting (`ok:false` + structured `failure`). Use for `aria-*` / `data-*` / `disabled` / role state that doesn't surface as visible text. Read-only.",
      inputSchema: {
        ...VERIFY_TARGET,
        attr: z
          .string()
          .describe('Attribute name to read (e.g. "aria-pressed", "data-state", "disabled").'),
        value: z
          .string()
          .optional()
          .describe(
            "Expected attribute value (strict string equality). Omit to assert the attribute is merely present.",
          ),
      },
    },
    async (args) => {
      const g = gateCheck("verify_attribute");
      if (g) return g;
      const e = await entryFor(args.session);
      const target = asTarget(args, "verify_attribute", e.refs);
      if ("coords" in target) {
        return verifyResultText(
          {
            ok: false,
            failure: {
              source: "browxai",
              kind: "attribute",
              expected: "ref/selector/named target",
              actual: "coords target",
            },
          },
          e,
        );
      }
      try {
        const res = await withDeadline(
          verifyAttribute(e.session.page(), e.refs, target, args.attr, args.value),
          cfgActionTimeout(),
          "verify_attribute",
        );
        return verifyResultText(res, e);
      } catch (err) {
        return verifyResultText(
          {
            ok: false,
            failure: {
              source: "browxai",
              kind: "attribute",
              expected: "verify_attribute to complete",
              actual: err instanceof Error ? err.message : String(err),
            },
          },
          e,
        );
      }
    },
  );

  // Recursive predicate shape — z.lazy lets the schema reference itself for
  // the and/or/not combinators. NOT an arbitrary-JS path: the `kind` enum and
  // `key` accessor list are fixed server-side (see src/util/predicates.ts).
  const PREDICATE_SCHEMA: ZodNamespace.ZodType<Predicate> = z.lazy(() =>
    z.union([
      z.object({
        kind: z.enum([
          "equals",
          "notEquals",
          "contains",
          "notContains",
          "gt",
          "lt",
          "gte",
          "lte",
          "matches",
          "exists",
        ]),
        key: z
          .string()
          .describe(
            'Dotted accessor into `data` (e.g. "actionResult.element.value"). Must start with an allow-listed root (actionResult, snapshot, element, value, expect).',
          ),
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
      }),
      z.object({
        kind: z.literal("between"),
        key: z.string(),
        lo: z.number(),
        hi: z.number(),
      }),
      z.object({
        kind: z.enum(["and", "or", "not"]),
        predicates: z.array(PREDICATE_SCHEMA).min(1),
      }),
    ]),
  );

  register(
    "verify_predicate",
    {
      capability: "read",
      batchable: true,
      description:
        'Composed predicate check over a caller-supplied `data` bag — fixed vocabulary, NOT arbitrary JS. The predicate `kind` is a fixed enum (`equals`/`notEquals`/`contains`/`notContains`/`gt`/`lt`/`gte`/`lte`/`between`/`matches`/`exists`, plus `and`/`or`/`not` combinators). The accessor `key` must start with an allow-listed root: `actionResult`, `snapshot`, `element`, `value`, `expect`. The model supplies *data* (which key, which expected value); the *vocabulary* is server-owned. Use as a deterministic gate on an already-captured ActionResult / snapshot / metric (the screenshot-judge analogue when chained behind a `screenshot`). Fail-emitting: `source:"app"` when the predicate didn\'t hold; `source:"browxai"` when the predicate shape itself is malformed. `eval_js` (gated behind `eval`) remains the only arbitrary-JS path — verify_predicate does NOT add a second.',
      inputSchema: {
        predicate: PREDICATE_SCHEMA.describe(
          "The predicate to evaluate. Recursive shape — and/or/not nest leaf predicates.",
        ),
        data: z
          .record(z.unknown())
          .describe(
            "Bag the predicate reads from. Typically `{ actionResult: <prior result>, snapshot?: <prior snapshot output>, element?: {...} }`. Accessor keys are resolved against this object; only allow-listed root segments are honoured.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("verify_predicate");
      if (g) return g;
      // Resolve the session entry so `failure.actual` (which may echo a
      // string lifted from the caller-supplied `data` bag — e.g. a prior
      // ActionResult.element.value that pre-dated masking) gets re-masked
      // through the same egress chokepoint as the other verify_* tools.
      const e = await entryFor(args.session);
      const res = verifyPredicate(args.predicate, args.data);
      return verifyResultText(res, e);
    },
  );

}
