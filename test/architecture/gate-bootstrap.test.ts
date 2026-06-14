// L1 (fail-safe) — the capability + engine gate must NEVER fail OPEN on an
// empty, unbootstrapped derived map (RFC 0004 P2 / D1, SECURITY-CRITICAL).
//
// The hazard: `TOOL_CAPABILITY` (src/util/capabilities.ts) and `DEEP_TOOLS`
// (src/engine/tool-gate.ts) are DERIVED maps populated by the tools-layer
// bootstrap (src/tools/tool-metadata.ts) — eagerly on import, or lazily on the
// first read once a collector is installed. A consumer that reads the gate
// WITHOUT ever reaching that bootstrap (no package-entry import, no createServer)
// used to get an EMPTY map, and the gate failed OPEN:
//   - isToolEnabled("eval_js", resolveCapabilities("read")) === true  (un-gated!)
//   - assertEngineSupports("perf_start","firefox")          === null  (un-gated!)
// un-gating eval_js / register_secret / network_body and the entire engine gate.
//
// This test LOCKS the regression: in a genuinely fresh module context (a child
// `tsx` process, so the bootstrap truly has not run — a same-process dynamic
// import cannot guarantee that, because a sibling test in this worker may have
// already loaded the bootstrap and populated the module-level maps), reading the
// gate must NOT silently open. The fail-safe throws a structured error instead.
//
// A POSITIVE control (second child) proves the throw is the fail-safe and not a
// load error: importing the bootstrap first makes the SAME reads succeed and gate
// correctly (eval_js disabled under read-only; perf_start refused on firefox).

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const CAPS = join(REPO_ROOT, "src", "util", "capabilities.ts").replace(/\\/g, "/");
const GATE = join(REPO_ROOT, "src", "engine", "tool-gate.ts").replace(/\\/g, "/");
const BOOTSTRAP = join(REPO_ROOT, "src", "tools", "tool-metadata.ts").replace(/\\/g, "/");
const TSX = join(REPO_ROOT, "node_modules", ".bin", "tsx");

/** Run `source` as a fresh `tsx` child and return its trimmed stdout. The child
 *  is a brand-new module registry — the gate modules load with NO bootstrap
 *  unless the source imports it explicitly. */
function runChild(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "browxai-gate-bootstrap-"));
  const file = join(dir, "probe.mts");
  writeFileSync(file, source);
  return execFileSync(TSX, [file], {
    encoding: "utf8",
    timeout: 60_000,
    // Keep the child hermetic: no inherited BROWX_* capability config skews the
    // read (resolveCapabilities defaults are enough to exercise the gate).
    env: { ...process.env, BROWX_CAPABILITIES: "read" },
  }).trim();
}

describe("L1 — the capability/engine gate fails SAFE on an unbootstrapped map (D1)", () => {
  it("a fresh import of ONLY the gate modules (no bootstrap, no createServer) does NOT fail open", () => {
    // The child imports ONLY the two leaf gate modules — never the bootstrap and
    // never createServer. Each read is wrapped: the FAIL-SAFE outcome is a throw;
    // a silent `true` / `null` is the FAIL-OPEN regression we forbid.
    const source = `
      import { isToolEnabled, resolveCapabilities } from "${CAPS}";
      import { assertEngineSupports } from "${GATE}";

      const out = { capability: "", engine: "" };

      try {
        const caps = resolveCapabilities({ BROWX_CAPABILITIES: "read" });
        const enabled = isToolEnabled("eval_js", caps);
        // Reached here => the gate answered from an empty map => FAIL OPEN.
        out.capability = enabled === true ? "FAIL_OPEN_TRUE" : "answered_" + String(enabled);
      } catch (e) {
        out.capability = "FAIL_SAFE_THROW:" + (e instanceof Error ? e.message : String(e));
      }

      try {
        const refusal = assertEngineSupports("perf_start", "firefox");
        out.engine = refusal === null ? "FAIL_OPEN_NULL" : "refused";
      } catch (e) {
        out.engine = "FAIL_SAFE_THROW:" + (e instanceof Error ? e.message : String(e));
      }

      process.stdout.write(JSON.stringify(out));
    `;
    const result = JSON.parse(runChild(source)) as { capability: string; engine: string };

    // The OLD fail-open code returned true / null here; the fail-safe throws.
    expect(result.capability).not.toBe("FAIL_OPEN_TRUE");
    expect(result.capability.startsWith("FAIL_SAFE_THROW:")).toBe(true);
    // The throw must name the hazard so the misconfiguration is actionable.
    expect(result.capability).toContain("bootstrap");
    expect(result.capability).toMatch(/fail OPEN|eval_js/i);

    expect(result.engine).not.toBe("FAIL_OPEN_NULL");
    expect(result.engine.startsWith("FAIL_SAFE_THROW:")).toBe(true);
    expect(result.engine).toContain("bootstrap");
  });

  it("POSITIVE control: with the bootstrap imported first, the SAME reads succeed and gate correctly", () => {
    // Proves the throw above is the fail-safe (not a load error): importing the
    // bootstrap eagerly populates the maps, so the gate answers — and gates.
    const source = `
      import "${BOOTSTRAP}";
      import { isToolEnabled, resolveCapabilities } from "${CAPS}";
      import { assertEngineSupports } from "${GATE}";

      const caps = resolveCapabilities({ BROWX_CAPABILITIES: "read" });
      const out = {
        evalGated: isToolEnabled("eval_js", caps) === false,     // read-only => off
        snapshotEnabled: isToolEnabled("snapshot", caps) === true,
        perfRefusedOnFirefox: assertEngineSupports("perf_start", "firefox") !== null,
      };
      process.stdout.write(JSON.stringify(out));
    `;
    const result = JSON.parse(runChild(source)) as {
      evalGated: boolean;
      snapshotEnabled: boolean;
      perfRefusedOnFirefox: boolean;
    };
    expect(result.evalGated).toBe(true);
    expect(result.snapshotEnabled).toBe(true);
    expect(result.perfRefusedOnFirefox).toBe(true);
  });
});
