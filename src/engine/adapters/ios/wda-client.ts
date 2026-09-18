// The XCUITest transport for the ios-app engine — an HTTP client over a running
// WebDriverAgent.
//
// WHY HTTP AND NOT A LIBRARY. Reading the XCUITest element hierarchy needs code
// running inside an XCUITest host on the device; there is no out-of-process API
// for it. WebDriverAgent (Apache-2.0, github.com/appium/WebDriverAgent) is that
// host, and it speaks a WebDriver-shaped HTTP protocol on a local port. browxai
// speaks to it with `fetch` and takes NO npm dependency — the same shape as the
// safari engine, which speaks WebDriver Classic to a locally-running
// `safaridriver`. Nothing GPL is reachable from here, directly or transitively:
// GPL-3.0 `pymobiledevice3` is excluded by RFC 0008's licence floor and is a
// real-device tunnelling tool this simulator-only engine never needs.
//
// WDA IS OPERATOR-SUPPLIED, like Xcode and like the credentials provider.
// browxai does not build it, does not vendor it, and does not fetch it. The
// operator runs it against a booted simulator and points `BROWX_IOS_WDA_URL` at
// it; with nothing listening, session creation refuses with the structured error
// below rather than degrading into a snapshot that answers with an empty tree.
//
// `Http` is the injectable seam. The endpoint construction and the
// response-envelope unwrapping are what these tests cover without a simulator —
// the same split `adb.ts` draws between pure logic and the IO that needs a device.

/** The one IO primitive this client needs. Injected so every endpoint and every
 *  envelope shape is unit-testable with no WebDriverAgent running. */
export type Http = (
  url: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: string },
) => Promise<{ ok: boolean; status: number; text: string }>;

/** The default `BROWX_IOS_WDA_URL`. WebDriverAgent's own default listen port. */
export const DEFAULT_WDA_URL = "http://127.0.0.1:8100";

/** Nothing is listening where WebDriverAgent should be. Structured — the fix is
 *  in the error, because this is the first-run failure on every fresh machine. */
export class WdaUnreachableError extends Error {
  constructor(url: string, detail: string) {
    super(
      `wda-unreachable: no WebDriverAgent answered at ${url} (${detail}). The ios-app engine reads ` +
        "the XCUITest element hierarchy through WebDriverAgent, which browxai does NOT bundle, " +
        "build or install — it is operator-supplied, like Xcode itself. Build and run it against " +
        "your booted simulator (`xcodebuild -project WebDriverAgent.xcodeproj -scheme " +
        "WebDriverAgentRunner -destination 'id=<udid>' test`), then point BROWX_IOS_WDA_URL at its " +
        "port. Simulator and application lifecycle (boot / install / launch / terminate / " +
        "screenshot) run through `xcrun simctl` and need no WebDriverAgent.",
    );
    this.name = "WdaUnreachableError";
  }
}

/** WebDriverAgent answered, and said no. Carries its own error code so a caller
 *  can tell "no such element" from "the session died". */
export class WdaCommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`wda-error [${code}]: ${message}`);
    this.name = "WdaCommandError";
    this.code = code;
  }
}

/** The WebDriver response envelope: `{ value: … }`, or `{ value: { error, message } }`. */
interface WdaEnvelope {
  value?: unknown;
  sessionId?: string;
}

function unwrap(text: string, status: number): unknown {
  let body: WdaEnvelope;
  try {
    body = JSON.parse(text) as WdaEnvelope;
  } catch {
    throw new WdaCommandError(String(status), text.slice(0, 200));
  }
  const value = body.value;
  if (value && typeof value === "object" && "error" in value) {
    const err = value as { error?: unknown; message?: unknown };
    throw new WdaCommandError(
      typeof err.error === "string" ? err.error : String(status),
      typeof err.message === "string" ? err.message : text.slice(0, 200),
    );
  }
  return value;
}

/** The default `Http` — `fetch` with a bounded timeout. A transport-level failure
 *  becomes `WdaUnreachableError`; an HTTP-level refusal is handed on so `unwrap`
 *  can read WebDriverAgent's own error code out of the body. */
export function defaultHttp(timeoutMs = 30_000): Http {
  return async (url, init) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        ...(init.body !== undefined
          ? { body: init.body, headers: { "content-type": "application/json" } }
          : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new WdaUnreachableError(url, err instanceof Error ? err.message : String(err));
    }
    return { ok: res.ok, status: res.status, text: await res.text() };
  };
}

/** A WebDriverAgent client, scoped to one session once `newSession` has run.
 *  Every method is one round trip and returns plain data — no handles, nothing
 *  cached between calls (RFC 0008 §3). */
export class WdaClient {
  private sessionId: string | undefined;

  constructor(
    private readonly baseUrl: string = DEFAULT_WDA_URL,
    private readonly http: Http = defaultHttp(),
  ) {}

  /** The session this client is bound to, or undefined before `newSession`. */
  get session(): string | undefined {
    return this.sessionId;
  }

  /** Confirm WebDriverAgent is up before anything else runs. `GET /status` is
   *  the one endpoint that needs no session. */
  async status(): Promise<Record<string, unknown>> {
    return (await this.get("/status")) as Record<string, unknown>;
  }

  /** Attach XCUITest to `bundleId` and hold the session id. */
  async newSession(bundleId: string): Promise<string> {
    const body = JSON.stringify({ capabilities: { alwaysMatch: { bundleId } } });
    const raw = await this.http(`${this.baseUrl}/session`, { method: "POST", body });
    const value = unwrap(raw.text, raw.status) as { sessionId?: string } | undefined;
    const parsed = JSON.parse(raw.text) as { sessionId?: string };
    const id = value?.sessionId ?? parsed.sessionId;
    if (!id) throw new WdaCommandError("session not created", raw.text.slice(0, 200));
    this.sessionId = id;
    return id;
  }

  async deleteSession(): Promise<void> {
    if (!this.sessionId) return;
    await this.http(`${this.baseUrl}/session/${this.sessionId}`, { method: "DELETE" }).catch(
      () => undefined,
    );
    this.sessionId = undefined;
  }

  /** The full XCUITest element hierarchy as JSON. */
  async source(): Promise<unknown> {
    return this.get(`${this.scoped()}/source?format=json`);
  }

  /** Base64 PNG of the whole screen. WebDriverAgent's own screenshot rather than
   *  simctl's, so the frame matches the hierarchy the caller just read. */
  async screenshot(): Promise<string> {
    return (await this.get(`${this.scoped()}/screenshot`)) as string;
  }

  /** The frontmost application, as WebDriverAgent reports it. */
  async activeAppInfo(): Promise<{ bundleId?: string; pid?: number; name?: string }> {
    return (await this.get(`${this.scoped()}/wda/activeAppInfo`)) as {
      bundleId?: string;
      pid?: number;
      name?: string;
    };
  }

  /** Resolve an accessibility identifier to a WebDriverAgent element id, or null
   *  when nothing matches. `accessibility id` is XCUITest's own identifier
   *  strategy — it queries `accessibilityIdentifier`, which is what a React
   *  Native `testID` compiles to. */
  async findByAccessibilityId(identifier: string): Promise<string | null> {
    try {
      const value = (await this.post(`${this.scoped()}/element`, {
        using: "accessibility id",
        value: identifier,
      })) as Record<string, string> | null;
      return value ? (Object.values(value)[0] ?? null) : null;
    } catch (err) {
      if (err instanceof WdaCommandError && /no such element/i.test(err.code)) return null;
      throw err;
    }
  }

  /** Element-scoped set-value. The value never reaches a shell (RFC 0008 §6). */
  async setValue(elementId: string, text: string): Promise<void> {
    await this.post(`${this.scoped()}/element/${elementId}/value`, { value: [...text] });
  }

  /** Type into whatever holds keyboard focus. */
  async keys(text: string): Promise<void> {
    await this.post(`${this.scoped()}/wda/keys`, { value: [...text] });
  }

  async tap(x: number, y: number): Promise<void> {
    await this.post(`${this.scoped()}/wda/tap/0`, { x, y });
  }

  /** `dragfromtoforduration` is XCUITest's OWN drag primitive, not three
   *  synthesised touch events — which is why `ActionSubstrate.gesture` names
   *  swipe as its own request kind (RFC 0009 P3 / RFC 0008 §1). */
  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationSec: number,
  ): Promise<void> {
    await this.post(`${this.scoped()}/wda/dragfromtoforduration`, {
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      duration: durationSec,
    });
  }

  /** `XCUIElement.pinch(withScale:velocity:)` is element-scoped in XCUITest, so
   *  the pinch applies to the element under `elementId` — the application element
   *  when the caller pinches the whole screen. */
  async pinch(elementId: string, scale: number, velocity: number): Promise<void> {
    await this.post(`${this.scoped()}/element/${elementId}/pinch`, { scale, velocity });
  }

  /** The application element id — the pinch target for a whole-screen gesture. */
  async activeElementRoot(): Promise<string | null> {
    const value = (await this.post(`${this.scoped()}/element`, {
      using: "class name",
      value: "XCUIElementTypeApplication",
    }).catch(() => null)) as Record<string, string> | null;
    return value ? (Object.values(value)[0] ?? null) : null;
  }

  /** A hardware or software button: `home`, `volumeUp`, `volumeDown`. */
  async pressButton(name: string): Promise<void> {
    await this.post(`${this.scoped()}/wda/pressButton`, { name });
  }

  private scoped(): string {
    if (!this.sessionId) {
      throw new WdaCommandError("invalid session id", "no WebDriverAgent session is open");
    }
    return `${this.baseUrl}/session/${this.sessionId}`;
  }

  private async get(path: string): Promise<unknown> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const res = await this.http(url, { method: "GET" });
    return unwrap(res.text, res.status);
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const res = await this.http(url, { method: "POST", body: JSON.stringify(body) });
    return unwrap(res.text, res.status);
  }
}
