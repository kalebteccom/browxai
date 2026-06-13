// SPIKE: does browxai's DOM-walk PAGE_SCRIPT return the DomWalkEntry shape under
// WebDriver Classic execute/sync on real Safari, the same as Playwright frame.evaluate?
// This is RFC 0002 open-question #7 — the load-bearing feasibility of a Safari snapshot substrate.
import { readFileSync } from "node:fs";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// repo root = four levels up from docs/rfcs/references/safari-probe/
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const BASE = "http://localhost:4444";

// Extract the EXACT runtime PAGE_SCRIPT string from source (eval the template literal
// so \\s source-escapes become the real \s the browser sees).
const src = readFileSync(`${REPO}/src/page/dom-walk.ts`, "utf8");
const m = src.match(/const PAGE_SCRIPT = (`[\s\S]*?`);/);
if (!m) {
  console.log("FATAL: could not extract PAGE_SCRIPT");
  process.exit(1);
}
const PAGE_SCRIPT = eval(m[1]); // our own source; no ${} interpolation in this literal
console.log(
  "PAGE_SCRIPT extracted:",
  PAGE_SCRIPT.length,
  "chars; starts:",
  PAGE_SCRIPT.slice(0, 40),
);

async function http(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

const FIXTURE =
  "data:text/html," +
  encodeURIComponent(
    `<!doctype html><html><body>
      <h1>Spike</h1>
      <button data-testid="go" aria-label="Go now">Go</button>
      <input id="q" placeholder="search">
      <a href="https://example.com/x">a link</a>
      <div role="tab" data-test="t1">Tab One</div>
      <select><option>one</option></select>
    </body></html>`,
  );

async function main() {
  const s = await http("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "safari" } },
  });
  const sid = s.value?.sessionId;
  if (!sid) {
    console.log("no session", JSON.stringify(s));
    return;
  }
  try {
    await http("POST", `/session/${sid}/url`, { url: FIXTURE });

    // Invoke PAGE_SCRIPT exactly as the substrate would: function body returns (script)(args).
    const script = `return (${PAGE_SCRIPT})(arguments[0], arguments[1], arguments[2]);`;
    const r = await http("POST", `/session/${sid}/execute/sync`, {
      script,
      args: [["data-testid", "data-test", "data-cy", "data-qa"], 500, true],
    });
    const entries = r.value;

    console.log("\n=== execute/sync returned ===");
    if (!Array.isArray(entries)) {
      console.log("NOT AN ARRAY:", JSON.stringify(r).slice(0, 300));
      return;
    }
    console.log(`entries: ${entries.length}`);
    for (const e of entries) {
      console.log(
        `  role=${JSON.stringify(e.role)} name=${JSON.stringify(e.name)} testId=${JSON.stringify(e.testId)} tag=${e.tag} cssPath=${JSON.stringify(e.cssPath)}`,
      );
    }

    // Verdict checks — same signal the Playwright substrate relies on.
    const keys = ["role", "name", "testId", "testIdAttr", "tag", "id", "structuralPath", "cssPath"];
    const shapeOk = entries.length > 0 && keys.every((k) => k in entries[0]);
    const testIdOk = entries.some((e) => e.testId === "go" && e.testIdAttr === "data-testid");
    const cssPathOk = entries.every((e) => typeof e.cssPath === "string" && e.cssPath.length > 0);
    const ariaNameOk = entries.some((e) => e.name === "Go now"); // aria-label wins
    console.log("\n=== VERDICT ===");
    console.log("shape matches DomWalkEntry:", shapeOk);
    console.log("testId captured (data-testid=go):", testIdOk);
    console.log("cssPath non-empty on all:", cssPathOk);
    console.log("aria-label name resolution:", ariaNameOk);
    console.log(
      shapeOk && testIdOk && cssPathOk && ariaNameOk
        ? "\n✅ SUBSTRATE FEASIBLE: PAGE_SCRIPT runs identically under Classic execute/sync."
        : "\n⚠️ DIVERGENCE: investigate before building the Safari substrate.",
    );
  } finally {
    await http("DELETE", `/session/${sid}`);
  }
}
main().catch((e) => console.log("FATAL", e.message));
