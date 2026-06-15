import { requireCdp } from "../engine/index.js";
import { findByRef } from "../page/snapshot.js";
import { fetchPiercedDocument, collectShadowTrees, runOpenShadowWalk } from "../page/shadow.js";
import { extract } from "../page/extract.js";
import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

type SessionEntry = Awaited<ReturnType<ToolHost["entryFor"]>>;
type Session = SessionEntry["session"];

interface ShadowTree {
  hostRef: string;
  hostTag: string;
  mode: "open" | "closed";
  children: unknown[];
  descendantCount: number;
}

/** Collect shadow trees via the CDP pierce path (open + closed); when CDP yields
 *  nothing, fall back to the page-side open-shadow walk. Pushes any failures as
 *  warnings (the tool still returns a partial result). */
async function collectShadowTreesForRef(
  s: Session,
  warnings: string[],
  opts: {
    rootBackendId: number | undefined;
    scopeSelector: string | undefined;
    cap: number;
    timeoutMs: number;
  },
): Promise<{ trees: ShadowTree[]; closedShadowAvailable: boolean; cappedAt: number | undefined }> {
  let trees: ShadowTree[] = [];
  let closedShadowAvailable = false;
  let cappedAt: number | undefined;
  try {
    const fetched = await withDeadline(
      fetchPiercedDocument(requireCdp(s)),
      opts.timeoutMs,
      "shadow_trees",
    );
    if (fetched.warning) warnings.push(fetched.warning);
    closedShadowAvailable = fetched.closedAvailable;
    if (fetched.root) {
      const harvested = collectShadowTrees(fetched.root, {
        rootBackendNodeId: opts.rootBackendId,
        maxHosts: opts.cap,
      });
      trees = harvested.entries;
      cappedAt = harvested.cappedAt;
    }
  } catch (err) {
    warnings.push(
      `CDP pierce path failed (${err instanceof Error ? err.message : String(err)}); falling back to open-only page-side walk.`,
    );
  }
  if (trees.length === 0) {
    try {
      const open = await withDeadline(
        runOpenShadowWalk(requireCdp(s), opts.scopeSelector, opts.cap),
        opts.timeoutMs,
        "shadow_trees",
      );
      // page-side walk can't address by backendNodeId — surface "backend:0" so
      // the field is non-empty and the agent sees the host came from that path.
      trees = open.map((o) => ({ hostRef: "backend:0", ...o }));
    } catch (err) {
      warnings.push(
        `open-shadow page-side walk failed (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }
  return { trees, closedShadowAvailable, cappedAt };
}

/** Resolve a `shadow_trees` ref into a CDP `backendNodeId` (preferred) or a CSS
 *  scope selector (DOM-walk fallback). Returns undefineds + a warning when the
 *  ref doesn't resolve to an addressable node. */
async function resolveShadowScope(
  e: SessionEntry,
  ref: string,
  warnings: string[],
  deps: { testAttributes: string[]; timeoutMs: number },
): Promise<{ rootBackendId: number | undefined; scopeSelector: string | undefined }> {
  const out: { rootBackendId: number | undefined; scopeSelector: string | undefined } = {
    rootBackendId: undefined,
    scopeSelector: undefined,
  };
  try {
    const composed = await withDeadline(
      e.snapshotSubstrate.compose(e.refs, deps.testAttributes),
      deps.timeoutMs,
      "shadow_trees",
    );
    if (!composed.tree) {
      warnings.push("snapshot returned an empty tree; walking from the document root instead.");
      return out;
    }
    const sub = findByRef(composed.tree, ref);
    if (sub?.backendDOMNodeId !== undefined) {
      out.rootBackendId = sub.backendDOMNodeId;
    } else if (sub) {
      // DOM-walk-sourced nodes don't carry backendDOMNodeId; fall back to their
      // CSS path via the registry's locator hints.
      const loc = e.refs.locatorOf(ref);
      if (loc?.cssPath) out.scopeSelector = loc.cssPath;
      else
        warnings.push(
          `ref=${ref} resolved to a node with no addressable backend handle; walking from the document root instead.`,
        );
    } else {
      warnings.push(
        `ref=${ref} not found in the current snapshot; walking from the document root instead.`,
      );
    }
  } catch (err) {
    warnings.push(
      `failed to resolve ref=${ref} (${err instanceof Error ? err.message : String(err)}); walking from the document root.`,
    );
  }
  return out;
}

/**
 * Read / observe — extraction + Shadow DOM introspection. `shadow_trees` walks
 * open and (via CDP pierce) closed shadow roots; `extract` lowers a JSON-schema
 * contract to deterministic `find()`-style queries. Registered through the
 * shared `ToolHost` seam.
 */
export function registerReadObserveExtractTools(host: ToolHost): void {
  const { z, register, gateCheck, entryFor, engineGate, cfgActionTimeout, config } = host;

  register(
    "shadow_trees",
    {
      capability: "read",
      batchable: true,
      deep: true,
      description:
        "Read-only introspection of Shadow DOM trees. Returns `{ trees: [{hostRef, hostTag, mode, children, descendantCount}], closedShadowAvailable, warnings, tokensEstimate }`. Pass `ref` to limit the walk to one host's subtree (the ref comes from a prior `snapshot` / `find`); omit `ref` to walk every shadow root under the document root. The walker tries CDP `DOM.getDocument({pierce:true})` first (covers both open AND closed shadow roots, Chromium-DevTools-protocol path); on CDP refusal it falls back to a page-side walk that covers open shadow only. Closed-shadow entries are inspect-only: Playwright's action tools (click/fill/etc) cannot reach them through the locator engine. Capability `read`.",
      inputSchema: {
        ref: z
          .string()
          .optional()
          .describe(
            "Limit the walk to the shadow subtree under this host ref. Omit to walk every shadow root in the document.",
          ),
        maxHosts: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe(
            "Cap on returned hosts (default 200). The walk truncates with a `cappedAt` field on the result when the cap is hit.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ ref, maxHosts, session }) => {
      const g = gateCheck("shadow_trees");
      if (g) return g;
      const e = await entryFor(session);
      // shadow_trees is CDP-deep: closed-shadow piercing needs CDP
      // `DOM.getDocument({pierce:true})`, which has no off-Chromium protocol
      // equivalent (closed-shadow is the one true feature-level loss).
      // Gate it on engines without CDP.
      const eg = engineGate("shadow_trees", e);
      if (eg) return eg;
      const s = e.session;
      const warnings: string[] = [];
      const cap = maxHosts ?? 200;

      // Resolve `ref` → backendNodeId (or a CSS scope fallback) via a fresh
      // compose pass. Same model as `snapshot({scope})`.
      const scope = ref
        ? await resolveShadowScope(e, ref, warnings, {
            testAttributes: config.testAttributes,
            timeoutMs: cfgActionTimeout(),
          })
        : { rootBackendId: undefined, scopeSelector: undefined };
      const { rootBackendId, scopeSelector } = scope;

      // Collect via CDP pierce (open + closed); fall back to the page-side
      // open-shadow walk when CDP returns nothing.
      const collected = await collectShadowTreesForRef(s, warnings, {
        rootBackendId,
        scopeSelector,
        cap,
        timeoutMs: cfgActionTimeout(),
      });
      const { closedShadowAvailable, cappedAt } = collected;
      // Hard de-duplicate by hostRef + hostTag + mode — defensive guard for the
      // (rare) case both paths produced the same host.
      const seen = new Set<string>();
      const dedup = collected.trees.filter((t) => {
        const k = `${t.hostRef}|${t.hostTag}|${t.mode}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      const body: Record<string, unknown> = {
        trees: dedup,
        closedShadowAvailable,
        warnings,
      };
      if (cappedAt !== undefined) body.cappedAt = cappedAt;
      const tokensEstimate = estimateTokens(JSON.stringify(body));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
        ],
      };
    },
  );

  // `extract` — structured, schema-driven data extraction. The
  // schema-as-contract primitive every adopter currently rebuilds on top
  // of `snapshot()`. JSON-schema input (so it transports cleanly over MCP);
  // deterministic mode lowers each property to a `find()`-style query or
  // explicit selector via the `x-browx-source` annotation. LLM-assisted
  // mode is reserved as a typed seam.
  register(
    "extract",
    {
      capability: "read",
      description:
        "Structured, schema-driven data extraction. Returns {ok, data: <schema-shaped>, evidence:{refsUsed,selectorsUsed,partialMisses}, tokensEstimate} (or {ok:false, failure} for misses). The schema is the contract — partial / required misses surface in `evidence.partialMisses` / `failure.partialMisses`, never silently coerced into a malformed object. " +
        '**Supported `type` values (closed set):** `object`, `array`, `string`, `number`, `boolean`. JSON-Schema\'s `integer` is accepted as a schema-dialect alias for `"number"` (auto-coerced; a `partialMisses` note records the coercion so adopters can migrate explicitly). `null`, `any`, and union types are rejected. ' +
        'Deterministic by default: each property lowers to a selector-based query scoped to the current subtree. **Implicit rule**: the property *name* IS the find()-style query — `{type:"string"}` property "price" matches a node whose accessible name / testid contains "price". **Explicit escape hatch — `x-browx-source` per property** with one of these keys (other keys are silently dropped at the resolver but surface as `unknown \\`x-browx-source\\` key` diagnostics in `evidence.partialMisses` — see `BROWX_EXTRACT_STRICT` below to promote those to hard rejections): `selector` (raw CSS, scoped to current locator), `attr` (HTML attribute name — NOT `attribute`), `prop` (DOM property name — NOT `property`), `text:true` (visible-text, the default), `value:true` (form-control value, alias for `prop:"value"`). The per-field `query` key is RETIRED as of v0.3.3 (the NL tree-scan ranker is unreliable for explicit prose queries — see CHANGELOG) — use `selector` for per-field targeting; if passed, it is tolerated with a one-shot warn and a partialMisses entry naming the field. No `transform`/`format`/`regex` — the leaf coercer handles `"$1,234.50" → 1234.5` for `type:"number"` automatically. ' +
        '**For lists**: `{type:"array", items:<schema>, "x-browx-source":{collection:"<selectorOrQuery>"}}` — `collection` is REQUIRED on every array (the row-container CSS selector or NL query; each match becomes a per-row scope for `items`). On array schemas, `selector` is accepted as an alias for `collection` (when `collection` is absent); when both are present, `collection` wins. Arrays without either are surfaced as a partialMiss (or required-miss failure if `required:true`); there\'s no defensible implicit default. ' +
        "**Strict mode** (opt-in via `BROWX_EXTRACT_STRICT=1` env at server boot): unknown-`x-browx-source`-key diagnostics become hard `ok:false` `invalid-schema` rejections instead of soft `partialMisses` entries — enable for first-class typo detection. The integer→number coerce and array-`selector`-alias are NOT promoted by strict mode (educational signals, not typo-like errors). " +
        'Scope to a `ref` (registered) or `scope` (CSS selector); both absent = whole page. Invalid scope (no matches) → structured failure, not empty object. The `mode` arg is RETIRED as of v0.3.2 — deterministic is the only supported path; passing `mode:"llm-assisted"` is tolerated for back-compat (treated as deterministic, emits a one-shot warn) but the typed SDK no longer exposes the field. Read-only.',
      inputSchema: {
        schema: z
          .record(z.unknown())
          .describe(
            "JSON-schema-flavoured shape (object/array/string/number/boolean; `properties` for objects, `items` for arrays). `x-browx-source.selector` (raw CSS) per-property overrides the implicit name-as-query rule. (`x-browx-source.query` is RETIRED in v0.3.3 — tolerated with warn + partialMisses entry.) `required:true` causes a miss to fail-emit; `default` supplies an optional-miss fallback.",
          ),
        ref: z
          .string()
          .optional()
          .describe(
            "Scope extraction to this ref's subtree (from a prior snapshot/find). Mutually exclusive with `scope`.",
          ),
        scope: z
          .string()
          .optional()
          .describe(
            "Scope extraction to this CSS selector's first match. Mutually exclusive with `ref`. Invalid (no matches) → structured failure.",
          ),
        mode: z
          .enum(["deterministic", "llm-assisted"])
          .optional()
          .describe(
            "RETIRED in v0.3.2. Default and only supported value is 'deterministic' (selector-only). 'llm-assisted' is tolerated for back-compat (warn + fall through to deterministic) but is no longer in the typed SDK surface; drop the arg from new code.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("extract");
      if (g) return g;
      const e = await entryFor(args.session);
      const s = e.session;
      try {
        const result = await withDeadline(
          extract(s.page(), e.snapshotSubstrate, e.refs, {
            schema: args.schema,
            ref: args.ref,
            scope: args.scope,
            mode: args.mode,
            testAttributes: config.testAttributes,
          }),
          cfgActionTimeout(),
          "extract",
        );
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  failure: {
                    source: "browxai",
                    kind: "internal",
                    expected: "extract to complete",
                    actual: err instanceof Error ? err.message : String(err),
                  },
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
