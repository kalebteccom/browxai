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
import { Redactor } from "./redact.js";
import {
  actionCallEvent,
  annotateSpanEvent,
  consoleMessageEvent,
  createClock,
  netFailedEvent,
  netRequestEvent,
  netResponseEvent,
  pageErrorEvent,
  pageLifecycleEvent,
  resultEvent,
  wsCloseEvent,
  wsFrameEvent,
  wsOpenEvent,
  type AnnotateSource,
  type EventClock,
  type SourceContext,
  type ToolOutcome,
} from "./sources.js";
import { attachDomCapture, type DomCaptureHandle } from "./dom-capture.js";

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

    this.replayLog = rlog;
    this.clock = clock;
    this.redactor = redactor;
    this.tier = tier;
    this.artifactPath = artifactRel;
    this.jsonlPath = rlog.path;
    this.ctx = { clock, redact: redactor };
    this.engine = this.entry.session.engine;

    await this.attachSources(tier, opts.maskSelectors ?? []);

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

  async end(workspace: Workspace): Promise<ReplayEndResult> {
    if (!this.replayLog || !this.ctx) throw new Error("replay: no active recording");
    this.closed = true;
    for (const sub of this.subscriptions) await sub.detach();
    this.subscriptions = [];
    if (this.domHandle) await this.domHandle.detach();
    this.domHandle = undefined;
    const stats = await this.replayLog.close();
    const events = await readFile(this.jsonlPath);
    const written = await writeArtifact({
      workspaceRoot: workspace.root,
      path: this.artifactPath,
      manifest: this.buildManifest(stats),
      events,
      assets: this.assets,
    });
    await unlink(this.jsonlPath).catch(() => undefined);
    const result: ReplayEndResult = {
      ok: true,
      path: this.artifactPath,
      absolutePath: written.path,
      bytes: written.bytes,
      events: stats.events,
      counts: stats.counts,
      entries: written.entries,
    };
    if (stats.truncated) result.truncated = stats.truncated;
    this.lastRelativePath = this.artifactPath;
    this.lastAbsolutePath = written.path;
    this.reset();
    return result;
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
      page = this.entry.session.page();
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
    if (!rlog || !src) return;
    try {
      this.domHandle = await attachDomCapture(ctx, {
        clockOrigin: src.clock.origin,
        maskSelectors: [...maskSelectors],
        secrets: this.entry.secrets,
        onEvent: (ev) => {
          // The DOM stream envelope was already assembled by dom-capture with
          // the schema fields; forward as-is. `applyMaskDeep` on payload has
          // already run inside dom-capture — do not double-mask (the alias
          // would land twice for no gain).
          rlog.append(ev);
        },
      });
    } catch (err) {
      log.warn("replay.session: DOM capture attach failed; DOM stream will be empty", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async attachNetwork(cdp: CDPSession): Promise<void> {
    const src = this.ctx;
    const rlog = this.replayLog;
    if (!src || !rlog) return;
    const tier = this.tier;
    try {
      await cdp.send("Network.enable");
    } catch (err) {
      log.warn("replay.session: Network.enable failed; network stream will be empty", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // Playwright's CDP payload types decline to admit the `Extras` index
    // signature the schema source types carry. The wire shape is what
    // schema.ts is a structural superset of, so we cast at the CDP boundary
    // and let the source adapter (which is loose on purpose) forward it.
    type Req = import("./sources.js").CdpRequestWillBeSent;
    type Res = import("./sources.js").CdpResponseReceived;
    type Fail = import("./sources.js").CdpLoadingFailed;
    const onRequest = (payload: unknown): void => {
      rlog.append(netRequestEvent(src, payload as Req));
    };
    const onResponse = (payload: unknown): void => {
      const e = payload as Res;
      if (tier !== "reexecutable") {
        rlog.append(netResponseEvent(src, e));
        return;
      }
      // Body fetch is best-effort — a body already discarded by the renderer
      // returns an error the source adapter's `body?` optional papers over.
      void fetchBody(cdp, e.requestId)
        .catch(() => undefined)
        .then((body) => {
          const opts = body === undefined ? {} : { body };
          rlog.append(netResponseEvent(src, e, opts));
        });
    };
    const onFailed = (payload: unknown): void => {
      rlog.append(netFailedEvent(src, payload as Fail));
    };
    cdp.on("Network.requestWillBeSent", onRequest);
    cdp.on("Network.responseReceived", onResponse);
    cdp.on("Network.loadingFailed", onFailed);
    const wsDetach = this.attachWs(cdp);
    this.subscriptions.push({
      detach: (): void => {
        cdp.off("Network.requestWillBeSent", onRequest);
        cdp.off("Network.responseReceived", onResponse);
        cdp.off("Network.loadingFailed", onFailed);
        wsDetach();
      },
    });
  }

  /** Mirror the network-ws.ts CDP tap onto the replay log. WsBuffer's own
   *  listeners keep running for `ws_read` / ActionResult; adding a parallel set
   *  here is one CDP event per frame, no cross-module coupling. */
  private attachWs(cdp: CDPSession): () => void {
    const src = this.ctx;
    const rlog = this.replayLog;
    if (!src || !rlog) return () => undefined;
    const urls = new Map<string, string>();
    const onCreated = (payload: unknown): void => {
      const e = payload as { requestId: string; url: string };
      urls.set(e.requestId, e.url);
      rlog.append(wsOpenEvent(src, { requestId: e.requestId, url: e.url }));
    };
    const onFrame =
      (dir: "sent" | "recv") =>
      (payload: unknown): void => {
        const e = payload as {
          requestId: string;
          response: { opcode: number; payloadData: string };
        };
        rlog.append(
          wsFrameEvent(src, {
            url: urls.get(e.requestId) ?? "",
            dir,
            kind: "ws",
            opcode: e.response.opcode,
            payload: e.response.payloadData ?? "",
          }),
        );
      };
    const onSse = (payload: unknown): void => {
      const e = payload as { requestId: string; eventName?: string; data: string };
      rlog.append(
        wsFrameEvent(src, {
          url: urls.get(e.requestId) ?? "",
          dir: "recv",
          kind: "sse",
          ...(e.eventName ? { event: e.eventName } : {}),
          payload: e.data ?? "",
        }),
      );
    };
    const onClosed = (payload: unknown): void => {
      const e = payload as { requestId: string };
      urls.delete(e.requestId);
      rlog.append(wsCloseEvent(src, { requestId: e.requestId }));
    };
    const sent = onFrame("sent");
    const recv = onFrame("recv");
    cdp.on("Network.webSocketCreated", onCreated);
    cdp.on("Network.webSocketFrameSent", sent);
    cdp.on("Network.webSocketFrameReceived", recv);
    cdp.on("Network.eventSourceMessageReceived", onSse);
    cdp.on("Network.webSocketClosed", onClosed);
    return () => {
      cdp.off("Network.webSocketCreated", onCreated);
      cdp.off("Network.webSocketFrameSent", sent);
      cdp.off("Network.webSocketFrameReceived", recv);
      cdp.off("Network.eventSourceMessageReceived", onSse);
      cdp.off("Network.webSocketClosed", onClosed);
    };
  }
}

async function fetchBody(cdp: CDPSession, requestId: string): Promise<string | undefined> {
  const r = (await cdp.send("Network.getResponseBody", { requestId })) as {
    body: string;
    base64Encoded?: boolean;
  };
  if (!r) return undefined;
  return r.base64Encoded ? Buffer.from(r.body, "base64").toString("utf8") : r.body;
}

/** Workspace-relative path for a resolved absolute artifact path. Used by
 *  `export_session_report` to keep the linked artifact path portable. */
export function workspaceRelative(workspace: Workspace, absPath: string): string {
  const rel = relative(workspace.root, absPath);
  return rel.startsWith("..") ? absPath : rel;
}
