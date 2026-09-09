// Challenge-detection domain types — engine-blind, page-realm-free, so both the
// in-page marker function (challenge-page.ts) and the Node-side classifier
// (challenge.ts) can share them without either importing the other's realm.

/** The `ActionResult.challenge` block. Present only when markers were found.
 *
 *  `interstitial` — the document IS the gate; the page the caller asked for was
 *  never served. `widget` — a normal page carrying a challenge control (a
 *  Turnstile on a login form); the page is real, one control is gated. The two
 *  yield different artifacts (a clearance cookie vs a one-time token) and need
 *  different handling, so they are never collapsed into one kind. */
export interface ChallengeBlock {
  kind: "interstitial" | "widget";
  vendor: "cloudflare" | "anubis" | "unknown";
  evidence: string[];
}

/** Facts about the main-frame document response observed during the action
 *  window. Survives a wedged renderer, so it still classifies when the in-page
 *  probe cannot run. */
export interface ChallengeDocumentSignal {
  status?: number;
  /** Lowercased `cf-mitigated` response header, when the edge sent one. */
  cfMitigated?: string;
}

/** What the in-page marker function reports back. Booleans and one matched
 *  phrase from a fixed list — no page text crosses the boundary. */
export interface ChallengeMarkers {
  title: string;
  cfChallengeScript: boolean;
  cfTurnstileWidget: boolean;
  anubisAsset: boolean;
  verificationPhrase: string | null;
}
