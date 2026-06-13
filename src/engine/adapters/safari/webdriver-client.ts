// SafariWebDriverClient — the WebDriver-Classic HTTP client beneath the
// SafaridriverHybridAdapter (RFC 0002 P4). Classic is the COMPLETE workhorse for
// real Safari: the live probe (docs/rfcs/references/06-safari-bidi-probe.md)
// confirmed navigate / screenshot / findElement / element click+value+text /
// cookies / executeScript all work on the shipping safaridriver, whereas the
// experimental BiDi layer (SafariBidiClient) is the additive bidirectional half
// (console + nav events) and is gated behind a vendor cap. So the adapter leans
// on THIS client for the element/screenshot/cookie/exec surface and treats BiDi
// as strictly optional.
//
// This is pure `fetch` over loopback (safaridriver's REST endpoints), with the
// HTTP transport injected (`FetchLike`) so the orchestration unit-tests without a
// real driver — the same IO-seam discipline as adb.ts (AdbRunner/Fetcher). It
// implements ONLY the endpoints the adapter + the Safari snapshot/action seams
// actually call (interface segregation), not the whole WebDriver surface.

/** The subset of the global `fetch` signature this client uses. Injected so the
 *  unit tests pass a mock and the orchestration is exercised driver-free. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The W3C element-reference key — the property name a WebDriver server uses to
 *  carry an element handle in JSON. safaridriver returns this key (and also the
 *  legacy `ELEMENT`); we read either. */
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/** A WebDriver cookie (the fields the cookie tools round-trip). */
export interface WebDriverCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expiry?: number;
  sameSite?: "Lax" | "Strict" | "None";
}

/** The granted-capabilities shape this client cares about — `webSocketUrl` is a
 *  real `ws://` string ONLY when the session was created with
 *  `safari:experimentalWebSocketUrl:true` (otherwise it is a boolean placeholder
 *  and no BiDi socket exists — see reference 06). */
export interface NewSessionResult {
  sessionId: string;
  capabilities: Record<string, unknown>;
  /** The BiDi WebSocket URL, present only when the experimental cap negotiated a
   *  real socket. A boolean or undefined means "no BiDi" — run Classic-only. */
  webSocketUrl: string | undefined;
}

/** A WebDriver protocol error surfaced as a structured throw (never a vague
 *  mid-call failure — the doctrine's no-silent-failure rule). `error` is the W3C
 *  error code (e.g. `session not created`, `no such element`). */
export class WebDriverError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  constructor(code: string, message: string, httpStatus: number) {
    super(`safari-webdriver: ${code}: ${message}`);
    this.name = "WebDriverError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Whether a request body is an experimental-cap BiDi request (for the
 *  capability negotiation the adapter does at session create). */
export interface SessionCapabilities {
  /** Request a BiDi socket. Pairs with `experimentalWebSocketUrl` on Safari. */
  webSocketUrl?: boolean;
  /** Safari vendor cap — REQUIRED to actually open a BiDi socket on Safari 26.5
   *  (plain `webSocketUrl:true` returns a boolean placeholder). */
  experimentalWebSocketUrl?: boolean;
}

export class SafariWebDriverClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: { baseUrl: string; fetchImpl?: FetchLike }) {
    // Trim a trailing slash so path joins are unambiguous.
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    // globalThis.fetch is structurally assignable to FetchLike (a looser shape).
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** `GET /status` — readiness probe (used by the launch poll). Never throws on a
   *  protocol error; returns `{ready:false}` so the poll can retry. */
  async status(): Promise<{ ready: boolean; message: string }> {
    try {
      const value = (await this.send("GET", "/status")) as { ready?: boolean; message?: string };
      return { ready: value?.ready ?? false, message: value?.message ?? "" };
    } catch {
      return { ready: false, message: "unreachable" };
    }
  }

  /** `POST /session` — create a session. On Safari, passing
   *  `{webSocketUrl:true, experimentalWebSocketUrl:true}` negotiates a real BiDi
   *  socket; the granted `webSocketUrl` is a `ws://` STRING when (and only when)
   *  the experimental cap took (reference 06). A boolean/absent value => no BiDi. */
  async newSession(caps: SessionCapabilities = {}): Promise<NewSessionResult> {
    const alwaysMatch: Record<string, unknown> = { browserName: "safari" };
    if (caps.webSocketUrl) alwaysMatch["webSocketUrl"] = true;
    if (caps.experimentalWebSocketUrl) alwaysMatch["safari:experimentalWebSocketUrl"] = true;
    const value = (await this.send("POST", "/session", { capabilities: { alwaysMatch } })) as {
      sessionId: string;
      capabilities: Record<string, unknown>;
    };
    const granted = value.capabilities ?? {};
    const ws = granted["webSocketUrl"];
    return {
      sessionId: value.sessionId,
      capabilities: granted,
      // ONLY a string ws:// URL counts as a live BiDi socket; the boolean
      // placeholder (experimental cap off) means Classic-only.
      webSocketUrl: typeof ws === "string" ? ws : undefined,
    };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.send("DELETE", `/session/${sessionId}`);
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    await this.send("POST", `/session/${sessionId}/url`, { url });
  }

  /** Current document URL — the Classic substitute for `page.url()` (which the
   *  Safari session cannot provide, having no Playwright Page). */
  async currentUrl(sessionId: string): Promise<string> {
    return (await this.send("GET", `/session/${sessionId}/url`)) as string;
  }

  /** Full-page screenshot as base64 PNG (Classic — BiDi captureScreenshot is
   *  absent on Safari 26.5). */
  async screenshot(sessionId: string): Promise<string> {
    return (await this.send("GET", `/session/${sessionId}/screenshot`)) as string;
  }

  /** Find the first matching element; null when none (no-such-element is a normal
   *  "not found", not a protocol failure, so it is mapped to null). */
  async findElement(sessionId: string, using: string, value: string): Promise<string | null> {
    try {
      const v = (await this.send("POST", `/session/${sessionId}/element`, {
        using,
        value,
      })) as Record<string, string>;
      return v[ELEMENT_KEY] ?? v["ELEMENT"] ?? null;
    } catch (err) {
      if (err instanceof WebDriverError && err.code === "no such element") return null;
      throw err;
    }
  }

  async findElements(sessionId: string, using: string, value: string): Promise<string[]> {
    const v = (await this.send("POST", `/session/${sessionId}/elements`, {
      using,
      value,
    })) as Record<string, string>[];
    return v.map((e) => e[ELEMENT_KEY] ?? e["ELEMENT"]).filter((id): id is string => Boolean(id));
  }

  async elementClick(sessionId: string, elementId: string): Promise<void> {
    await this.send("POST", `/session/${sessionId}/element/${elementId}/click`, {});
  }

  async elementClear(sessionId: string, elementId: string): Promise<void> {
    await this.send("POST", `/session/${sessionId}/element/${elementId}/clear`, {});
  }

  /** sendKeys. The W3C body carries both `text` and the legacy `value` array;
   *  safaridriver accepts `text`. */
  async elementValue(sessionId: string, elementId: string, text: string): Promise<void> {
    await this.send("POST", `/session/${sessionId}/element/${elementId}/value`, {
      text,
      value: text.split(""),
    });
  }

  async elementText(sessionId: string, elementId: string): Promise<string> {
    return (await this.send("GET", `/session/${sessionId}/element/${elementId}/text`)) as string;
  }

  /** Get Element Property — the LIVE DOM property (e.g. an input's current
   *  `value`), as opposed to the static HTML attribute. Used to read back what a
   *  fill landed. Returns null when the property is absent. */
  async elementProperty(
    sessionId: string,
    elementId: string,
    name: string,
  ): Promise<string | null> {
    const v = await this.send("GET", `/session/${sessionId}/element/${elementId}/property/${name}`);
    return typeof v === "string" ? v : null;
  }

  async getCookies(sessionId: string): Promise<WebDriverCookie[]> {
    return (await this.send("GET", `/session/${sessionId}/cookie`)) as WebDriverCookie[];
  }

  async addCookie(sessionId: string, cookie: WebDriverCookie): Promise<void> {
    await this.send("POST", `/session/${sessionId}/cookie`, { cookie });
  }

  /** `POST /execute/sync` — run page-context JS and return its value. This is the
   *  seam the Safari snapshot substrate ships browxai's DOM-walk PAGE_SCRIPT
   *  through (spike-confirmed identical to Playwright frame.evaluate —
   *  reference 07 §4). `script` is a function BODY; `args` map to `arguments`. */
  async executeScript(sessionId: string, script: string, args: unknown[] = []): Promise<unknown> {
    return await this.send("POST", `/session/${sessionId}/execute/sync`, { script, args });
  }

  /** The single request primitive: POST/GET/DELETE a WebDriver endpoint, unwrap
   *  the `{value}` envelope, and turn an error envelope into a structured
   *  `WebDriverError`. */
  private async send(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const payload = (await res.json()) as { value?: unknown };
    const value = payload?.value;
    // WebDriver signals errors with HTTP 4xx/5xx AND a `value.error` code.
    if (!res.ok || (value && typeof value === "object" && "error" in value)) {
      const v = (value ?? {}) as { error?: string; message?: string };
      throw new WebDriverError(v.error ?? `http ${res.status}`, v.message ?? "", res.status);
    }
    return value;
  }
}
