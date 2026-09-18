// Which application is on the other end of an attached CDP endpoint, answered by
// the PROTOCOL rather than by asking the operator to declare it.
//
// The desktop CDP-attach lane (`session/byob-attach.ts`) reaches one loopback
// endpoint and cannot know from the URL whether it leads to the operator's Chrome
// or to their Slack. The difference is not cosmetic: an Electron app refuses
// `Target.createTarget`, and loading a URL into its renderer destroys the running
// application. Both are engine-level facts, so the attach lane resolves the
// engine here and the rest of the server gates on the declaration as usual.
//
// THE SIGNAL. `Browser.getVersion` at the browser level returns a `userAgent`
// carrying `Electron/<version>`, and an app token before the Chrome token
// (`Code/1.122.1 Chrome/142.0.7444.265 Electron/39.8.8`). Measured against VS
// Code 1.122.1 / Electron 39.8.8. The `product` field does NOT carry it — it
// reads `Chrome/142.0.7444.265`, identical to desktop Chrome — and neither does
// Playwright's `browser.version()`, which is that same string. So the UA is the
// one place the protocol says it.
//
// THE LIMIT, written down. An app that overrides its default user agent
// (`app.userAgentFallback = …`) erases the marker, and this returns `chromium`
// for it. That is the safe direction to be wrong in: the operator gets today's
// behaviour. It is recoverable two ways — the attach pool still refuses
// structurally when `Target.createTarget` turns out to be unavailable, and an
// operator who knows what they pointed at can say
// `open_session({ engine: "electron" })`. Probing by CALLING `Target.createTarget`
// would be the stronger oracle and is rejected on purpose: on real Chrome it
// succeeds, and succeeding means opening an unwanted tab in the operator's
// browser to learn something.

import type { Browser } from "playwright-core";

/** `Electron/39.8.8`. Anchored on the token boundary so a page title or a path
 *  segment containing the word cannot match. */
const ELECTRON_UA = /\bElectron\/([0-9][\w.]*)/;
/** The app's own token, first in the UA product list: `Code/1.122.1`. Present on
 *  every Electron app that has not replaced its UA; absent is not fatal. */
const APP_UA = /\)\s+([A-Za-z][\w.-]*\/[\w.]+)\s+AppleWebKit/;

/** What the attach lane needs to know about the far end, resolved once per
 *  connection. Carries the engine AND the two behaviours that differ with it, so
 *  the attach lane consumes a record instead of re-deriving either from the
 *  engine name — which would put an `engine === "electron"` branch back in the
 *  session layer, where the closed core forbids it. */
export interface AttachedBrowserProfile {
  /** The two engines one loopback CDP endpoint can turn out to be. Narrower than
   *  `EngineKind` on purpose: firefox / webkit / safari have no CDP endpoint to
   *  attach to, and android is discovered over adb, never over a URL. */
  readonly engine: "chromium" | "electron";
  /** Whether the pool may mint a target. False on Electron: `Target.createTarget`
   *  answers "Not supported" (measured), at the page session and the browser
   *  session alike. */
  readonly canCreateTargets: boolean;
  /** Structured fields for the attach log line. */
  readonly detail: Readonly<Record<string, string>>;
  /** The operator-facing banner this attach prints. Engine-specific because the
   *  hazards are: an attached Electron app is one logged-in application with no
   *  URL bar, not a browser holding many origins. */
  readonly warning: string;
}

const CHROMIUM_ATTACH_WARNING = [
  "================================================================",
  "  browxai is attaching to an EXTERNAL Chrome over CDP (BYOB).",
  "  This Chrome is treated as NOT-OWNED: on shutdown browxai detaches",
  "  but does NOT close the browser or reset its storage.",
  "",
  "  Sharp edges (you accepted these by setting BROWX_ATTACH_CDP):",
  "  - The browser may have --disable-web-security (SOP off).",
  "  - The browser holds your real profile: every cookie, password,",
  "    and authed tab is in scope of any page the agent visits.",
  "  - The CDP port is unauthenticated; any local process can attach.",
  "",
  "  Managed mode (the default) avoids all of the above. See docs/threat-model.md.",
  "================================================================",
].join("\n");

function electronAttachWarning(app: string, electron: string): string {
  return [
    "================================================================",
    "  browxai is attaching to a RUNNING ELECTRON APP over CDP (BYOB).",
    `  Detected: ${app} on Electron ${electron}.`,
    "",
    "  This is a live, logged-in desktop application, not a test browser.",
    "  - Everything the signed-in user can reach in that app, the agent can",
    "    reach: messages, files, tokens in localStorage, the lot. There is no",
    "    URL bar and no second origin, so the origin allowlist contains nothing.",
    "  - NOT-OWNED: on shutdown browxai detaches; it never closes the app.",
    "  - The CDP port is unauthenticated. ANY local process can attach to it",
    "    for as long as the app runs — browxai does not hold it exclusively.",
    "  - `navigate` is REFUSED on this session: loading a URL into the",
    "    renderer destroys the app's UI unrecoverably. Drive it by clicking.",
    "",
    "  Detection note: running an app with --remote-debugging-port alongside",
    "  --user-data-dir matches published EDR rules for infostealer cookie",
    "  theft (MITRE T1539). Expect your endpoint agent to flag it.",
    "",
    "  Managed mode (the default) avoids all of the above. See docs/threat-model.md.",
    "================================================================",
  ].join("\n");
}

const CHROMIUM_PROFILE: AttachedBrowserProfile = {
  engine: "chromium",
  canCreateTargets: true,
  detail: { owner: "external", engine: "chromium" },
  warning: CHROMIUM_ATTACH_WARNING,
};

/** Read the far end's identity off the protocol. Best-effort by construction:
 *  any failure to reach `Browser.getVersion` yields the chromium profile, which
 *  is byte-identical to the pre-detection attach path — a probe that cannot
 *  answer must not change what an ordinary Chromium attach does. */
export async function profileAttachedBrowser(browser: Browser): Promise<AttachedBrowserProfile> {
  const ua = await browserUserAgent(browser);
  if (ua === undefined) return CHROMIUM_PROFILE;
  const electron = ELECTRON_UA.exec(ua);
  if (!electron) return CHROMIUM_PROFILE;
  const electronVersion = electron[1] ?? "unknown";
  const app = APP_UA.exec(ua)?.[1] ?? "an Electron app";
  return {
    engine: "electron",
    canCreateTargets: false,
    detail: { owner: "external", engine: "electron", app, electron: electronVersion },
    warning: electronAttachWarning(app, electronVersion),
  };
}

async function browserUserAgent(browser: Browser): Promise<string | undefined> {
  try {
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { userAgent } = (await cdp.send("Browser.getVersion")) as { userAgent?: string };
      return userAgent;
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  } catch {
    // No browser-level CDP session, or the endpoint answered nothing usable.
    // Undefined means "the protocol did not say", which the caller reads as
    // chromium — never as electron.
    return undefined;
  }
}
