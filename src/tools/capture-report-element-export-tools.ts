import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { elementExportFromRef } from "../page/element-export.js";
import { domExport } from "../page/dom-export.js";
import { detectOverflow } from "../page/overflow-detect.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Capture + report — element-level export & layout diagnosis. `element_export`
 * (a self-contained snippet for one ref's subtree), `dom_export` (the serialised
 * DOM tree), and `overflow_detect` (clipped / ellipsis / viewport-overflow
 * diagnosis). Registered through the shared `ToolHost` seam.
 */
export function registerCaptureReportElementExportTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    cfgActionTimeout,
    workspace,
  } = host;

  // `element_export` — save the subtree under one ref as a self-contained
  // HTML snippet plus its rendered CSS + linked resources. Sibling to
  // `page_archive`, scoped to a single element instead of the whole
  // document. Workspace-rooted output by construction; same UNMASKED
  // posture as `page_archive` (rationale: secrets-masking is literal-
  // substring substitution that would corrupt inline JSON / CSS /
  // binary bytes).
  register(
    "element_export",
    {
      capability: "file-io",
      description:
        "Save a specific element subtree as a self-contained snippet — outerHTML + page-wide stylesheets + every linked resource the subtree references. Two formats: `directory` (default) writes `<intoDir>/element.html` + `<intoDir>/assets/` sidecar with images / fonts / scripts / stylesheets / CSS background-images (rewriting internal refs to relative `assets/...` paths); `single-file` writes one self-contained HTML at `<intoDir>` with resources inlined as `data:` URIs (browsers struggle past ~150 MB — large subtrees should prefer `directory`). `ref` must come from a prior `snapshot()` / `find()`; ref-not-found is a structured error, not a silent miss. `intoDir` is resolved INSIDE `$BROWX_WORKSPACE` (escape rejected); omit for `elements/<sessionId>-<ISO>-<ref>` (directory) or `elements/<sessionId>-<ISO>-<ref>.html` (single-file). `maxSizeMb` caps the total export (default 50, smaller than `page_archive`'s 200 — a snippet is meant to be a slice). Cross-origin stylesheets the page can't read are reported in `warnings[]` (the snippet may render differently than the source page). → `{ ok, format, ref, path, sizeBytes, resourceCount, droppedCount, warnings[] }`. **Secrets-masking caveat**: the export is intentionally UNMASKED — running the egress masking layer would corrupt the file; treat the export as sensitive (same posture as `page_archive` / `dump_storage_state`). Capability `file-io`.",
      inputSchema: {
        ref: z
          .string()
          .describe(
            "Ref of the element subtree to export. Minted by a prior `snapshot()` / `find()`.",
          ),
        format: z
          .enum(["directory", "single-file"])
          .optional()
          .describe(
            "`directory` (default) → element.html + assets/ sidecar; `single-file` → one HTML with data:-URI-inlined resources + inline CSS.",
          ),
        intoDir: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output target (directory for `directory` format; .html file for `single-file`). Default `elements/<sessionId>-<ISO>-<ref>[.html]`. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        maxSizeMb: z
          .number()
          .positive()
          .max(10_000)
          .optional()
          .describe(
            "Total export size cap (MB). Default 50. Resources past the budget are dropped + counted.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("element_export");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          elementExportFromRef(e.session.page(), e.refs, workspace.root, e.id, {
            ref: args.ref,
            format: args.format,
            intoDir: args.intoDir,
            maxSizeMb: args.maxSizeMb,
          }),
          cfgActionTimeout(),
          "element_export",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `dom_export` — full DOM dump, either as `document.documentElement.
  // outerHTML` (the platform serialization, but blind to shadow content)
  // or as a JSONL node-per-line tree that DOES descend open shadow roots.
  // Closed shadow roots are a web-platform constraint — unreachable from
  // any tool. Workspace-rooted output; same UNMASKED posture as
  // `page_archive` / `element_export`.
  register(
    "dom_export",
    {
      capability: "file-io",
      description:
        "Full DOM dump to a workspace-rooted file. Two formats: `html` (default) writes `document.documentElement.outerHTML` after the agent's prior stabilization — note the platform serializer does NOT include shadow-DOM content (open OR closed), even for elements that have one. `jsonl` writes one JSON object per line (`{tag, role?, attrs, text?, ref?, depth}`) via a depth-first walk that DOES descend open shadow roots when `includeShadow:true` (default). Closed shadow roots are inaccessible by web-platform design — the tree behind them is genuinely unreachable from this dump, surfaced in `warnings[]` when custom elements are present. `path` is resolved INSIDE `$BROWX_WORKSPACE` (escape rejected); omit for `dom-dumps/<sessionId>-<ISO>.{html|jsonl}`. → `{ ok, format, path, sizeBytes, nodeCount, shadowRootCount, warnings[] }`. **Secrets-masking caveat**: the dump is intentionally UNMASKED — running the egress masking layer would corrupt inline JSON / CSS / binary bytes; treat the dump as sensitive (same posture as `page_archive` / `dump_storage_state`). Caller must navigate + settle the page BEFORE calling. Capability `file-io`.",
      inputSchema: {
        format: z
          .enum(["html", "jsonl"])
          .optional()
          .describe(
            "`html` (default) → documentElement.outerHTML (shadow content not serialised); `jsonl` → one JSON node per line, depth-first, descends open shadow roots when `includeShadow`.",
          ),
        includeShadow: z
          .boolean()
          .optional()
          .describe(
            "Walk open shadow roots (`jsonl` mode). Default `true`. Closed shadow roots are inaccessible regardless.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted output file. Default `dom-dumps/<sessionId>-<ISO>.{html|jsonl}`. Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("dom_export");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          domExport(e.session.page(), workspace.root, e.id, {
            format: args.format,
            includeShadow: args.includeShadow,
            path: args.path,
          }),
          cfgActionTimeout(),
          "dom_export",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // `overflow_detect` — diagnose page-layout overflow on the target page.
  // The silent UI-breakage primitive: clipped buttons, ellipsis-truncated
  // labels, horizontal-scrollbar-on-mobile bugs. Generalises `inspect`'s
  // per-element overflow check into a page-wide scan with four typed
  // detectors (`layout`, `clipped`, `text-ellipsis`, `viewport-horizontal`).
  // Read-only, no mutation, no new capability — rides `read`.
  register(
    "overflow_detect",
    {
      capability: "read",
      batchable: true,
      description:
        'Diagnose page-layout overflow — the silent UI-breakage primitive (clipped buttons, ellipsis-truncated labels, horizontal-scrollbar-on-mobile bugs). Walks the DOM and reports one finding per offending element across four detector types: `layout` (`scrollWidth/Height > clientWidth/Height` on an element with `overflow:auto|scroll` — scrollbar present but content overruns), `clipped` (same dimensions but `overflow:hidden|clip` — content invisible with no scrollbar to recover, the highest-value finding), `text-ellipsis` (`text-overflow:ellipsis` with `scrollWidth > clientWidth` — surfaces `visibleText` heuristic + `fullText` truth), `viewport-horizontal` (singleton: `documentElement.scrollWidth > clientWidth` — the body horizontal-scrollbar mobile bug; evidence carries the overrun amount + the widest overrunning descendant when cheaply identifiable). EPSILON = 1 CSS px tolerates sub-pixel rounding noise. `scope:"document"` (default) walks every element; `scope:"viewport"` skips elements fully off-screen. `types:[...]` filters which detectors fire (default = all four; empty array also treated as default). `limit` caps findings (default 50, max 500; over-cap sets `truncated:true`). Walk bounded at 10000 elements — a hit surfaces a `warnings[]` entry suggesting `scope:viewport` for a narrower pass. Each finding: `{selector, bbox: {x,y,w,h} | null, type, evidence}`. Selector synthesis tiers: `[data-testid]` > `[role][aria-label]` > nth-of-type CSS path (≤5 levels) > `tag.classes` (≤3); capped at 200 chars (longer falls through to bare tag with `evidence.selectorTruncated`). Read-only (capability `read`).',
      inputSchema: {
        scope: z
          .enum(["viewport", "document"])
          .optional()
          .describe(
            "`document` (default) walks every element; `viewport` skips elements fully off-screen — cheaper on very large pages.",
          ),
        types: z
          .array(z.enum(["layout", "clipped", "text-ellipsis", "viewport-horizontal"]))
          .optional()
          .describe(
            "Detector types to surface. Default = all four. Empty array treated as default (an empty filter would silently match nothing — usage error).",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe(
            "Cap on findings returned. Default 50, max 500. Findings past the cap are dropped + `truncated:true` is set.",
          ),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("overflow_detect");
      if (g) return g;
      const e = await entryFor(args.session);
      try {
        const r = await withDeadline(
          detectOverflow(e.session.page(), {
            scope: args.scope,
            types: args.types,
            limit: args.limit,
          }),
          cfgActionTimeout(),
          "overflow_detect",
        );
        const json = JSON.stringify(r);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
            },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
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
