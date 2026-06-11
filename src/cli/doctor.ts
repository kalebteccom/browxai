// `browxai doctor` — environment + connectivity health-check ().
//
// Prints a ✓/✗ checklist + one-line fix per failing check. Exits 0 iff everything
// passes, 1 otherwise. Writes to stdout (this is a CLI subcommand, not the MCP
// server — stdout is fine here).

import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveCapabilities,
  resolveConfirmHooks,
  DEFAULT_CAPABILITIES,
} from "../util/capabilities.js";
import { resolveConfig } from "../util/config.js";
import { resolveOriginPolicy, describePolicy } from "../policy/origin.js";
import { resolveWorkspace } from "../util/workspace.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export async function runDoctor(): Promise<number> {
  const checks: Check[] = [];

  // 1. dist/cli.js built?
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distCli = resolve(__dirname, "../cli.js");
  if (existsSync(distCli)) {
    const age = Math.floor((Date.now() - statSync(distCli).mtimeMs) / 86_400_000);
    checks.push({ name: "build", ok: true, detail: `dist/cli.js exists (${age}d old)` });
  } else {
    checks.push({
      name: "build",
      ok: false,
      detail: `dist/cli.js missing at ${distCli}`,
      fix: "run `pnpm build`",
    });
  }

  // 2. $BROWX_WORKSPACE writable?
  try {
    const ws = resolveWorkspace();
    const probe = ws.sub("doctor-probe");
    if (existsSync(probe)) {
      checks.push({ name: "workspace", ok: true, detail: `${ws.root} (writable)` });
    } else {
      checks.push({
        name: "workspace",
        ok: false,
        detail: `${ws.root} couldn't create subdir`,
        fix: "check permissions; set BROWX_WORKSPACE to a writable dir",
      });
    }
  } catch (e) {
    checks.push({
      name: "workspace",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: "set BROWX_WORKSPACE to an absolute path you own",
    });
  }

  // 3. BROWX_TEST_ATTRIBUTES configured (default or explicit).
  const config = resolveConfig();
  const explicit = !!process.env.BROWX_TEST_ATTRIBUTES;
  checks.push({
    name: "test-attrs",
    ok: true,
    detail: `${config.testAttributes.join(",")}${explicit ? " (BROWX_TEST_ATTRIBUTES set)" : " (default)"}`,
    fix: explicit
      ? undefined
      : "set BROWX_TEST_ATTRIBUTES if your codebase uses non-default conventions (e.g. add `data-type`)",
  });

  // 4. BROWX_ATTACH_CDP — if set, can we reach it?
  const cdpEnv = process.env.BROWX_ATTACH_CDP?.trim();
  if (cdpEnv) {
    const reachable = await probeCdp(cdpEnv);
    checks.push({
      name: "cdp-attach",
      ok: reachable.ok,
      detail: reachable.ok
        ? `${cdpEnv} reachable — ${reachable.version}`
        : `${cdpEnv} unreachable (${reachable.error})`,
      fix: reachable.ok
        ? undefined
        : "start a Chrome at this port — `browxai chrome start` or `chrome --remote-debugging-port=9222 …`",
    });
  } else {
    // Not configured. Probe the default port anyway — adopters with a Chrome
    // already running may want to be told "you could attach to that, you know."
    const reachable = await probeCdp("http://127.0.0.1:9222");
    if (reachable.ok) {
      checks.push({
        name: "cdp-attach",
        ok: true,
        detail: `BROWX_ATTACH_CDP unset, but a Chrome is reachable at 127.0.0.1:9222 (${reachable.version}). Use the \`browxai-attached\` MCP entry to attach.`,
      });
    } else {
      checks.push({
        name: "cdp-attach",
        ok: true,
        detail: "BROWX_ATTACH_CDP unset — managed-mode default. No --cdp Chrome to attach to.",
      });
    }
  }

  // 5. Capabilities ( security model).
  try {
    const c = resolveCapabilities();
    const explicit = !!process.env.BROWX_CAPABILITIES;
    const dangerous = [...c.enabled].filter((x) => x === "eval" || x === "byob-attach");
    const detail = `enabled=[${[...c.enabled].join(", ")}]${explicit ? "" : " (default)"}${dangerous.length ? "  ⚠ dangerous: " + dangerous.join(", ") : ""}`;
    checks.push({
      name: "capabilities",
      ok: true,
      detail,
      fix: dangerous.length
        ? `${dangerous.join(",")} on — page text remains untrusted; review docs/threat-model.md`
        : explicit
          ? undefined
          : "see docs/threat-model.md for the full set; default is " +
            DEFAULT_CAPABILITIES.join(","),
    });
  } catch (e) {
    checks.push({
      name: "capabilities",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: "fix BROWX_CAPABILITIES (comma-separated, see docs/threat-model.md)",
    });
  }

  // 6. Confirm-required hooks.
  try {
    const hooks = resolveConfirmHooks();
    checks.push({
      name: "confirm-hooks",
      ok: true,
      detail: hooks.size > 0 ? `[${[...hooks].join(", ")}]` : "(none)",
    });
  } catch (e) {
    checks.push({
      name: "confirm-hooks",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: "fix BROWX_CONFIRM_REQUIRED — see docs/threat-model.md",
    });
  }

  // 7. Origin policy.
  try {
    const policy = resolveOriginPolicy();
    const noAllowlist = policy.allowed.length === 0;
    checks.push({
      name: "origins",
      ok: true,
      detail: describePolicy(policy),
      fix: noAllowlist
        ? "no allowlist set — defense-in-depth not engaged. Set BROWX_ALLOWED_ORIGINS for the navigation gate."
        : undefined,
    });
  } catch (e) {
    checks.push({
      name: "origins",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: "BROWX_ALLOWED_ORIGINS / BROWX_BLOCKED_ORIGINS: comma-separated absolute URLs (https://app.example.com or https://*.example.com)",
    });
  }

  // 8. Chromium installed (managed-mode dependency).
  try {
    // Lazy import so this command doesn't pay the playwright-core cost on bare invocation.
    const { chromium } = await import("playwright-core");
    const path = chromium.executablePath();
    if (path && existsSync(path)) {
      checks.push({ name: "chromium", ok: true, detail: `${path}` });
    } else {
      checks.push({
        name: "chromium",
        ok: false,
        detail: "playwright-core has no Chromium binary cached",
        fix: "run `pnpm install-browser`",
      });
    }
  } catch (e) {
    checks.push({
      name: "chromium",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: "run `pnpm install` and `pnpm install-browser`",
    });
  }

  // Print + exit.
  let allOk = true;
  process.stdout.write("browxai doctor — environment & connectivity\n\n");
  for (const c of checks) {
    if (!c.ok) allOk = false;
    process.stdout.write(`  ${c.ok ? "✓" : "✗"} ${c.name.padEnd(12)} ${c.detail}\n`);
    if (!c.ok && c.fix) process.stdout.write(`    fix: ${c.fix}\n`);
  }
  process.stdout.write(`\n${allOk ? "all checks passed" : "fix the ✗ items above"}\n`);
  return allOk ? 0 : 1;
}

async function probeCdp(
  endpoint: string,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const url = new URL(endpoint);
    const probeUrl = `${url.origin}/json/version`;
    const res = await fetch(probeUrl, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { Browser?: string };
    return { ok: true, version: body.Browser ?? "unknown" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
