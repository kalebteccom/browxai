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

describe("classifyChallenge — Cloudflare managed challenge", () => {
  it("detects the interstitial from the challenge-platform script", () => {
    const r = classifyChallenge(markers({ cfChallengeScript: true }), { status: 403 });
    expect(r).toEqual({
      kind: "interstitial",
      vendor: "cloudflare",
      evidence: ['script src contains "cdn-cgi/challenge-platform"', "document HTTP status 403"],
    });
  });

  it("detects the interstitial from the response header alone when the page probe failed", () => {
    const r = classifyChallenge(null, { status: 503, cfMitigated: "challenge" });
    expect(r?.kind).toBe("interstitial");
    expect(r?.vendor).toBe("cloudflare");
    expect(r?.evidence).toContain('response header "cf-mitigated: challenge"');
    expect(r?.evidence).toContain("document HTTP status 503");
  });

  it("detects the interstitial from the document title", () => {
    const r = classifyChallenge(markers({ title: "Just a moment..." }), { status: 200 });
    expect(r?.vendor).toBe("cloudflare");
    expect(r?.evidence).toEqual(['document title "Just a moment..."']);
  });
});

describe("classifyChallenge — Turnstile widget", () => {
  it("classifies a widget on an otherwise normal 200 page, never as an interstitial", () => {
    const r = classifyChallenge(markers({ cfTurnstileWidget: true, title: "Sign in" }), {
      status: 200,
    });
    expect(r).toEqual({
      kind: "widget",
      vendor: "cloudflare",
      evidence: ['element ".cf-turnstile[data-sitekey]"'],
    });
  });

  it("carries no HTTP-status evidence — a widget page is a real 200 page", () => {
    const r = classifyChallenge(markers({ cfTurnstileWidget: true }), { status: 403 });
    expect(r?.kind).toBe("widget");
    expect(r?.evidence).toEqual(['element ".cf-turnstile[data-sitekey]"']);
  });

  it("is shadowed by the interstitial when the gate page also renders a Turnstile", () => {
    const r = classifyChallenge(
      markers({ cfChallengeScript: true, cfTurnstileWidget: true, title: "Just a moment..." }),
      { status: 503, cfMitigated: "challenge" },
    );
    expect(r?.kind).toBe("interstitial");
    expect(r?.evidence).toHaveLength(4);
  });

  it("is not reported as a generic interstitial from its own verify-you-are-human label", () => {
    const r = classifyChallenge(
      markers({ cfTurnstileWidget: true, verificationPhrase: "verify you are human" }),
      { status: 200 },
    );
    expect(r?.kind).toBe("widget");
  });
});

describe("classifyChallenge — Anubis", () => {
  it("detects the proof-of-work interstitial from the asset path and the title", () => {
    const r = classifyChallenge(
      markers({ anubisAsset: true, title: "Making sure you're not a bot!" }),
      { status: 200 },
    );
    expect(r).toEqual({
      kind: "interstitial",
      vendor: "anubis",
      evidence: [
        'asset path contains "/.within.website/x/cmd/anubis/"',
        'document title "Making sure you\'re not a bot!"',
      ],
    });
  });
});

describe("classifyChallenge — unknown vendor", () => {
  it("reports the generic interstitial shape with vendor unknown", () => {
    const r = classifyChallenge(
      markers({ title: "Checking your browser", verificationPhrase: "checking your browser" }),
      { status: 503 },
    );
    expect(r?.kind).toBe("interstitial");
    expect(r?.vendor).toBe("unknown");
    expect(r?.evidence).toEqual([
      'document title "Checking your browser"',
      'page text contains "checking your browser"',
      "document HTTP status 503",
    ]);
  });
});

describe("classifyChallenge — the common path carries nothing", () => {
  it("returns undefined for a normal page", () => {
    expect(classifyChallenge(markers(), { status: 200 })).toBeUndefined();
  });

  it("returns undefined for a plain 403 with no challenge markers", () => {
    expect(classifyChallenge(markers({ title: "Forbidden" }), { status: 403 })).toBeUndefined();
  });

  it("returns undefined when the page probe failed and the edge sent nothing", () => {
    expect(classifyChallenge(null, {})).toBeUndefined();
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

  it("labels an unidentified vendor without claiming one", () => {
    const { error } = challengeDeadlineFailure({
      kind: "interstitial",
      vendor: "unknown",
      evidence: ['document title "Checking your browser"'],
    });
    expect(error).toContain("An unidentified bot-protection interstitial");
  });
});
