/// <reference lib="dom" />
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
 *  evaluate.
 *
 *  Passed as a real function literal (NOT a stringified expression) so
 *  Playwright's `Page.evaluate(fn, arg)` path serializes the source and
 *  invokes in-page with the arg — a stringified `(args) => {...}` would
 *  evaluate to the function value uncalled, which CDP can't serialize. */
const PAGE_WALK_FN = (args: { mode: DomExportFormat; includeShadow: boolean }): PageWalkResult => {
  const mode = args.mode;
  const includeShadow = args.includeShadow;
  let hasCustomElements = false;
  try {
    const all = document.querySelectorAll('*');
    for (let i = 0; i < all.length && i < 500; i++) {
      if (all[i]!.tagName && all[i]!.tagName.indexOf('-') !== -1) { hasCustomElements = true; break; }
    }
  } catch (_) {}

  if (mode === 'html') {
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    let count = 0;
    try { count = document.querySelectorAll('*').length; } catch (_) {}
    return { html, nodeCount: count, shadowRootCount: 0, hasCustomElements };
  }
  const nodes: Array<Record<string, unknown>> = [];
  let shadowRoots = 0;
  function attrsOf(el: Element): Record<string, string> {
    const a: Record<string, string> = {};
    const atts = el.attributes;
    if (!atts) return a;
    for (let i = 0; i < atts.length; i++) {
      a[atts[i]!.name] = atts[i]!.value;
    }
    return a;
  }
  function directText(el: Element): string {
    let t = '';
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i]!.nodeType === 3) t += kids[i]!.nodeValue || '';
    }
    return t.replace(/\s+/g, ' ').trim();
  }
  function visit(node: Element, depth: number): void {
    if (!node || node.nodeType !== 1) return;
    const entry: Record<string, unknown> = {
      tag: (node.tagName || '').toLowerCase(),
      attrs: attrsOf(node),
      depth,
    };
    const role = node.getAttribute('role');
    if (role) entry.role = role;
    const txt = directText(node);
    if (txt) entry.text = txt;
    const refAttr = node.getAttribute('data-browx-ref') || '';
    if (refAttr) entry.ref = refAttr;
    nodes.push(entry);

    if (includeShadow && node.shadowRoot) {
      shadowRoots++;
      const sKids = node.shadowRoot.children;
      for (let j = 0; j < sKids.length; j++) visit(sKids[j]!, depth + 1);
    }
    const kids = node.children;
    for (let k = 0; k < kids.length; k++) visit(kids[k]!, depth + 1);
  }
  if (document.documentElement) visit(document.documentElement, 0);
  return {
    nodes,
    nodeCount: nodes.length,
    shadowRootCount: shadowRoots,
    hasCustomElements,
  };
};

interface PageWalkResult {
  html?: string;
  nodes?: Array<Record<string, unknown>>;
  nodeCount: number;
  shadowRootCount: number;
  hasCustomElements: boolean;
}

/** Thin adapter — `Page.evaluate(fn, args)`. Keeps the unit tests
 *  trivial: a stub that returns whatever `PageWalkResult` it was
 *  programmed with. `evaluate` takes a real function (Playwright
 *  serializes it + invokes in-page with arg) — passing a stringified
 *  arrow expression returns the function value uncalled. */
export interface DomExportPage {
  evaluate<T, Arg>(fn: (arg: Arg) => T | Promise<T>, args?: Arg): Promise<T>;
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

  const walked = await page.evaluate(PAGE_WALK_FN, {
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
