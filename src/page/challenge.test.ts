import { describe, it, expect } from "vitest";
import { challengeDeadlineFailure, classifyChallenge } from "./challenge.js";
import type { ChallengeMarkers } from "./challenge-types.js";

const CLEAN: ChallengeMarkers = {
  title: "Records — Example App",
  cfChallengeScript: false,
  cfTurnstileWidget: false,
  anubisAsset: false,
  verificationPhrase: null,
};

function markers(over: Partial<ChallengeMarkers> = {}): ChallengeMarkers {
  return { ...CLEAN, ...over };
}

describe("classifyChallenge", () => {
  it.each([
    {
      name: "Cloudflare interstitial from the challenge-platform script",
      m: markers({ cfChallengeScript: true }),
      http: { status: 403 },
      want: {
        kind: "interstitial",
        vendor: "cloudflare",
        evidence: ['script src contains "cdn-cgi/challenge-platform"', "document HTTP status 403"],
      },
    },
    {
      name: "Cloudflare interstitial from the response header alone when the page probe failed",
      m: null,
      http: { status: 503, cfMitigated: "challenge" },
      want: {
        kind: "interstitial",
        vendor: "cloudflare",
        evidence: expect.arrayContaining([
          'response header "cf-mitigated: challenge"',
          "document HTTP status 503",
        ]),
      },
    },
    {
      name: "Cloudflare interstitial from the document title",
      m: markers({ title: "Just a moment..." }),
      http: { status: 200 },
      want: {
        kind: "interstitial",
        vendor: "cloudflare",
        evidence: ['document title "Just a moment..."'],
      },
    },
    {
      name: "Turnstile widget is a widget and carries no HTTP-status evidence",
      m: markers({ cfTurnstileWidget: true }),
      http: { status: 403 },
      want: {
        kind: "widget",
        vendor: "cloudflare",
        evidence: ['element ".cf-turnstile[data-sitekey]"'],
      },
    },
    {
      name: "Turnstile is shadowed by the interstitial when the gate page also renders it",
      m: markers({ cfChallengeScript: true, cfTurnstileWidget: true, title: "Just a moment..." }),
      http: { status: 503, cfMitigated: "challenge" },
      want: { kind: "interstitial" },
      evidenceLen: 4,
    },
    {
      name: "Turnstile is not reported as an interstitial from its verify-you-are-human label",
      m: markers({ cfTurnstileWidget: true, verificationPhrase: "verify you are human" }),
      http: { status: 200 },
      want: { kind: "widget" },
    },
    {
      name: "Anubis proof-of-work interstitial from the asset path and the title",
      m: markers({ anubisAsset: true, title: "Making sure you're not a bot!" }),
      http: { status: 200 },
      want: {
        kind: "interstitial",
        vendor: "anubis",
        evidence: [
          'asset path contains "/.within.website/x/cmd/anubis/"',
          'document title "Making sure you\'re not a bot!"',
        ],
      },
    },
    {
      name: "generic interstitial shape with vendor unknown",
      m: markers({ title: "Checking your browser", verificationPhrase: "checking your browser" }),
      http: { status: 503 },
      want: {
        kind: "interstitial",
        vendor: "unknown",
        evidence: [
          'document title "Checking your browser"',
          'page text contains "checking your browser"',
          "document HTTP status 503",
        ],
      },
    },
    {
      name: "nothing for a plain 403 with no challenge markers",
      m: markers({ title: "Forbidden" }),
      http: { status: 403 },
      want: undefined,
    },
  ])("classifyChallenge detects: $name", ({ m, http, want, evidenceLen }) => {
    const r = classifyChallenge(m, http);
    if (want === undefined) expect(r).toBeUndefined();
    else if ("vendor" in want && "evidence" in want) expect(r).toEqual(want);
    else expect(r).toMatchObject(want);
    if (evidenceLen !== undefined) expect(r?.evidence).toHaveLength(evidenceLen);
  });
});

describe("challengeDeadlineFailure", () => {
  it("names the vendor, the kind, the evidence and await_human", () => {
    const { error, failure } = challengeDeadlineFailure({
      kind: "interstitial",
      vendor: "cloudflare",
      evidence: ['response header "cf-mitigated: challenge"'],
    });
    expect(error).toContain("Cloudflare interstitial");
    expect(error).toContain('cf-mitigated: challenge"');
    expect(error).toContain("await_human");
    expect(error).toContain("does not solve");
    expect(failure.source).toBe("app");
    expect(failure.hint).toContain("await_human");
  });
});
