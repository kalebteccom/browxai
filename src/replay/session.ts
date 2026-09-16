// Per-session replay orchestrator (RFC 0007). Owns one ReplayLog, one clock,
// one Redactor, one AssetStore and the live capture-source subscriptions.
// Nothing here summarises — every source's shape rides through as the schema
// designed it — and every event that reaches the log has already passed the
// registered-secret chokepoint in `redact.ts`.
//
// The orchestrator is the single place `start_recording` / `end_recording` /
// `record_annotate` reach for. That keeps `sources.ts` a leaf and `log.ts`
// unaware of Playwright.

import { relative } from "node:path";
import { readFile, unlink } from "node:fs/promises";
import type { BrowserContext, CDPSession, ConsoleMessage, Page } from "playwright-core";

import { log } from "../util/logging.js";
import type { SessionEntry } from "../session/registry.js";
import type { Workspace } from "../util/workspace.js";
import { ReplayLog, type ReplayLogStats } from "./log.js";
import { AssetStore, writeArtifact } from "./artifact.js";
import {
  REPLAY_ARTIFACT_EXT,
  REPLAY_SCHEMA_VERSION,
  type CaptureTier,
  type ReplayManifest,
} from "./schema.js";
import { Redactor, redactEvent } from "./redact.js";
import {
  actionCallEvent,
  annotateSpanEvent,
  consoleMessageEvent,
  createClock,
  pageErrorEvent,
  pageLifecycleEvent,
  resultEvent,
  type AnnotateSource,
  type EventClock,
  type SourceContext,
  type ToolOutcome,
} from "./sources.js";
import { attachDomCapture, type DomCaptureHandle } from "./dom-capture.js";
import { attachReplayNetwork } from "./session-network.js";
import { requirePage } from "../engine/index.js";

/** What the tool surface accepts on `start_recording({ replay })`. */
export interface ReplayStartOptions {
  tier?: CaptureTier;
  /** Header/body redaction rules on top of the always-on secret mask. */
  redaction?: {
    headers?: readonly string[];
    bodyPaths?: readonly string[];
  };
  /** Byte ceiling for `events.jsonl` before compression. Truncation is
   *  recorded in `manifest.truncated.reason = "size-cap"`. */
  sizeCap?: number;
  /** Event ceiling. Truncation reason: `"event-cap"`. */
  eventCap?: number;
  /** Extra CSS selectors the DOM stream masks on top of `input[type=password]`. */
  maskSelectors?: readonly string[];
  /** Workspace-relative directory for the artifact + intermediate JSONL.
   *  Defaults to `replays/`. */
  dir?: string;
}

export interface ReplayStartResult {
  ok: true;
  tier: CaptureTier;
  sessionId: string;
  clockOrigin: number;
  /** Workspace-relative path the `.browx` will land at when `end()` runs. */
  path: string;
}

export interface ReplayEndResult {
  ok: true;
  path: string;
  /** Absolute path on disk. */
  absolutePath: string;
  bytes: number;
  events: number;
  counts: Record<string, number>;
  truncated?: ReplayManifest["truncated"];
  entries: number;
}

/** browxai version stamped onto every manifest. Read once at module load so a
 *  test-time override (`process.env.BROWX_VERSION = "..."`) still works. */
function browxaiVersion(): string {
  return process.env.BROWX_VERSION ?? "0.0.0-dev";
}

function defaultPath(sessionId: string, dir: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  return `${dir.replace(/\/$/, "")}/${sessionId}-${iso}${REPLAY_ARTIFACT_EXT}`;
}

interface Subscription {
  detach(): Promise<void> | void;
}

export class ReplaySession {
  private replayLog: ReplayLog | undefined;
  private clock: EventClock | undefined;
  private redactor: Redactor | undefined;
  private ctx: SourceContext | undefined;
  private tier: CaptureTier = "replay";
  private artifactPath = "";
  private jsonlPath = "";
  private domHandle: DomCaptureHandle | undefined;
  private subscriptions: Subscription[] = [];
  private context: BrowserContext | undefined;
  private assets = new AssetStore();
  private viewport: ReplayManifest["viewport"];
  private userAgent: string | undefined;
  private engine = "chromium";
  private closed = false;

  constructor(private readonly entry: SessionEntry) {}

  active(): boolean {
    return this.replayLog !== undefined && !this.closed;
  }

  async start(opts: ReplayStartOptions, workspace: Workspace): Promise<ReplayStartResult> {
    if (this.replayLog) throw new Error("replay: recording already active for this session");
    const tier = opts.tier ?? "replay";
    const dir = opts.dir ?? "replays";
    const artifactRel = defaultPath(this.entry.id, dir);
    const jsonlRel = artifactRel.replace(REPLAY_ARTIFACT_EXT, ".jsonl");
    const clockOrigin = Date.now();
    const clock = createClock(clockOrigin);
    const redactor = new Redactor({
      headers: opts.redaction?.headers,
      bodyPaths: opts.redaction?.bodyPaths,
      secrets: this.entry.secrets,
    });
    const rlog = await ReplayLog.open({
      workspaceRoot: workspace.root,
      path: jsonlRel,
      clockOrigin,
      maxBytes: opts.sizeCap,
      maxEvents: opts.eventCap,
    });

    // Publish orchestrator state ONLY after `attachSources` completes without
    // throwing. Assigning `this.replayLog` up front means an attach failure
    // (a torn-down context, a Network.enable refusal on a CDP session that
    // just closed) leaves the session in a permanent "active" state: `active()`
    // returns true, `start()` refuses "already active", `end()` finds no
    // subscriptions to detach cleanly. Local-first + assign-on-success gives
    // us a clean abort on failure with no leaked fd.
    this.clock = clock;
    this.redactor = redactor;
    this.tier = tier;
    this.artifactPath = artifactRel;
    this.jsonlPath = rlog.path;
    this.ctx = { clock, redact: redactor };
    this.engine = this.entry.session.engine;
    // attachSources reads this.replayLog through the subscribe helpers; we
    // assign it here so the helpers see the live handle, but if attach throws
    // we roll back below.
    this.replayLog = rlog;
    try {
      await this.attachSources(tier, opts.maskSelectors ?? []);
    } catch (err) {
      // Best-effort rollback: detach whatever partially attached, close the
      // log, unlink the JSONL, and reset state so the next `start()` succeeds.
      await this.abort();
      throw err;
    }

    return { ok: true, tier, sessionId: this.entry.id, clockOrigin, path: artifactRel };
  }

  /** Called by the dispatch wrapper for every tool call once a replay is
   *  active. Emits action/call. Cheap when inactive — the ctx check gates. */
  noteCall(tool: string, args: unknown): void {
    if (!this.ctx || !this.replayLog) return;
    const ev = actionCallEvent(this.ctx, { tool, args });
    this.replayLog.append(ev);
  }

  /** Emits action/result or assert/result. `outcome` is the parsed handler
   *  return; `undefined` when the result was not JSON. */
  noteResult(tool: string, outcome: ToolOutcome | undefined): void {
    if (!this.ctx || !this.replayLog) return;
    const ev = resultEvent(this.ctx, tool, outcome ?? { ok: true });
    this.replayLog.append(ev);
  }

  annotate(args: AnnotateSource): void {
    if (!this.ctx || !this.replayLog) return;
    const ev = annotateSpanEvent(this.ctx, args);
    this.replayLog.append(ev);
  }

  /**
   * Teardown path for `close_session` on an ACTIVE recording. Detaches every
   * subscription, closes the log handle, and unlinks the intermediate JSONL —
   * so an abandoned session leaves no plaintext trace and no leaked fd. NOT
   * the same as `end()`: the artifact writer never runs, no `.browx` is
   * emitted, no `lastArtifact()` link is stored. Idempotent: safe to call on a
   * closed or never-started session (returns immediately).
   *
   * A JSONL file that stayed under the flush threshold flushes here so the
   * file descriptor closes cleanly even on a session that produced no
   * events — the alternative was a 0-byte file with a leaked fd on shutdown.
   */
  async abort(): Promise<void> {
    if (!this.replayLog) return;
    this.closed = true;
    for (const sub of this.subscriptions) {
      try {
        await sub.detach();
      } catch {
        /* best-effort — a torn-down page's off() may throw */
      }
    }
    this.subscriptions = [];
    if (this.domHandle) {
      await this.domHandle.detach().catch(() => undefined);
      this.domHandle = undefined;
    }
    const jsonlPath = this.jsonlPath;
    try {
      await this.replayLog.close();
    } catch {
      /* the write side may have already errored */
    }
    if (jsonlPath) await unlink(jsonlPath).catch(() => undefined);
    this.reset();
  }

  async end(workspace: Workspace): Promise<ReplayEndResult> {
    if (!this.replayLog || !this.ctx) throw new Error("replay: no active recording");
    this.closed = true;
    // Detach subscriptions and the DOM stream FIRST so no new events land on
    // the log while we're closing it. In-flight body fetches
    // (`Network.getResponseBody`) may still be pending — the responseReceived
    // handler queued them but hasn't heard back yet — so awaiting them here
    // stops their `rlog.append` from silently no-oping into a closed log.
    for (const sub of this.subscriptions) await sub.detach();
    this.subscriptions = [];
    if (this.domHandle) await this.domHandle.detach();
    this.domHandle = undefined;
    if (this.pendingBodyFetches.size > 0) {
      await Promise.allSettled([...this.pendingBodyFetches]);
      this.pendingBodyFetches.clear();
    }
    const stats = await this.replayLog.close();
    const jsonlPath = this.jsonlPath;
    const artifactPath = this.artifactPath;
    // From here down we're closing state. A throw from readFile or
    // writeArtifact would otherwise wedge the session forever: `active()` would
    // return false while `start()` would still refuse (replayLog set); the
    // plaintext JSONL would sit on disk. `reset()` runs in `finally` so a
    // failed `end()` returns the session to an idle-ready state and the next
    // `start()` succeeds. On success it also unlinks the intermediate JSONL.
    try {
      const events = await readFile(jsonlPath);
      const written = await writeArtifact({
        workspaceRoot: workspace.root,
        path: artifactPath,
        manifest: this.buildManifest(stats),
        events,
        assets: this.assets,
      });
      await unlink(jsonlPath).catch(() => undefined);
      const result: ReplayEndResult = {
        ok: true,
        path: artifactPath,
        absolutePath: written.path,
        bytes: written.bytes,
        events: stats.events,
        counts: stats.counts,
        entries: written.entries,
      };
      if (stats.truncated) result.truncated = stats.truncated;
      this.lastRelativePath = artifactPath;
      this.lastAbsolutePath = written.path;
      return result;
    } catch (err) {
      // The artifact never landed on disk; the plaintext JSONL is still there.
      // Unlink it so a failed `end()` matches the abort-path guarantee of no
      // plaintext trace, then rethrow so the caller sees the failure.
      await unlink(jsonlPath).catch(() => undefined);
      throw err;
    } finally {
      this.reset();
    }
  }

  /** Path pair of the last-written artifact for this session (if any).
   *  `export_session_report` links this. Survives across the end→start cycle
   *  until a new recording completes and overwrites it. */
  lastArtifact(): { path: string; absolutePath: string } | undefined {
    if (!this.lastAbsolutePath || !this.lastRelativePath) return undefined;
    return { path: this.lastRelativePath, absolutePath: this.lastAbsolutePath };
  }
  private lastAbsolutePath: string | undefined;
  private lastRelativePath: string | undefined;

  private reset(): void {
    this.replayLog = undefined;
    this.clock = undefined;
    this.redactor = undefined;
    this.ctx = undefined;
    this.jsonlPath = "";
    this.artifactPath = "";
    this.closed = false;
    this.assets = new AssetStore();
    this.context = undefined;
  }

  private buildManifest(stats: ReplayLogStats): Omit<ReplayManifest, "eventsDigest"> {
    const m: Omit<ReplayManifest, "eventsDigest"> = {
      schemaVersion: REPLAY_SCHEMA_VERSION,
      sessionId: this.entry.id,
      clockOrigin: stats.clockOrigin,
      tier: this.tier,
      browxaiVersion: browxaiVersion(),
      engine: this.engine,
      counts: stats.counts,
    };
    if (this.viewport) m.viewport = this.viewport;
    if (this.userAgent) m.userAgent = this.userAgent;
    if (stats.truncated) m.truncated = stats.truncated;
    return m;
  }

  private async attachSources(tier: CaptureTier, maskSelectors: readonly string[]): Promise<void> {
    let page: Page;
    try {
      page = requirePage(this.entry.session);
    } catch {
      // Engines without a Playwright page (Safari) do not carry a DOM stream,
      // network tap, or console binding this orchestrator can subscribe to.
      // Recording still runs (action/annotate flow through), just narrower.
      return;
    }
    this.context = page.context();
    try {
      const size = page.viewportSize();
      if (size) this.viewport = { width: size.width, height: size.height };
    } catch {
      /* pre-navigation pages have no viewport */
    }
    this.subscribePage(page);
    this.subscribeContext(this.context);
    if (tier !== "actions") {
      await this.attachDom(this.context, maskSelectors);
      const cdp = this.entry.session.cdp?.();
      if (cdp) await this.attachNetwork(cdp);
    }
  }

  private subscribePage(page: Page): void {
    const ctx = this.ctx;
    const rlog = this.replayLog;
    if (!ctx || !rlog) return;
    const onConsole = (m: ConsoleMessage): void => {
      rlog.append(consoleMessageEvent(ctx, { type: m.type(), text: m.text() }));
    };
    const onError = (err: Error): void => {
      rlog.append(pageErrorEvent(ctx, { text: err.message, stack: err.stack }));
    };
    const onFrame = (frame: import("playwright-core").Frame): void => {
      if (frame !== page.mainFrame()) return;
      rlog.append(
        pageLifecycleEvent(ctx, { name: "framenavigated", url: frame.url(), isMainFrame: true }),
      );
    };
    page.on("console", onConsole);
    page.on("pageerror", onError);
    page.on("framenavigated", onFrame);
    this.subscriptions.push({
      detach: () => {
        page.off("console", onConsole);
        page.off("pageerror", onError);
        page.off("framenavigated", onFrame);
      },
    });
  }

  private subscribeContext(ctx: BrowserContext): void {
    const src = this.ctx;
    const rlog = this.replayLog;
    if (!src || !rlog) return;
    const onPage = (p: Page): void => {
      rlog.append(pageLifecycleEvent(src, { name: "page-opened", url: p.url() }));
    };
    ctx.on("page", onPage);
    this.subscriptions.push({
      detach: (): void => {
        ctx.off("page", onPage);
      },
    });
  }

  private async attachDom(ctx: BrowserContext, maskSelectors: readonly string[]): Promise<void> {
    const rlog = this.replayLog;
    const src = this.ctx;
    const redactor = this.redactor;
    if (!rlog || !src || !redactor) return;
    try {
      this.domHandle = await attachDomCapture(ctx, {
        clockOrigin: src.clock.origin,
        maskSelectors: [...maskSelectors],
        onEvent: (ev) => {
          // The DOM stream is a deep tree — rrweb serialises the page as
          // `{childNodes:[{childNodes:[...]}]}`, so masking has to reach the
          // leaf of every subtree. `redactEvent` runs the ONE chokepoint
          // (`SecretRegistry.applyMaskDeep`) every source adapter uses;
          // `applyMaskDeep` walks an explicit heap stack with a WeakMap
          // cycle-guard, so a deep or cyclic input masks correctly without a
          // depth cap and without a call-stack ceiling.
          rlog.append(redactEvent(ev, redactor));
        },
      });
    } catch (err) {
      log.warn("replay.session: DOM capture attach failed; DOM stream will be empty", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** In-flight `Network.getResponseBody` promises the `end()` path awaits so a
   *  body fetch still in progress cannot resolve into a closed log (an unawaited
   *  `.then(rlog.append)` would silently drop it). Populated by the network
   *  tap helper; cleared on `end()` after `Promise.allSettled`. */
  private pendingBodyFetches: Set<Promise<void>> = new Set();

  private async attachNetwork(cdp: CDPSession): Promise<void> {
    const src = this.ctx;
    const rlog = this.replayLog;
    if (!src || !rlog) return;
    const tap = await attachReplayNetwork(cdp, src, rlog, this.tier);
    if (!tap) return;
    this.pendingBodyFetches = tap.pendingBodyFetches;
    this.subscriptions.push({ detach: tap.detach });
  }
}

/** Workspace-relative path for a resolved absolute artifact path. Used by
 *  `export_session_report` to keep the linked artifact path portable. */
export function workspaceRelative(workspace: Workspace, absPath: string): string {
  const rel = relative(workspace.root, absPath);
  return rel.startsWith("..") ? absPath : rel;
}
