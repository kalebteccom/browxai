// Anti-bot challenge detection — observation and reporting only.
//
// browxai names the gate; it never clears one. There is no solver, no token
// service and no fingerprint patch behind this module, and adding one is out of
// scope by design: the honest handoff for a detected challenge is `await_human`,
// where a person clears it in the live browser.
//
// Two inputs, because either can be missing:
//   - the main-frame document response (status + `cf-mitigated`), watched from
//     Node, which still classifies when the renderer is wedged;
//   - the in-page markers (challenge-page.ts), which carry the DOM evidence.

import type { Page, Response } from "playwright-core";
import { withDeadline } from "../util/deadline.js";
import type { FailureClass } from "../util/failure.js";
import { CHALLENGE_MARKERS_FN } from "./challenge-page.js";
import type {
  ChallengeBlock,
  ChallengeDocumentSignal,
  ChallengeMarkers,
} from "./challenge-types.js";

export type {
  ChallengeBlock,
  ChallengeDocumentSignal,
  ChallengeMarkers,
} from "./challenge-types.js";

/** Bound on the in-page probe. A challenge is most interesting exactly when the
 *  page is misbehaving, so the probe must never become the new hang. */
const PROBE_TIMEOUT_MS = 1_000;

const TITLE_MAX_CHARS = 120;
const GATE_STATUSES = [403, 503];

const CLOUDFLARE_TITLE = /just a moment/i;
const ANUBIS_TITLE = /making sure you'?re not a bot/i;
const GENERIC_TITLE =
  /(checking your browser|attention required|security check|verify(ing)? you are (a )?human|one more step)/i;

const VENDOR_LABEL: Record<ChallengeBlock["vendor"], string> = {
  cloudflare: "Cloudflare",
  anubis: "Anubis",
  unknown: "An unidentified bot-protection",
};

function titleEvidence(title: string): string {
  const clipped = title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS)}…` : title;
  return `document title ${JSON.stringify(clipped)}`;
}

function cloudflareInterstitial(
  markers: ChallengeMarkers | null,
  signal: ChallengeDocumentSignal,
): ChallengeBlock | undefined {
  const evidence: string[] = [];
  if (signal.cfMitigated === "challenge")
    evidence.push('response header "cf-mitigated: challenge"');
  if (markers?.cfChallengeScript) evidence.push('script src contains "cdn-cgi/challenge-platform"');
  if (markers && CLOUDFLARE_TITLE.test(markers.title)) evidence.push(titleEvidence(markers.title));
  if (evidence.length === 0) return undefined;
  return { kind: "interstitial", vendor: "cloudflare", evidence };
}

function anubisInterstitial(markers: ChallengeMarkers | null): ChallengeBlock | undefined {
  if (!markers) return undefined;
  const evidence: string[] = [];
  if (markers.anubisAsset) evidence.push('asset path contains "/.within.website/x/cmd/anubis/"');
  if (ANUBIS_TITLE.test(markers.title)) evidence.push(titleEvidence(markers.title));
  if (evidence.length === 0) return undefined;
  return { kind: "interstitial", vendor: "anubis", evidence };
}

function turnstileWidget(markers: ChallengeMarkers | null): ChallengeBlock | undefined {
  if (!markers?.cfTurnstileWidget) return undefined;
  return {
    kind: "widget",
    vendor: "cloudflare",
    evidence: ['element ".cf-turnstile[data-sitekey]"'],
  };
}

function genericInterstitial(markers: ChallengeMarkers | null): ChallengeBlock | undefined {
  if (!markers) return undefined;
  const evidence: string[] = [];
  if (GENERIC_TITLE.test(markers.title)) evidence.push(titleEvidence(markers.title));
  if (markers.verificationPhrase) {
    evidence.push(`page text contains ${JSON.stringify(markers.verificationPhrase)}`);
  }
  if (evidence.length === 0) return undefined;
  return { kind: "interstitial", vendor: "unknown", evidence };
}

/**
 * Classify the observed markers. Returns `undefined` when nothing matched — the
 * common path carries no block and no tokens.
 *
 * Interstitials are tested before the Turnstile widget because a managed
 * challenge page renders a Turnstile too, and calling that page a `widget` would
 * tell the caller the document is real when it is the gate. The widget arm also
 * shadows the generic arm for the same reason in reverse: a Turnstile's own
 * "Verify you are human" label would otherwise read as an interstitial.
 */
export function classifyChallenge(
  markers: ChallengeMarkers | null,
  signal: ChallengeDocumentSignal,
): ChallengeBlock | undefined {
  const block =
    cloudflareInterstitial(markers, signal) ??
    anubisInterstitial(markers) ??
    turnstileWidget(markers) ??
    genericInterstitial(markers);
  if (!block) return undefined;
  const status = signal.status;
  if (block.kind === "interstitial" && status !== undefined && GATE_STATUSES.includes(status)) {
    block.evidence.push(`document HTTP status ${status}`);
  }
  return block;
}

/** Recovery text for an action that hit its deadline behind a detected gate.
 *  Replaces the generic anti-wedge message, which would otherwise send the
 *  caller into the retry / raise-the-timeout / discard-the-session loop that
 *  cannot clear a challenge. */
export function challengeDeadlineFailure(block: ChallengeBlock): {
  error: string;
  failure: FailureClass;
} {
  const what = `${VENDOR_LABEL[block.vendor]} ${block.kind}`;
  const hint =
    `${what} detected — hand the session to a person with \`await_human\`, who clears the ` +
    `${block.kind} in the live browser; then re-run the action. Retrying, raising \`timeoutMs\`, ` +
    `or opening a fresh session will not clear it.`;
  const error =
    `${what} is gating this page: the page you got is not the page you asked for, and the action ` +
    `hit its deadline behind the gate. Evidence: ${block.evidence.join("; ")}. ` +
    `browxai detects challenges and does not solve them. ${hint}`;
  return { error, failure: { source: "app", hint } };
}

async function probeMarkers(page: Page): Promise<ChallengeMarkers | null> {
  try {
    return await withDeadline(
      page.evaluate(CHALLENGE_MARKERS_FN),
      PROBE_TIMEOUT_MS,
      "challenge-probe",
    );
  } catch {
    // A navigating, closed or wedged renderer: the document-response signal is
    // still enough to classify the interstitial cases.
    return null;
  }
}

export interface ChallengeWatch {
  /** Stop watching and classify what the window saw. */
  detect: () => Promise<ChallengeBlock | undefined>;
}

/** Watch the main-frame document response for the duration of an action window,
 *  then probe the settled page. */
export function watchForChallenge(page: Page): ChallengeWatch {
  const signal: ChallengeDocumentSignal = {};
  const onResponse = (res: Response): void => {
    if (res.frame() !== page.mainFrame()) return;
    if (res.request().resourceType() !== "document") return;
    signal.status = res.status();
    const mitigated = res.headers()["cf-mitigated"];
    if (mitigated) signal.cfMitigated = mitigated.toLowerCase();
  };
  page.on("response", onResponse);
  return {
    detect: async () => {
      page.off("response", onResponse);
      return classifyChallenge(await probeMarkers(page), signal);
    },
  };
}
