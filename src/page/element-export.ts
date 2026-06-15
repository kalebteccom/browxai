/// <reference lib="dom" />
// `element_export` — save a specific element subtree as a self-contained
// HTML snippet plus its rendered CSS + linked resources.
//
// Sibling to `page_archive` (src/page/archive.ts), scoped to one element
// subtree instead of the whole document. The use case is "extract this
// component / card / table — I want the markup, the styles that make it
// look like it does, and the images / fonts it pulls — to a directory I
// can grep / diff / re-open offline".
//
// Two formats, same shape as page_archive:
//
//   - `directory` (default) — `<intoDir>/element.html` + `<intoDir>/assets/`
//     with every fetched resource. Internal `[src]` / `[href]` /
//     `background-image: url(...)` references in the element subtree are
//     rewritten to relative `assets/<kind>/<file>` paths.
//
//   - `single-file` — one HTML file at `<intoDir>` (a `.html` path) with
//     every linked resource inlined as `data:` URIs and computed styles
//     inlined per element. Same browser-engine soft-cap caveat as
//     `page_archive` (~150 MB).
//
// Resource discovery walks **only the element subtree** (not the whole
// document) for `[src]`, `[href]`, and computed `background-image: url(...)`
// — same heuristics as `archive.ts`'s DISCOVERY_SCRIPT but scoped to a
// `Node` instead of `document`. Stylesheets are captured page-wide (a
// stylesheet matters even if its rules only target the subtree); inline
// `<style>` blocks from the page are likewise carried over. The pragmatic
// trade-off: more CSS than strictly needed, but the snippet renders
// faithfully without the agent having to compose style extraction.
//
// Secrets-masking interplay: same deliberate gap as `page_archive`. The
// exported file is a faithful capture of the rendered subtree; running the
// per-session egress masking layer over it would corrupt inline JSON / CSS
// / binary bytes. The `warnings[]` array always carries the caveat as its
// first entry.

import { resolve as resolvePath, dirname, join } from "node:path";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
import { resolveWorkspacePath } from "../session/storage.js";
import { locatorFor } from "./locator.js";
import type { RefRegistry } from "./refs.js";
import {
  SUBTREE_DISCOVERY_FN,
  buildFetchScript,
  assetFilename,
  subdirForKind,
  mimeFromKind,
  rewriteHtml,
  directorySize,
  wrapStandalone,
  type DiscoveredResource,
  type SubtreeDiscovery,
  type FetchedResource,
  type ElementExportLocator,
  type ElementExportPage,
} from "./element-export-discovery.js";

// The subtree-discovery + asset-emission helpers (and their types) live in
// `element-export-discovery.ts`; re-export the public interfaces so callers
// import them from `./element-export.js` unchanged.
export type {
  DiscoveredResource,
  SubtreeDiscovery,
  ElementExportLocator,
  ElementExportPage,
} from "./element-export-discovery.js";

/** Export format — mirrors `ArchiveFormat`. */
export type ElementExportFormat = "directory" | "single-file";

const DEFAULT_MAX_SIZE_MB = 50;
const SINGLE_FILE_SOFT_WARN_MB = 150;
const PER_RESOURCE_HARD_MB = 50;

export interface ElementExportArgs {
  /** Ref minted by a prior `snapshot()` / `find()` call. */
  ref: string;
  /** Format. Default `"directory"`. */
  format?: ElementExportFormat;
  /** Workspace-rooted output target. For `directory` format it's a
   *  directory path; for `single-file` it's a `.html` file. When omitted,
   *  defaults to `elements/<sessionId>-<ISO>-<ref>/` (directory) or
   *  `elements/<sessionId>-<ISO>-<ref>.html` (single-file). */
  intoDir?: string;
  /** Total export size cap (MB). Default 50 (smaller than `page_archive`'s
   *  200 — an element snippet is meant to be a slice, not a meal). */
  maxSizeMb?: number;
}

export interface ElementExportResult {
  ok: true;
  format: ElementExportFormat;
  /** The ref that was exported (echoed for audit). */
  ref: string;
  /** Absolute, workspace-rooted output path (directory or file). */
  path: string;
  /** Total export size on disk, in bytes. */
  sizeBytes: number;
  /** Resources successfully fetched + included. */
  resourceCount: number;
  /** Resources skipped — drop reasons match `page_archive`. */
  droppedCount: number;
  /** Non-fatal advisories. Always carries the secrets-masking caveat. */
  warnings: string[];
}

/** Default output target when `intoDir` is omitted. Workspace-relative,
 *  namespaced under `elements/<sessionId>-<ISO>-<ref>` to match the
 *  archive subdir-per-artefact convention. */
export function defaultElementExportPath(
  sessionId: string,
  ref: string,
  format: ElementExportFormat,
): string {
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
  const safeRef = ref.replace(/[^A-Za-z0-9._-]/g, "_") || "el";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const stem = `elements/${safeSession}-${ts}-${safeRef}`;
  return format === "single-file" ? `${stem}.html` : stem;
}

/**
 * Adapter that resolves the ref + runs `elementExport`. Lives in this
 * module so the server-side handler doesn't have to know the discovery
 * details. The caller passes the live Page (for the per-URL fetch
 * round-trip) and the resolved Locator.
 */
type Fetched = { res: DiscoveredResource; r: FetchedResource };

interface FetchPhase {
  fetched: Fetched[];
  cspBlocked: number;
  perResourceOversize: number;
  runningBytes: number;
  budgetExhausted: boolean;
}

const CSP_HINTS = ["connect-src", "refused to connect", "content security policy"];

/** Classify one fetched resource against the per-resource + total budget,
 *  mutating the running totals. Returns the (possibly budget-rejected) entry. */
function classifyFetched(f: Fetched, maxBytes: number, phase: FetchPhase): Fetched {
  if (!f.r.ok) {
    const err = (f.r.error ?? "").toLowerCase();
    if (CSP_HINTS.some((h) => err.includes(h))) phase.cspBlocked++;
    return f;
  }
  const bytes = f.r.bytes ?? 0;
  if (bytes > PER_RESOURCE_HARD_MB * 1024 * 1024) {
    phase.perResourceOversize++;
    return {
      res: f.res,
      r: { ok: false, error: `resource exceeded per-resource cap (${PER_RESOURCE_HARD_MB} MB)` },
    };
  }
  if (phase.runningBytes + bytes > maxBytes) {
    phase.budgetExhausted = true;
    return { res: f.res, r: { ok: false, error: "size budget exhausted" } };
  }
  phase.runningBytes += bytes;
  return f;
}

/** Fetch the discovered resources in bounded concurrency batches, applying the
 *  per-resource + total size budgets. Stops early once the budget is exhausted
 *  (the remaining resources are recorded as dropped). */
async function fetchElementResources(
  page: ElementExportPage,
  resources: DiscoveredResource[],
  maxBytes: number,
): Promise<FetchPhase> {
  const CONCURRENCY = 6;
  const phase: FetchPhase = {
    fetched: [],
    cspBlocked: 0,
    perResourceOversize: 0,
    runningBytes: 0,
    budgetExhausted: false,
  };
  for (let i = 0; i < resources.length; i += CONCURRENCY) {
    const settled = await Promise.all(
      resources.slice(i, i + CONCURRENCY).map(async (res): Promise<Fetched> => {
        try {
          return { res, r: (await page.evaluate(buildFetchScript(res.url))) as FetchedResource };
        } catch (e) {
          return { res, r: { ok: false, error: e instanceof Error ? e.message : String(e) } };
        }
      }),
    );
    for (const f of settled) phase.fetched.push(classifyFetched(f, maxBytes, phase));
    if (phase.budgetExhausted) {
      for (let j = i + CONCURRENCY; j < resources.length; j++) {
        phase.fetched.push({
          res: resources[j]!,
          r: { ok: false, error: "size budget exhausted" },
        });
      }
      break;
    }
  }
  return phase;
}

/** Push the post-fetch budget/CSP warnings onto the result warnings. */
function appendFetchWarnings(phase: FetchPhase, maxSizeMb: number, warnings: string[]): void {
  if (phase.cspBlocked > 0) {
    warnings.push(
      `${phase.cspBlocked} resource(s) blocked by the page's Content-Security-Policy ` +
        "(typically `connect-src`). Counted in droppedCount.",
    );
  }
  if (phase.perResourceOversize > 0) {
    warnings.push(
      `${phase.perResourceOversize} resource(s) exceeded the per-resource ${PER_RESOURCE_HARD_MB} MB cap and were dropped.`,
    );
  }
  if (phase.budgetExhausted) {
    warnings.push(
      `Export size cap (maxSizeMb=${maxSizeMb}) reached — remaining resources were dropped. ` +
        "Raise `maxSizeMb` to capture more.",
    );
  }
}

interface EmitResult {
  resourceCount: number;
  droppedCount: number;
  sizeBytes: number;
}

/** Emit the multi-file directory export — each fetched asset written under
 *  `assets/<kind>/`, the HTML rewritten to point at the relative paths. */
function emitDirectory(
  resolved: string,
  discovered: SubtreeDiscovery,
  fetched: Fetched[],
  runningBytes: number,
): EmitResult {
  // workspace-rooted (resolveWorkspacePath rejects any escape from BROWX_WORKSPACE).
  mkdirSync(resolved, { recursive: true });
  const assetsRoot = join(resolved, "assets");
  mkdirSync(assetsRoot, { recursive: true });
  let resourceCount = 0;
  let droppedCount = 0;
  const replacements: Array<{ rawRef: string; replacement: string }> = [];
  for (const f of fetched) {
    if (!f.r.ok || !f.r.base64) {
      droppedCount++;
      continue;
    }
    const subdir = subdirForKind(f.res.kind);
    const dir = join(assetsRoot, subdir);
    mkdirSync(dir, { recursive: true });
    const filename = assetFilename(f.res.url, f.res.kind, f.r.contentType ?? "");
    writeFileSync(join(dir, filename), Buffer.from(f.r.base64, "base64"));
    replacements.push({ rawRef: f.res.rawRef, replacement: `assets/${subdir}/${filename}` });
    resourceCount++;
  }
  const standalone = wrapStandalone(rewriteHtml(discovered.html, replacements), discovered.css, "");
  writeFileSync(join(resolved, "element.html"), standalone, "utf8");
  let sizeBytes: number;
  try {
    sizeBytes = directorySize(resolved);
  } catch {
    sizeBytes = Buffer.byteLength(standalone, "utf8") + runningBytes;
  }
  return { resourceCount, droppedCount, sizeBytes };
}

/** Emit the single-file export — assets inlined as data: URIs in the HTML. */
function emitSingleFile(
  resolved: string,
  discovered: SubtreeDiscovery,
  fetched: Fetched[],
  warnings: string[],
): EmitResult {
  // workspace-rooted: dirname(resolved) is the parent of a BROWX_WORKSPACE-anchored path.
  mkdirSync(dirname(resolved), { recursive: true });
  let resourceCount = 0;
  let droppedCount = 0;
  const replacements: Array<{ rawRef: string; replacement: string }> = [];
  for (const f of fetched) {
    if (!f.r.ok || !f.r.base64) {
      droppedCount++;
      continue;
    }
    const mime = (f.r.contentType ?? "").split(";")[0]!.trim() || mimeFromKind(f.res.kind);
    replacements.push({ rawRef: f.res.rawRef, replacement: `data:${mime};base64,${f.r.base64}` });
    resourceCount++;
  }
  const standalone = wrapStandalone(rewriteHtml(discovered.html, replacements), discovered.css, "");
  writeFileSync(resolved, standalone, "utf8");
  const sizeBytes = statSync(resolved).size;
  if (sizeBytes > SINGLE_FILE_SOFT_WARN_MB * 1024 * 1024) {
    warnings.push(
      `single-file export is ${(sizeBytes / 1024 / 1024).toFixed(1)} MB. ` +
        `Browsers commonly struggle past ~${SINGLE_FILE_SOFT_WARN_MB} MB — use \`format:"directory"\` for large subtrees.`,
    );
  }
  return { resourceCount, droppedCount, sizeBytes };
}

/** Ensure the locator resolves to a real element; throws a clean message
 *  otherwise (count() is fast and avoids a confusing `evaluate` failure). */
async function assertResolves(locator: ElementExportLocator, ref: string): Promise<void> {
  let matchCount: number;
  try {
    matchCount = await locator.count();
  } catch (e) {
    throw new Error(
      `element_export: ref "${ref}" did not resolve — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (matchCount === 0) {
    throw new Error(
      `element_export: ref "${ref}" did not match any element (re-snapshot the page or pass a fresh ref).`,
    );
  }
}

export async function elementExport(
  page: ElementExportPage,
  locator: ElementExportLocator,
  workspaceRoot: string,
  sessionId: string,
  args: ElementExportArgs,
): Promise<ElementExportResult> {
  const format: ElementExportFormat = args.format ?? "directory";
  const maxSizeMb = args.maxSizeMb ?? DEFAULT_MAX_SIZE_MB;
  if (!(maxSizeMb > 0) || maxSizeMb > 10_000) {
    throw new Error(`element_export: maxSizeMb must be in (0, 10000] — got ${maxSizeMb}.`);
  }
  const maxBytes = Math.floor(maxSizeMb * 1024 * 1024);
  const relPath = args.intoDir ?? defaultElementExportPath(sessionId, args.ref, format);
  const resolved = resolveWorkspacePath(workspaceRoot, relPath, "element_export");

  await assertResolves(locator, args.ref);

  // 1. Subtree discovery — outerHTML + page-wide CSS + linked resources.
  const discovered = await locator.evaluate<SubtreeDiscovery>(SUBTREE_DISCOVERY_FN);
  const warnings: string[] = [
    "element_export output is UNMASKED — secrets-masking would corrupt the export (literal-substring substitution breaks inline JSON / CSS / binary bytes). Treat the export as sensitive material, same posture as page_archive / dump_storage_state.",
  ];
  if (discovered.unreadableStylesheets > 0) {
    warnings.push(
      `${discovered.unreadableStylesheets} stylesheet(s) were cross-origin without CORS and could not be read into the export. ` +
        "Rules from those sheets that targeted the subtree won't appear in the captured CSS — the snippet may render differently than the source page.",
    );
  }

  // 2. Fetch resources in bounded batches.
  const phase = await fetchElementResources(page, discovered.resources, maxBytes);
  appendFetchWarnings(phase, maxSizeMb, warnings);

  // 3. Emit the export.
  const emit =
    format === "directory"
      ? emitDirectory(resolved, discovered, phase.fetched, phase.runningBytes)
      : emitSingleFile(resolved, discovered, phase.fetched, warnings);

  return {
    ok: true,
    format,
    ref: args.ref,
    path: resolvePath(resolved),
    sizeBytes: emit.sizeBytes,
    resourceCount: emit.resourceCount,
    droppedCount: emit.droppedCount,
    warnings,
  };
}

/**
 * Server-facing helper: resolve a ref through the registry, then call
 * `elementExport`. Lives here so the server.ts call site is a one-liner.
 */
export async function elementExportFromRef(
  page: Page,
  refs: RefRegistry,
  workspaceRoot: string,
  sessionId: string,
  args: ElementExportArgs,
): Promise<ElementExportResult> {
  const locator: Locator = locatorFor(page, refs, { ref: args.ref });
  const adapter: ElementExportLocator = {
    count: () => locator.count(),
    evaluate: <T>(fn: (element: Element) => T | Promise<T>): Promise<T> => locator.evaluate(fn),
  };
  const pageAdapter: ElementExportPage = { evaluate: (expr) => page.evaluate(expr) };
  return elementExport(pageAdapter, adapter, workspaceRoot, sessionId, args);
}
