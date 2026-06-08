// `dom_export` — full DOM dump.
//
// Two formats:
//
//   - `html` (default) — `document.documentElement.outerHTML` written
//     verbatim to a workspace-rooted `.html` file. The agent has already
//     stabilized the page (`navigate` + any settle) — the tool does NOT
//     inject its own wait, same posture as `page_archive`.
//
//   - `jsonl` — one JSON object per line, depth-first walk:
//       `{tag, role?, attrs, text?, ref?, depth}`
//     A grep-friendly serialization for the cases where the agent needs
//     to scan structure without parsing HTML. `attrs` is a flat
//     attribute-name → value map; `text` is set only for nodes whose
//     direct text content is non-empty (whitespace-trimmed); `ref` echoes
//     the stable `eN` ref when the node was discovered as part of a prior
//     `snapshot()` / `find()` (otherwise omitted — refs aren't minted
//     during the dump itself).
//
// Shadow-DOM traversal (default ON, `includeShadow:true`):
//   The walker descends into every open shadow root (`Element.shadowRoot`
//   when not null). Closed shadow roots are inaccessible by web-platform
//   design — `shadowRoot` returns null and the tree behind them is
//   genuinely unreachable. The result envelope surfaces the limitation
//   via `warnings[]` when the document is detected to have HTML content
//   that hints at custom elements (best-effort heuristic).
//
// Secrets-masking interplay (DELIBERATE GAP):
//   Same gap as `page_archive` / `element_export`. The dump is faithful;
//   running egress masking over it would corrupt inline JSON state blobs.
//   The `warnings[]` array always carries the caveat as its first entry.

import { resolve as resolvePath } from "node:path";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Page } from "playwright-core";
import { resolveWorkspacePath } from "../session/storage.js";

export type DomExportFormat = "html" | "jsonl";

export interface DomExportArgs {
  /** Output format. Default `"html"`. */
  format?: DomExportFormat;
  /** Walk open shadow roots when serialising. Default `true`. Closed
   *  shadow roots are inaccessible (web-platform constraint). */
  includeShadow?: boolean;
  /** Workspace-rooted output path. Default
   *  `dom-dumps/<sessionId>-<ISO>.{html|jsonl}`. Rejected if it escapes
   *  $BROWX_WORKSPACE. */
  path?: string;
}

export interface DomExportResult {
  ok: true;
  format: DomExportFormat;
  /** Absolute, workspace-rooted output path. */
  path: string;
  /** Size on disk, in bytes. */
  sizeBytes: number;
  /** Total DOM nodes walked. For `html` mode, derived from a single
   *  page-side count; for `jsonl` mode, the line count. */
  nodeCount: number;
  /** Count of open shadow roots descended into during the walk. Zero
   *  for `html` mode (shadow content is inaccessible to `outerHTML` —
   *  see the warning). */
  shadowRootCount: number;
  /** Non-fatal advisories. Always carries the secrets-masking caveat;
   *  also surfaces the closed-shadow + outerHTML-loses-shadow gaps. */
  warnings: string[];
}

/** Workspace-relative default — namespaced under `dom-dumps/`. */
export function defaultDomExportPath(sessionId: string, format: DomExportFormat): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = format === "jsonl" ? ".jsonl" : ".html";
  return `dom-dumps/${safe}-${ts}${ext}`;
}

/** Page-side walk function — returns either a single string (html mode)
 *  or an array of JSONL-ready objects (jsonl mode). One round-trip per
 *  invocation; the dump is bounded by the page's DOM size, no per-node
 *  evaluate. */
const PAGE_WALK_FN = `(args) => {
  var mode = args.mode;
  var includeShadow = args.includeShadow;
  // Best-effort detection: does the document mention any registered
  // custom element? Used to surface the closed-shadow caveat only when
  // it's likely relevant. We don't attempt to discriminate open vs
  // closed; the warning is informational either way.
  var hasCustomElements = false;
  try {
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length && i < 500; i++) {
      if (all[i].tagName && all[i].tagName.indexOf('-') !== -1) { hasCustomElements = true; break; }
    }
  } catch (_) {}

  if (mode === 'html') {
    var html = document.documentElement ? document.documentElement.outerHTML : '';
    var count = 0;
    try { count = document.querySelectorAll('*').length; } catch (_) {}
    return { html: html, nodeCount: count, shadowRootCount: 0, hasCustomElements: hasCustomElements };
  }
  // jsonl
  var nodes = [];
  var shadowRoots = 0;
  function attrsOf(el) {
    var a = {};
    var atts = el.attributes;
    if (!atts) return a;
    for (var i = 0; i < atts.length; i++) {
      a[atts[i].name] = atts[i].value;
    }
    return a;
  }
  function directText(el) {
    var t = '';
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 3) t += kids[i].nodeValue || '';
    }
    t = t.replace(/\\s+/g, ' ').trim();
    return t;
  }
  function visit(node, depth) {
    if (!node || node.nodeType !== 1) return;
    var entry = {
      tag: (node.tagName || '').toLowerCase(),
      attrs: attrsOf(node),
      depth: depth
    };
    var role = node.getAttribute && node.getAttribute('role');
    if (role) entry.role = role;
    var txt = directText(node);
    if (txt) entry.text = txt;
    // ref hint: surfaces a prior find/snapshot ref if the agent annotated
    // the DOM with a data-attribute. Pure read — we don't mint refs here.
    var refAttr = node.getAttribute && (node.getAttribute('data-browx-ref') || '');
    if (refAttr) entry.ref = refAttr;
    nodes.push(entry);

    if (includeShadow && node.shadowRoot) {
      shadowRoots++;
      var sKids = node.shadowRoot.children;
      for (var j = 0; j < sKids.length; j++) visit(sKids[j], depth + 1);
    }
    var kids = node.children;
    for (var k = 0; k < kids.length; k++) visit(kids[k], depth + 1);
  }
  if (document.documentElement) visit(document.documentElement, 0);
  return {
    nodes: nodes,
    nodeCount: nodes.length,
    shadowRootCount: shadowRoots,
    hasCustomElements: hasCustomElements
  };
}`;

interface PageWalkResult {
  html?: string;
  nodes?: Array<Record<string, unknown>>;
  nodeCount: number;
  shadowRootCount: number;
  hasCustomElements: boolean;
}

/** Thin adapter — `Page.evaluate(fn, args)`. Keeps the unit tests
 *  trivial: a stub that returns whatever `PageWalkResult` it was
 *  programmed with. */
export interface DomExportPage {
  evaluate<T>(fn: string, args?: unknown): Promise<T>;
}

export async function domExport(
  page: DomExportPage,
  workspaceRoot: string,
  sessionId: string,
  args: DomExportArgs = {},
): Promise<DomExportResult> {
  const format: DomExportFormat = args.format ?? "html";
  const includeShadow = args.includeShadow ?? true;
  const relPath = args.path ?? defaultDomExportPath(sessionId, format);
  const resolved = resolveWorkspacePath(workspaceRoot, relPath, "dom_export");

  const walked = await page.evaluate<PageWalkResult>(PAGE_WALK_FN, {
    mode: format,
    includeShadow,
  });

  const warnings: string[] = [
    "dom_export output is UNMASKED — secrets-masking would corrupt the dump (literal-substring substitution breaks inline JSON / CSS / binary bytes). Treat the dump as sensitive material, same posture as page_archive / dump_storage_state.",
  ];

  // Workspace-rooted by construction — `resolved` ⊆ BROWX_WORKSPACE.
  mkdirSync(dirname(resolved), { recursive: true });

  let sizeBytes = 0;
  let nodeCount = walked.nodeCount;
  let shadowRootCount = walked.shadowRootCount;

  if (format === "html") {
    const html = walked.html ?? "";
    // workspace-rooted: resolved ⊆ BROWX_WORKSPACE (resolveWorkspacePath above).
    writeFileSync(resolved, html, "utf8");
    sizeBytes = statSync(resolved).size;
    // `outerHTML` does not serialise shadow-DOM content (open OR closed),
    // even though open shadow roots are programmatically reachable. The
    // gap is intrinsic to the platform serializer; surface it so the
    // adopter doesn't wonder where the Web Component's interior went.
    if (walked.hasCustomElements || includeShadow) {
      warnings.push(
        "html mode: `documentElement.outerHTML` does NOT include shadow-DOM content (open OR closed) — " +
        "the platform serializer omits shadow trees. For shadow content, use `format:\"jsonl\"` with `includeShadow:true` (default).",
      );
    }
  } else {
    // jsonl — one JSON object per line.
    const lines: string[] = [];
    for (const n of walked.nodes ?? []) {
      lines.push(JSON.stringify(n));
    }
    const body = lines.join("\n") + (lines.length > 0 ? "\n" : "");
    // workspace-rooted: resolved ⊆ BROWX_WORKSPACE (resolveWorkspacePath above).
    writeFileSync(resolved, body, "utf8");
    sizeBytes = statSync(resolved).size;
    nodeCount = lines.length;
  }

  if (walked.hasCustomElements) {
    warnings.push(
      "Document uses custom elements. Closed shadow roots are inaccessible by web-platform design — " +
      "any tree behind a closed root is genuinely unreachable from this dump.",
    );
  }

  return {
    ok: true,
    format,
    path: resolvePath(resolved),
    sizeBytes,
    nodeCount,
    shadowRootCount,
    warnings,
  };
}
