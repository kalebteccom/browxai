import { requireCdp, requirePage } from "../engine/index.js";
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
  const { z, register, gateCheck, entryFor, engineGate, cfgActionTimeout, config, targetFor } =
    host;

  register(
    "shadow_trees",
    {
      capability: "read",
      batchable: true,
      deep: true,
      description:
        "List the shadow roots in the page: host ref, host tag, mode (open or closed), children and descendant count. Use it to find hosts before `snapshot({includeShadow})` or `find({pierce})`. Returns `{ trees: [{hostRef, hostTag, mode, children, descendantCount}], closedShadowAvailable, warnings, tokensEstimate }`. Pass `ref` to limit it to one host's subtree, else it walks every root under the document. Closed roots are read through CDP, so the tool runs on Chromium-family engines only and is refused elsewhere; closed-root content is inspect-only because action tools cannot reach it.",
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
        'Pull structured data off the page with a JSON-schema-style shape and get `data` back in that shape. Use it for lists and records (a table into rows); use `snapshot` to read a page, `find` for one element and `text_search` to check text. Returns `{ok, data, evidence:{refsUsed, selectorsUsed, partialMisses}, tokensEstimate}`, or `{ok:false, failure}` on a required miss. Misses are listed in `evidence.partialMisses`, never coerced into a malformed object. Schema `type` is `object`, `array`, `string`, `number` or `boolean` (`integer` is coerced to `number` with a note; `null`, `any` and unions are rejected). By default a property\'s name is the query: `price` matches a node whose accessible name or test id contains "price". Override a property with `x-browx-source`: `selector` (CSS, scoped to the current subtree), `attr` (HTML attribute name), `prop` (DOM property name), `text:true` (visible text, the default) or `value:true` (form-control value). Strings like "$1,234.50" coerce to 1234.5 for `number`. Every array needs `x-browx-source.collection` (CSS selector or query for the row container; `selector` is accepted as an alias when `collection` is absent), else it is a partial miss. Scope with `ref` or `scope` (CSS); both absent means the whole page, and a scope with no match returns a failure. `BROWX_EXTRACT_STRICT=1` at server start turns unknown `x-browx-source` keys into `invalid-schema` failures. The per-field `query` key and the `mode` argument are retired and only warn.',
      inputSchema: {
        schema: z
          .record(z.string(), z.unknown())
          .describe(
            "JSON-schema-style shape: `type` object, array, string, number or boolean; `properties` for objects, `items` for arrays. Per-property `x-browx-source` (`selector`, `attr`, `prop`, `text`, `value`, and `collection` for arrays) overrides the property-name query. `required:true` makes a miss fail the call; `default` is the fallback for an optional miss.",
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
            "Retired. The only supported value is `deterministic`; `llm-assisted` is accepted, warns and runs as deterministic. Leave it out.",
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
          extract(requirePage(s), e.snapshotSubstrate, e.refs, {
            schema: args.schema,
            ref: args.ref,
            scope: args.scope,
            mode: args.mode,
            testAttributes: config.testAttributes,
          }),
          cfgActionTimeout(),
          "extract",
        );
        // Only successful reads, and the schema rather than the returned data:
        // the trace stays free of page content, and the schema is what the
        // export lowers to per-field reads.
        if (result.ok) {
          e.recorder.recordRead(
            { type: "extract", schema: args.schema, scope: args.scope ?? args.ref },
            await targetFor(e)
              .url()
              .catch(() => ""),
          );
        }
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
