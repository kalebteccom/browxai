/// <reference lib="dom" />
// Challenge detection — the in-page marker reader.
//
// `CHALLENGE_MARKERS_FN` is a REAL function literal handed whole to
// `page.evaluate(fn)`. A stringified arrow would evaluate to a function value,
// which CDP cannot serialize, and the result would silently cross back as
// `undefined` while mocked unit tests still passed (the dom_export /
// element_export trap). The uppercase `*_FN` name also carries the
// `no-page-eval-stringified-arrow` lint exemption.
//
// Everything the function needs is declared INSIDE it: only the function source
// crosses the boundary, so a module-scoped constant referenced from the body
// would be undefined in the page realm.

import type { ChallengeMarkers } from "./challenge-types.js";

/** Read the challenge markers off the current document. Passed as a real
 *  function literal — see the file-header note on the serialization trap. */
export const CHALLENGE_MARKERS_FN = (): ChallengeMarkers => {
  // Only a matched entry from this fixed list is returned, so no arbitrary page
  // text rides back on the ActionResult.
  const verificationPhrases = [
    "verify you are human",
    "verifying you are human",
    "checking your browser",
    "checking if the site connection is secure",
    "enable javascript and cookies to continue",
    "complete the security check",
    "making sure you're not a bot",
  ];
  const bodyTextScanChars = 4000;

  const attrValues = (selector: string, attr: string): string[] => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const v = el.getAttribute(attr);
      if (v) out.push(v);
    }
    return out;
  };
  const contains = (values: string[], needle: string): boolean =>
    values.some((v) => v.indexOf(needle) !== -1);

  const scriptSrcs = attrValues("script[src]", "src");
  const assetPaths = scriptSrcs
    .concat(attrValues("img[src]", "src"))
    .concat(attrValues("link[href]", "href"));

  const bodyText = (document.body ? document.body.innerText : "")
    .slice(0, bodyTextScanChars)
    .toLowerCase();
  let verificationPhrase: string | null = null;
  for (const phrase of verificationPhrases) {
    if (bodyText.indexOf(phrase) !== -1) {
      verificationPhrase = phrase;
      break;
    }
  }

  return {
    title: document.title,
    // Scoped to `script[src]` on purpose: a Turnstile widget's iframe src also
    // carries the `cdn-cgi/challenge-platform` path, and matching it would
    // report a plain login page as a full interstitial.
    cfChallengeScript: contains(scriptSrcs, "cdn-cgi/challenge-platform"),
    cfTurnstileWidget: document.querySelector(".cf-turnstile[data-sitekey]") !== null,
    anubisAsset: contains(assetPaths, "/.within.website/x/cmd/anubis/"),
    verificationPhrase,
  };
};
