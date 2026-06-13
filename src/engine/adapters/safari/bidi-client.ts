// SafariBidiClient — the WebDriver-BiDi WebSocket client beneath the
// SafaridriverHybridAdapter (RFC 0002 P4). This is the ADDITIVE half of the
// hybrid: the live probe (docs/rfcs/references/06-safari-bidi-probe.md) found
// Safari 26.5 opens a real BiDi socket ONLY behind the vendor cap
// `safari:experimentalWebSocketUrl:true`, and that socket serves a PARTIAL but
// real surface — `script` (evaluate/callFunction/getRealms/addPreloadScript),
// `browsingContext` navigation/lifecycle/setViewport/create/activate, and the
// events that fired (`browsingContext.navigation*`/`load`, `log.entryAdded`).
// It does NOT serve input/network/emulation/screenshot/locateNodes/storage — the
// adapter routes those through WebDriver Classic (SafariWebDriverClient) or gates
// them. Because the experimental cap can disappear in any Safari point release,
// this client is STRICTLY OPTIONAL: the adapter runs Classic-only when there is
// no ws:// URL, so nothing here is on the critical path.
//
// Node's global `WebSocket` (v22+) is the transport — no `ws` dependency, exactly
// as the probe used. The factory is injected (`WebSocketFactory`) so the
// request/response correlation + event dispatch unit-test without a real socket.

/** The minimal WebSocket surface this client uses — satisfied by Node 22's global
 *  `WebSocket` and by the test double. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (ev: { data?: string }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** A BiDi event payload (`{type:"event", method, params}`) dispatched to `on()`
 *  handlers — e.g. `log.entryAdded`, `browsingContext.load`. */
export type BidiEventHandler = (params: Record<string, unknown>) => void;

/** A BiDi command error (`{type:"error", error, message}`) surfaced as a
 *  structured throw — never a silent failure. */
export class BidiError extends Error {
  readonly bidiError: string;
  constructor(bidiError: string, message: string) {
    super(`safari-bidi: ${bidiError}: ${message}`);
    this.name = "BidiError";
    this.bidiError = bidiError;
  }
}

interface BidiMessage {
  type?: "success" | "error" | "event";
  id?: number;
  method?: string;
  result?: unknown;
  error?: string;
  message?: string;
  params?: Record<string, unknown>;
}

export class SafariBidiClient {
  private readonly url: string;
  private readonly wsFactory: WebSocketFactory;
  private readonly commandTimeoutMs: number;
  private ws: WebSocketLike | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly handlers = new Map<string, Set<BidiEventHandler>>();

  constructor(opts: { url: string; wsFactory?: WebSocketFactory; commandTimeoutMs?: number }) {
    this.url = opts.url;
    // Node 22's global WebSocket is structurally a WebSocketLike.
    this.wsFactory = opts.wsFactory ?? ((u) => new WebSocket(u));
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 10_000;
  }

  /** Open the socket. Resolves on `open`, rejects on a connect-time `error`. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = this.wsFactory(this.url);
      this.ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (ev) =>
        reject(new Error(`safari-bidi: socket error ${describe(ev)}`)),
      );
      ws.addEventListener("message", (ev) => this.onMessage(ev.data));
    });
  }

  /** Send a BiDi command and await its correlated reply. Rejects with a
   *  `BidiError` on an error reply (e.g. `unknown command` for a module Safari
   *  does not implement) and on timeout. */
  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws) return Promise.reject(new Error("safari-bidi: not connected"));
    const id = this.nextId++;
    const ws = this.ws;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`safari-bidi: command timed out after ${this.commandTimeoutMs}ms: ${method}`),
        );
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Subscribe to BiDi events (`session.subscribe`). The corresponding `on()`
   *  handlers then fire as events arrive. */
  async subscribe(events: string[]): Promise<void> {
    await this.send("session.subscribe", { events });
  }

  /** Register a handler for a BiDi event method (e.g. `log.entryAdded`). */
  on(method: string, handler: BidiEventHandler): void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
  }

  close(): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("safari-bidi: client closed"));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = undefined;
  }

  private onMessage(data: string | undefined): void {
    if (data === undefined) return;
    let msg: BidiMessage;
    try {
      msg = JSON.parse(data) as BidiMessage;
    } catch {
      return;
    }
    if (msg.type === "event" && msg.method) {
      const set = this.handlers.get(msg.method);
      if (set) for (const h of set) h(msg.params ?? {});
      return;
    }
    if (typeof msg.id === "number") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.type === "error") {
        entry.reject(new BidiError(msg.error ?? "unknown error", msg.message ?? ""));
      } else {
        entry.resolve(msg.result);
      }
    }
  }
}

/** Best-effort description of a socket error event for the connect rejection. */
function describe(ev: unknown): string {
  if (ev && typeof ev === "object" && "message" in ev) {
    return String(ev.message);
  }
  return "";
}
