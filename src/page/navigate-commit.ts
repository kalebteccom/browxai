// `page.goto` with one resend when the document response arrived but the page
// never loaded it.
//
// Seen on Playwright's Firefox: the main-frame document GET is answered (200 in
// tens of milliseconds) and the frame never commits, so `goto` waits out its
// whole timeout and the page stays on the URL it started from. A healthy
// navigation commits within milliseconds of its response on every engine, so a
// response followed by no commit for `COMMIT_STALL_MS` is treated as stalled:
// the navigation is sent again once, inside the same deadline. A slow server
// is never resent, because the stall clock starts only once its response is in.

import type { Frame, Page, Response } from "playwright-core";
import { log } from "../util/logging.js";

/** How long a navigation may sit between its document response and the commit
 *  before it is sent again. Passing Firefox navigations commit well under this
 *  even on a loaded CI box. */
export const COMMIT_STALL_MS = 1_500;

/** The slice of `Page` the resend logic touches, so a unit test can fake it. */
export type NavigablePage = Pick<Page, "goto" | "mainFrame" | "on" | "off">;

export interface GotoOutcome {
  /** True when the first navigation stalled after its response and was sent again. */
  resent: boolean;
}

/** Responses that never commit a document on any engine: redirects hand off to
 *  the next request, and 204/205 leave the current document in place. */
function commitsDocument(res: Response): boolean {
  const status = res.status();
  return !(status >= 300 && status < 400) && status !== 204 && status !== 205;
}

type FirstAttempt = { kind: "done" } | { kind: "stalled" };

function firstAttempt(
  page: NavigablePage,
  url: string,
  timeoutMs: number,
  stallMs: number,
): Promise<FirstAttempt> {
  let committed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onStall: (() => void) | undefined;
  const stalled = new Promise<FirstAttempt>((resolve) => {
    onStall = () => resolve({ kind: "stalled" });
  });
  const onFrameNavigated = (frame: Frame): void => {
    if (frame !== page.mainFrame()) return;
    committed = true;
    if (timer) clearTimeout(timer);
  };
  const onResponse = (res: Response): void => {
    if (committed || timer) return;
    if (res.frame() !== page.mainFrame()) return;
    if (!res.request().isNavigationRequest() || !commitsDocument(res)) return;
    timer = setTimeout(() => {
      if (!committed) onStall?.();
    }, stallMs);
  };
  page.on("framenavigated", onFrameNavigated);
  page.on("response", onResponse);
  const goto = page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  // When the stall wins, the resend interrupts this navigation and its promise
  // rejects later. Nobody awaits it then, so keep that rejection handled.
  goto.catch(() => undefined);
  const done = goto.then((): FirstAttempt => ({ kind: "done" }));
  return Promise.race([done, stalled]).finally(() => {
    if (timer) clearTimeout(timer);
    page.off("framenavigated", onFrameNavigated);
    page.off("response", onResponse);
  });
}

/**
 * Navigate to `url` and wait for `domcontentloaded`, all within `budgetMs`. When
 * the main-frame document response arrives and the frame has not committed
 * `stallMs` later, the navigation is sent again once with the rest of the
 * budget. Errors from `goto` (bad URL, network failure, timeout) propagate.
 */
export async function gotoWithCommitResend(
  page: NavigablePage,
  url: string,
  budgetMs: number,
  stallMs: number = COMMIT_STALL_MS,
): Promise<GotoOutcome> {
  const started = Date.now();
  const first = await firstAttempt(page, url, budgetMs, stallMs);
  if (first.kind === "done") return { resent: false };
  const remaining = Math.max(1, budgetMs - (Date.now() - started));
  // Logged so CI output shows how often the stall happens and whether the
  // resend recovers it.
  log.info("navigate: document response in, no commit; sending the navigation again", {
    stallMs,
    remainingMs: remaining,
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining });
  return { resent: true };
}

/** The result warning for a navigation that was sent a second time. */
export function resentWarning(stallMs: number = COMMIT_STALL_MS): string {
  return (
    `navigate: the page received the document response but did not load it within ` +
    `${stallMs}ms, so the navigation was sent again once.`
  );
}
