/// <reference lib="dom" />
// `drop_files` — synthesize an HTML5 drag-drop of one or more files onto a
// page element.
//
// Modern uploaders are no longer `<input type=file>` — they're drop zones
// listening for `dragenter` / `dragover` / `drop` with a populated
// `DataTransfer.files`. Playwright's `setInputFiles` only drives the
// `<input>` shape, so today's only path to drive a drop-zone uploader is
// `eval_js` with hand-rolled DataTransfer plumbing. This tool is the
// first-class alternative.
//
// Two file sources, same posture as `upload_file`:
//   - `contents`  — base64 inline; no filesystem read at all.
//   - `path`      — resolved **inside `$BROWX_WORKSPACE` only**; a path
//                   escaping the workspace is rejected.
//
// In-page construction approach: we route bytes to the page through a
// single `page.evaluate(fn, payload)` call at drop time. The page-side
// function (defined inline so it closes-over nothing) builds `File`
// objects from base64 payloads, populates a `DataTransfer`, then
// dispatches `dragenter` → `dragover` → `drop` on the target element. We
// deliberately do NOT use `addInitScript` to install a helper: each drop
// is one-shot, the data shape varies per call, and a boot-time injection
// would leak page-side identifiers.
//
// Why base64 over the Node→page boundary and not `Uint8Array`: Playwright's
// `evaluate` round-trips a `Uint8Array` arg as a per-byte object array
// (~10× the wire footprint of base64), and we'd still need to materialise
// it as a Uint8Array in-page anyway — `atob` once on the page side is
// cheaper than the structured-clone explosion.

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Page } from "playwright-core";
import type { RefRegistry } from "./refs.js";
import { resolveTarget, type ActionTarget } from "./locator.js";

export interface DropFileInputPath {
  /** Workspace-rooted file path. Mutually exclusive with `contents`. */
  path: string;
  /** Filename presented to the page. Defaults to the basename of `path`. */
  name?: string;
  /** MIME type. Defaults to "application/octet-stream". */
  mimeType?: string;
}
export interface DropFileInputContents {
  /** base64 file content. Mutually exclusive with `path`. */
  contents: string;
  /** Filename presented to the page. Required in `contents`-mode. */
  name: string;
  /** MIME type. Defaults to "application/octet-stream". */
  mimeType?: string;
}
export type DropFileInput = DropFileInputPath | DropFileInputContents;

export interface DropFilesArgs {
  target: ActionTarget;
  files: DropFileInput[];
}

export interface DropFilesResult {
  ok: boolean;
  /** Resolved target description for debugging. */
  target: string;
  /** One entry per file with the resolved mode + bytes that were dropped. */
  files: Array<{ name: string; mode: "path" | "contents"; bytes: number; mimeType: string }>;
  /** Total bytes dispatched. */
  totalBytes: number;
  /** Number of files dropped. */
  fileCount: number;
  /** Which DOM events the page-side script actually fired. */
  eventsFired: string[];
  /** True when the `drop` event was dispatched (regardless of whether the
   *  page handler called preventDefault — we report the dispatch, not the
   *  app-side acceptance, since drop-zone apps vary wildly in how they
   *  signal "I took it"). */
  dropDispatched: boolean;
}

function targetSummary(t: ActionTarget): string {
  if (t.ref) return `ref ${t.ref}`;
  if (t.selector) return `selector ${t.selector}`;
  if (t.coords) return `coords ${t.coords.x},${t.coords.y}`;
  return "(unknown)";
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

interface PreparedFile {
  /** Base64 payload — see header comment for why base64 over the boundary. */
  base64: string;
  name: string;
  mimeType: string;
  bytes: number;
  mode: "path" | "contents";
}

/** Prepare a path-mode file: workspace-escape guarded, read off disk, base64'd. */
function preparePathFile(workspaceRoot: string, f: DropFileInputPath, i: number): PreparedFile {
  const fp = f.path;
  const resolved = resolve(workspaceRoot, fp);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + sep)) {
    throw new Error(
      `drop_files: files[${i}].path must resolve inside $BROWX_WORKSPACE — stage the file there, or use \`contents\` (base64)`,
    );
  }
  let buf: Buffer;
  try {
    buf = readFileSync(resolved);
  } catch (err) {
    throw new Error(`drop_files: files[${i}].path: ${(err as Error).message}`);
  }
  return {
    base64: buf.toString("base64"),
    name: f.name ?? basename(fp),
    mimeType: f.mimeType ?? "application/octet-stream",
    bytes: buf.length,
    mode: "path",
  };
}

/** Prepare a contents-mode file (base64 inline; `name` required). */
function prepareContentsFile(f: DropFileInputContents, i: number): PreparedFile {
  if (!f.name || f.name.length === 0) {
    throw new Error(`drop_files: files[${i}]: \`name\` is required in contents-mode`);
  }
  return {
    base64: f.contents,
    name: f.name,
    mimeType: f.mimeType ?? "application/octet-stream",
    bytes: Buffer.from(f.contents, "base64").length,
    mode: "contents",
  };
}

function prepareFiles(workspaceRoot: string, files: DropFileInput[]): PreparedFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("drop_files: `files` must be a non-empty array");
  }
  return files.map((f, i) => {
    const hasPath =
      typeof (f as DropFileInputPath).path === "string" && (f as DropFileInputPath).path.length > 0;
    const hasContents = typeof (f as DropFileInputContents).contents === "string";
    if (hasPath && hasContents) {
      throw new Error(`drop_files: files[${i}]: pass exactly one of \`path\` or \`contents\``);
    }
    if (!hasPath && !hasContents) {
      throw new Error(`drop_files: files[${i}]: requires \`path\` or \`contents\``);
    }
    return hasPath
      ? preparePathFile(workspaceRoot, f as DropFileInputPath, i)
      : prepareContentsFile(f as DropFileInputContents, i);
  });
}

export interface DropPayload {
  files: Array<{ base64: string; name: string; mimeType: string }>;
  /** Viewport-relative coords for the dispatched events. We compute these
   *  on the Node side (bounding-box centre for ref/selector; literal for
   *  coords). The page-side script writes them onto every event so apps
   *  that read `event.clientX`/`clientY` see consistent values. */
  clientX: number;
  clientY: number;
  /** When the target was a coords target we have no Locator handle, so the
   *  page-side script does `document.elementFromPoint(clientX, clientY)`
   *  to find the drop target. For ref/selector targets we pass the
   *  pre-resolved element via the Locator's evaluate-handle. */
  byCoords: boolean;
}

export interface DropEvalResult {
  eventsFired: string[];
  dropDispatched: boolean;
  /** Tag of the element we landed on — surfaced for debugging. */
  hitTag?: string;
  /** Any error from the in-page side. */
  error?: string;
}

/**
 * The actual page-side synthesis. Defined as a plain function (no closure
 * over module scope, no imports) so Playwright's serialiser ships it
 * across the CDP boundary cleanly. `el` is the resolved DOM element for
 * ref/selector mode, or `null` for coords mode (in which case we re-
 * resolve via `elementFromPoint(clientX, clientY)`).
 *
 * Exported for unit-test use only (so a jsdom-style fake DOM can drive
 * it directly without going through Playwright). Not part of the public
 * MCP surface.
 */

/** The subset of `Element` the page-side drop synthesis actually touches. A
 *  real DOM `Element` satisfies this, and the unit-test fake supplies the
 *  same two members, so we narrow the opaque `el` handle to this shape rather
 *  than asserting a full `Element`. */
interface DropTarget {
  dispatchEvent(ev: Event): boolean;
  readonly tagName?: string;
}

export const dropFilesPageScript = function PAGE_DROP_FILES_FN(args: {
  // `el` is the DOM element resolved by Locator.evaluate on the browser side
  // (ref/selector mode), or `null` for coords mode (re-resolved in-page via
  // elementFromPoint). It crosses the Node->page boundary as an opaque handle
  // (and unit tests pass a structural fake), so it arrives as `unknown` and is
  // narrowed to the `DropTarget` shape via the runtime guard below.
  el: unknown;
  payload: DropPayload;
}): DropEvalResult {
  // The script runs in the page (or a worker / jsdom shim in tests), so the
  // host environment may expose globals on `window` or directly on
  // `globalThis`. We model that surface precisely rather than reaching
  // through `any`: every member is the real DOM type, just possibly absent in
  // a stripped-down shim, hence each is optional.
  interface HostGlobals {
    window?: Window & typeof globalThis;
    document?: Document;
    atob?: (data: string) => string;
    Uint8Array?: Uint8ArrayConstructor;
    File?: typeof File;
    DataTransfer?: typeof DataTransfer;
    DragEvent?: typeof DragEvent;
    Event?: typeof Event;
  }
  const g: HostGlobals = globalThis;
  const W: HostGlobals = g.window ?? g;
  const D: Document | undefined = g.document ?? W.document;
  if (!W || !D) return { eventsFired: [], dropDispatched: false, error: "no window/document" };

  // 1. Resolve the target element. For ref/selector mode the caller passed
  //    `el` directly via Locator.evaluate; for coords mode `el` is null
  //    and we look it up via elementFromPoint. The narrowing is inlined (NOT a
  //    module-level helper): this function is serialized to the page by
  //    Locator.evaluate, so any sibling-scope reference is a ReferenceError in
  //    the page realm.
  const elCandidate = args.el as DropTarget | null;
  let target: DropTarget | null =
    typeof elCandidate === "object" &&
    elCandidate !== null &&
    typeof elCandidate.dispatchEvent === "function"
      ? elCandidate
      : null;
  if (args.payload.byCoords || !target) {
    target = D.elementFromPoint(args.payload.clientX, args.payload.clientY);
  }
  if (!target)
    return {
      eventsFired: [],
      dropDispatched: false,
      error: "no target element at the requested point",
    };
  // Bind a non-null alias so the closure below sees a narrowed element type.
  const targetEl: DropTarget = target;

  // 2. Materialise File objects from base64 payloads. `atob` is universal,
  //    Uint8Array → File is the canonical drop-zone construction.
  const fileObjs: File[] = [];

  const rawAtob: ((data: string) => string) | undefined = W.atob ?? g.atob;
  // `atob` is a universal global (browser + Node); the captured lookups above
  // only matter for unusual page contexts. Bind to `W` when present, else fall
  // back to the ambient global — the same function the original `g.atob` path
  // resolved to (never a silent identity map).
  const atobFn: (s: string) => string = rawAtob ? rawAtob.bind(W) : atob;
  const U8: Uint8ArrayConstructor = W.Uint8Array ?? g.Uint8Array ?? Uint8Array;
  const FileCtor: typeof File | undefined = W.File ?? g.File;
  for (let i = 0; i < args.payload.files.length; i++) {
    const f = args.payload.files[i]!;
    const bin = atobFn(f.base64);
    const len = bin.length;
    const u8 = new U8(len);
    for (let j = 0; j < len; j++) u8[j] = bin.charCodeAt(j) & 0xff;
    if (FileCtor) fileObjs.push(new FileCtor([u8], f.name, { type: f.mimeType }));
  }

  // 3. Build the DataTransfer. `new DataTransfer()` is the public API
  //    listeners read `event.dataTransfer.files` from. `items.add(file)`
  //    implicitly registers the "Files" type, which apps gate on (React-
  //    DnD's NativeTypes.FILE, e.g.).
  const DTCtor: typeof DataTransfer | undefined = W.DataTransfer ?? g.DataTransfer;
  // A jsdom/older-shim DataTransfer may not implement `items.add`, so model
  // the members we actually touch as optional on top of the spec shape.
  type LooseDataTransfer = DataTransfer & {
    items?: { add?: (file: File) => unknown };
  };
  const dt: LooseDataTransfer | undefined = DTCtor ? new DTCtor() : undefined;
  if (dt) {
    for (const file of fileObjs) {
      if (dt.items && typeof dt.items.add === "function") {
        dt.items.add(file);
      } else {
        // Older shims expose `files` as a settable FileList-like. Fall back
        // by reassigning via Object.defineProperty so the value is enumerable
        // and `length`/index access both work — best-effort for ancient
        // browsers; modern Chromium hits the `items.add` path above.
        try {
          const arr: File[] = Array.from(dt.files);
          arr.push(file);
          const fakeList: File[] & { item?: (idx: number) => File | null } = arr;
          fakeList.item = (idx: number): File | null => arr[idx] ?? null;
          Object.defineProperty(dt, "files", { value: fakeList, configurable: true });
        } catch {
          /* swallow — items.add path covers Chromium */
        }
      }
    }
  }

  const eventsFired: string[] = [];
  const DragEv: typeof DragEvent | undefined = W.DragEvent ?? g.DragEvent;
  const Ev: typeof Event = W.Event ?? g.Event ?? Event;
  // The constructed event may be a DragEvent or a plain Event with
  // `dataTransfer` / `clientX` / `clientY` patched on through descriptors.
  type SynthEvent = Event & {
    dataTransfer?: DataTransfer | null;
    clientX?: number;
    clientY?: number;
  };
  const fireOne = (kind: "dragenter" | "dragover" | "drop"): void => {
    // DragEvent is preferred (carries `dataTransfer` natively); some
    // older browsers (jsdom in tests) don't expose it as a constructor.
    // Fall back to a regular Event with dataTransfer assigned through a
    // property descriptor — every real Chromium hits the DragEvent path.
    let ev: SynthEvent;
    try {
      if (!DragEv) throw new Error("no DragEvent");
      ev = new DragEv(kind, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: args.payload.clientX,
        clientY: args.payload.clientY,
        dataTransfer: dt,
      });
    } catch {
      const base: SynthEvent = new Ev(kind, { bubbles: true, cancelable: true, composed: true });
      ev = base;
      try {
        Object.defineProperty(base, "dataTransfer", { value: dt, configurable: true });
      } catch {
        /* best-effort */
      }
      base.clientX = args.payload.clientX;
      base.clientY = args.payload.clientY;
    }
    // Modern Chromium DragEvent may have a read-only dataTransfer that
    // ignores the constructor option. Defensive: if it didn't take, force
    // it via descriptor.
    try {
      if (ev.dataTransfer !== dt) {
        Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
      }
    } catch {
      /* best-effort */
    }
    targetEl.dispatchEvent(ev);
    eventsFired.push(kind);
  };

  // 4. Dispatch the standard HTML5 drop sequence. `dragenter` → `dragover`
  //    → `drop`. We send `dragover` once; a real human drag would emit it
  //    continuously, but most drop-zone listeners only need one to set
  //    `event.dataTransfer.dropEffect` / call `preventDefault` so the
  //    subsequent `drop` is accepted.
  fireOne("dragenter");
  fireOne("dragover");
  fireOne("drop");

  const tag = target.tagName ? String(target.tagName).toLowerCase() : "?";
  return {
    eventsFired,
    dropDispatched: eventsFired.indexOf("drop") >= 0,
    hitTag: tag,
  };
};

/** Resolve the viewport-relative drop point: coords mode uses the literal point;
 *  element mode uses the target's bounding-box centre (throwing when unrendered). */
async function computeDropPoint(
  resolved: ReturnType<typeof resolveTarget>,
): Promise<{ clientX: number; clientY: number; byCoords: boolean }> {
  if (resolved.kind === "coords") {
    return { clientX: resolved.x, clientY: resolved.y, byCoords: true };
  }
  const box = await resolved.loc.boundingBox().catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) {
    throw new Error(
      "drop_files: target element has no rendered box — scroll into view or wait for it to mount",
    );
  }
  return { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, byCoords: false };
}

export async function dropFiles(
  page: Page,
  refs: RefRegistry,
  workspaceRoot: string,
  args: DropFilesArgs,
): Promise<DropFilesResult> {
  if (!args || !args.target) {
    throw new Error("drop_files: requires `target` (ref/selector/named/coords)");
  }
  const prepared = prepareFiles(workspaceRoot, args.files);

  // Compute the viewport-relative click point on the Node side so apps reading
  // `event.clientX`/`clientY` see realistic values.
  const resolved = resolveTarget(page, refs, args.target);
  const { clientX, clientY, byCoords } = await computeDropPoint(resolved);

  const payload: DropPayload = {
    clientX,
    clientY,
    byCoords,
    files: prepared.map((p) => ({ base64: p.base64, name: p.name, mimeType: p.mimeType })),
  };

  // Inline the page-side script as a string so the closure-over-
  // `dropFilesPageScript` survives the CDP boundary. Playwright's
  // `evaluate(fn, arg)` accepts the function source as a string, parses
  // it in the page, and invokes it with the cloned argument bag — exactly
  // what we want, no addInitScript indirection required.
  const scriptSource = dropFilesPageScript.toString();

  // Dispatch. For ref/selector targets we route through the Locator so
  // the page-side script receives the element directly as `el`. For coords
  // we run on `page` and the script re-resolves via `elementFromPoint`.
  const result: DropEvalResult =
    resolved.kind === "coords"
      ? await page.evaluate(
          (a: { payload: DropPayload; src: string }) => {
            // The source string evaluates to the page-side function; type the
            // factory the `Function` constructor returns and the function it
            // yields precisely, so neither call is an unsafe `Function` call.
            type PageScript = (x: { el: Element | null; payload: DropPayload }) => DropEvalResult;
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            const factory = new Function("return (" + a.src + ");") as () => PageScript;
            const fn: PageScript = factory();
            return fn({ el: null, payload: a.payload });
          },
          { payload, src: scriptSource },
        )
      : await resolved.loc.evaluate(
          // Locator.evaluate signature: (element, arg).
          (el: Element, a: { payload: DropPayload; src: string }) => {
            type PageScript = (x: { el: Element | null; payload: DropPayload }) => DropEvalResult;
            // eslint-disable-next-line @typescript-eslint/no-implied-eval
            const factory = new Function("return (" + a.src + ");") as () => PageScript;
            const fn: PageScript = factory();
            return fn({ el, payload: a.payload });
          },
          { payload, src: scriptSource },
        );

  if (result.error) {
    throw new Error(`drop_files: in-page dispatch failed — ${result.error}`);
  }

  const totalBytes = prepared.reduce((acc, p) => acc + p.bytes, 0);
  return {
    ok: true,
    target: targetSummary(args.target),
    files: prepared.map((p) => ({
      name: p.name,
      mode: p.mode,
      bytes: p.bytes,
      mimeType: p.mimeType,
    })),
    totalBytes,
    fileCount: prepared.length,
    eventsFired: result.eventsFired,
    dropDispatched: result.dropDispatched,
  };
}
