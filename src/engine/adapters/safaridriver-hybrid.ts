// SafaridriverHybridAdapter — the FIFTH BrowserEngine adapter (RFC 0002 P4) and
// the FIRST non-Playwright one. It drives real Safari.app over safaridriver in
// non-BYOB isolated automation windows, hybridising two protocols (per the live
// probe, docs/rfcs/references/06-safari-bidi-probe.md):
//   - WebDriver CLASSIC (SafariWebDriverClient) — the complete workhorse:
//     navigation, element find/click/sendKeys, screenshot, cookies, executeScript
//     (the seam the Safari snapshot substrate ships browxai's DOM-walk through).
//   - WebDriver BiDi (SafariBidiClient) — the ADDITIVE bidirectional layer, gated
//     behind the vendor cap `safari:experimentalWebSocketUrl:true`: live console
//     (`log.entryAdded`) + navigation-lifecycle events + multi-realm script. It is
//     STRICTLY OPTIONAL — if the cap does not yield a ws:// URL the adapter runs
//     Classic-only, losing only the event streams.
//
// Unlike the other four adapters this returns NO Playwright `Page` and NO CDP —
// Safari has neither. The session it yields is Safari-native (a `SafariSessionHandle`);
// the session-layer seam that lets the rest of the server consume it (the
// no-Playwright-Page contract) is a later increment — see
// docs/rfcs/references/07-safari-adapter-implementation-plan.md §3/§6. This module
// is the lifecycle + transport orchestration, fully unit-tested with mocks; the
// real IO is covered by the Safari-gated keystone.
//
// safaridriver allows ONE session at a time, so this adapter enforces single-session
// at the adapter level (a second launch while one is live is a structured refusal)
// rather than letting safaridriver fail opaquely on the second POST /session.

import { capabilitiesFor } from "../capabilities.js";
import type { EngineCapabilities, EngineKind } from "../types.js";
import { SafariWebDriverClient, WebDriverError } from "./safari/webdriver-client.js";
import { SafariBidiClient } from "./safari/bidi-client.js";
import {
  launchSafaridriver,
  type SafariDriverProcess,
  type SafariLaunchDeps,
} from "./safari/launch.js";

/** A live Safari session — the adapter's native return (NOT yet an `EngineSession`;
 *  the no-Playwright-Page seam wires that in a later increment). Owns the WebDriver
 *  Classic client (always) and the BiDi client (only when the experimental cap
 *  yielded a socket). */
export interface SafariSessionHandle {
  readonly engine: EngineKind;
  readonly capabilities: EngineCapabilities;
  readonly sessionId: string;
  /** The Classic workhorse — always present. */
  readonly webDriver: SafariWebDriverClient;
  /** The BiDi event/script layer — present only when BiDi negotiated (the
   *  experimental cap returned a real ws:// URL). Undefined ⇒ Classic-only. */
  readonly bidi: SafariBidiClient | undefined;
  /** Whether the bidirectional (BiDi) layer is live. */
  readonly hasBidi: boolean;
  close(): Promise<void>;
}

/** Raised when session creation is rejected because Safari's "Allow Remote
 *  Automation" is off — the most common first-run failure on a fresh host. Names
 *  the exact fix. */
export class SafariRemoteAutomationDisabledError extends Error {
  constructor(detail: string) {
    super(
      `safari-remote-automation-disabled: safaridriver refused the session (${detail}). ` +
        'Run `sudo safaridriver --enable` and enable Safari ▸ Develop ▸ "Allow Remote Automation".',
    );
    this.name = "SafariRemoteAutomationDisabledError";
  }
}

/** Raised when a second session is requested while one is already live —
 *  safaridriver is single-session. */
export class SafariSessionBusyError extends Error {
  constructor() {
    super(
      "safari-session-busy: safaridriver hosts ONE session at a time and a Safari session is " +
        "already open. Close it before opening another.",
    );
    this.name = "SafariSessionBusyError";
  }
}

/** Injectable seams so the orchestration tests without a real safaridriver. */
export interface SafariAdapterDeps {
  /** Launch safaridriver (defaults to the real `launchSafaridriver`). */
  launch?: (deps?: SafariLaunchDeps) => Promise<SafariDriverProcess>;
  launchDeps?: SafariLaunchDeps;
  webDriverFactory?: (baseUrl: string) => SafariWebDriverClient;
  bidiFactory?: (url: string) => SafariBidiClient;
}

export class SafaridriverHybridAdapter {
  readonly engine: EngineKind = "safari";
  readonly capabilities: EngineCapabilities;
  private readonly deps: SafariAdapterDeps;
  /** The single live session (safaridriver is single-session). */
  private active: SafariSessionHandle | undefined;

  constructor(deps: SafariAdapterDeps = {}) {
    // safari always has a declaration (see capabilities.ts).
    this.capabilities = capabilitiesFor("safari")!;
    this.deps = deps;
  }

  /** Launch a managed, isolated Safari automation window and create a hybrid
   *  Classic+BiDi session. Single-session: refuses if one is already live. */
  async launchManaged(): Promise<SafariSessionHandle> {
    if (this.active) throw new SafariSessionBusyError();

    const launch = this.deps.launch ?? launchSafaridriver;
    const driver = await launch(this.deps.launchDeps);

    const webDriver = (
      this.deps.webDriverFactory ?? ((baseUrl) => new SafariWebDriverClient({ baseUrl }))
    )(driver.baseUrl);

    let session;
    try {
      // Request BiDi (experimental cap) AND Classic — BiDi is additive; a boolean
      // placeholder (cap off) simply means no ws:// URL, so we stay Classic-only.
      session = await webDriver.newSession({ webSocketUrl: true, experimentalWebSocketUrl: true });
    } catch (err) {
      driver.stop();
      throw mapSessionError(err);
    }

    let bidi: SafariBidiClient | undefined;
    if (session.webSocketUrl) {
      const client = (this.deps.bidiFactory ?? ((url) => new SafariBidiClient({ url })))(
        session.webSocketUrl,
      );
      try {
        await client.connect();
        bidi = client;
      } catch {
        // BiDi is optional — a failed connect degrades to Classic-only, never
        // fails the session.
        bidi = undefined;
      }
    }

    const handle: SafariSessionHandle = {
      engine: this.engine,
      capabilities: this.capabilities,
      sessionId: session.sessionId,
      webDriver,
      bidi,
      hasBidi: bidi !== undefined,
      close: async () => {
        bidi?.close();
        await webDriver.deleteSession(session.sessionId).catch(() => undefined);
        driver.stop();
        this.active = undefined;
      },
    };
    this.active = handle;
    return handle;
  }

  /** Attach is NOT supported: safaridriver hard-isolates automation into a clean
   *  ephemeral window and cannot attach to the user's live, logged-in Safari (the
   *  XPC surface is categorically closed — RFC D7 / reference 05). Structured
   *  refusal, never a vague failure. */
  attach(): Promise<never> {
    return Promise.reject(
      new Error(
        "safari-attach-not-supported: real Safari automation is non-BYOB by construction — " +
          "safaridriver hard-isolates each session into a clean ephemeral automation window (no " +
          "cookies/localStorage/Keychain/history from the real profile), and the webinspectord XPC " +
          "surface that would allow attach is closed to third parties (RFC 0002 D7, " +
          "docs/rfcs/references/05-safari-xpc.md). Use a managed session.",
      ),
    );
  }
}

/** Map a session-create failure to a structured, actionable error. safaridriver
 *  signals "Allow Remote Automation" being off as a `session not created`. */
function mapSessionError(err: unknown): Error {
  if (err instanceof WebDriverError) {
    if (err.code === "session not created" || /automation/i.test(err.message)) {
      return new SafariRemoteAutomationDisabledError(err.message || err.code);
    }
    return err;
  }
  return err instanceof Error ? err : new Error(String(err));
}
