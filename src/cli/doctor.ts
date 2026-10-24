// `browxai doctor` — environment + connectivity health-check ().
//
// Prints a short summary by default: one ✓/✗ line per area, failures first, each
// with its next step. `--verbose` prints every row (− marks purely informational
// rows, which get an `enable with:` line when their lane is not ready; ⚠ marks a
// warning with a fix line, which never fails doctor). Exits 0 iff no check
// fails, 1 otherwise, 2 for a bad flag. Writes to stdout (this is a CLI
// subcommand, not the MCP server — stdout is fine here).

import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfirmHooks, type Capability } from "../util/capabilities.js";
import { resolveConfig } from "../util/config.js";
import { resolveOriginPolicy, describePolicy } from "../policy/origin.js";
import { resolveWorkspace } from "../util/workspace.js";
import { PACKAGE_VERSION } from "../util/version.js";
import { ConfigStore } from "../util/config-store.js";
import { pluginChecks } from "./doctor-plugins.js";
import { probeCdp } from "./doctor-cdp.js";
import { attachCapabilityCheck } from "./doctor-attach.js";
import { capabilitiesRow } from "./doctor-capabilities.js";
import {
  chromeCheck,
  chromiumCheck,
  firefoxCheck,
  webkitCheck,
  androidCheck,
  safariCheck,
  electronCheck,
} from "./doctor-engines.js";
import {
  IMPLEMENTED_ENGINES,
  resolveEngineSelection,
  UnknownEngineError,
  type EngineKind,
} from "../engine/index.js";
import { docsUrl } from "../util/docs-links.js";
import { formatDoctor } from "./doctor-summary.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
  /** How to turn on an opt-in lane that is not ready. Printed as `enable with:`
   *  under an informational row, and only when the row sets it. */
  enable?: string;
  /** Informational row — printed with − instead of ✓/✗; never fails doctor. */
  info?: boolean;
  /** Warning row: ok, so it never fails doctor, but printed with ⚠ and its
   *  `fix` line. */
  warn?: boolean;
}

export async function runDoctor(args: readonly string[] = []): Promise<number> {
  const opts = parseDoctorArgs(args);
  if (!opts) {
    process.stderr.write(
      "usage: browxai doctor [--verbose]\n  --verbose   print every check, including the opt-in engines\n",
    );
    return 2;
  }
  const checks: Check[] = [];

  // 0. Node version. package.json `engines` is >=22; npm only warns on a
  // mismatch, so doctor is where an older Node gets named.
  const nodeVersion = process.versions.node;
  if (Number(nodeVersion.split(".")[0]) >= 22) {
    checks.push({ name: "node", ok: true, detail: `v${nodeVersion}` });
  } else {
    checks.push({
      name: "node",
      ok: false,
      detail: `v${nodeVersion}, browxai needs Node 22 or later`,
      fix: "install Node 22 or later (nodejs.org, or `nvm install 22`) and reinstall browxai",
    });
  }

  // 1. dist/cli.js built? The age only means something in a source checkout,
  // where a stale build is a real failure mode. An installed package ships
  // dist/ and no src/, and doctor is already running from it, so it gets no row.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distCli = resolve(__dirname, "../cli.js");
  const isSourceCheckout = existsSync(resolve(__dirname, "../../src/cli.ts"));
  if (existsSync(distCli)) {
    if (isSourceCheckout) {
      const age = Math.floor((Date.now() - statSync(distCli).mtimeMs) / 86_400_000);
      checks.push({ name: "build", ok: true, detail: `dist/cli.js exists (${age}d old)` });
    }
  } else {
    checks.push({
      name: "build",
      ok: false,
      detail: `dist/cli.js missing at ${distCli}`,
      fix: "reinstall browxai (`npm install -g browxai`), or run `pnpm build` in a source checkout",
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
        detail: `BROWX_ATTACH_CDP unset, but a Chrome is reachable at 127.0.0.1:9222 (${reachable.version}). To attach to it, use the \`browxai-attached\` MCP entry that \`browxai init\` writes.`,
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
  const capabilities = capabilitiesRow();
  const enabledCapabilities: ReadonlySet<Capability> = capabilities.enabled;
  checks.push(capabilities.row);
  if (capabilities.row.ok) {
    const attachWarn = attachCapabilityCheck(cdpEnv, enabledCapabilities);
    if (attachWarn) checks.push(attachWarn);
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
      fix: "fix BROWX_CONFIRM_REQUIRED — see " + docsUrl.threatModel,
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

  // 8. Browser for managed mode. The default launch uses the installed Google
  // Chrome and falls back to the bundled Chromium, so doctor fails only when
  // neither exists. 8a2/8a3 follow with the opt-in firefox + webkit binary
  // probes. All are per-engine availability probes — see
  // src/cli/doctor-engines.ts.
  const chrome = chromeCheck();
  checks.push(chrome);
  checks.push(await chromiumCheck(!chrome.info));
  checks.push(await firefoxCheck());
  checks.push(await webkitCheck());

  // 8a4. Android availability (opt-in fourth engine — `browserType:"android"`).
  // The full-fidelity real-profile BYOB lane: real Chrome-on-Android over adb +
  // CDP. Informational — Android is opt-in + needs a physically
  // connected device, so a missing adb / no device / closed Chrome NEVER fails
  // doctor; it just reports how far the chain reaches (adb present → device ready
  // → Chrome socket reachable). Probes without opening a session: lists devices,
  // and if one is ready, forwards the socket + probes /json/version, then removes
  // the forward.
  checks.push(await androidCheck());

  // 8a4b. Safari availability (opt-in engine, macOS only). Informational: a
  // missing safaridriver or a non-macOS host reports how to enable it and never
  // fails doctor.
  checks.push(safariCheck());

  // 8a5. Electron availability (opt-in attach-only engine — a running desktop
  // Electron app over its `--remote-debugging-port`). Informational, and it
  // exists because this lane's whole risk is the operator not being sure what
  // BROWX_ATTACH_CDP points at. Reads `/json/version` off the endpoint and names
  // the app + Electron version from the protocol; opens no session and holds no
  // CDP handle. Unset endpoint, unreachable endpoint, and "that is ordinary
  // Chrome" are all reported states, never failures.
  checks.push(await electronCheck());

  // 8b. SELECTED browser engine. Resolves the operator's choice exactly as the
  // MCP server does: explicit `--engine <kind>` > `BROWX_ENGINE` env > default
  // chromium (see src/engine/select.ts). Reports which engine the server WOULD
  // run on, and points at the per-engine availability row above (chromium /
  // firefox / webkit / android / safari / electron — those checks always run) so
  // the operator can see the selected engine's readiness in one glance. Chromium + Firefox + WebKit +
  // Android are wired; the seam lets each engine be an adapter (see src/engine/).
  // An invalid selection is reported here (and never fails doctor — it's the same
  // structured "implemented engines: …" message the server prints, surfaced as a
  // ✗ so the operator sees it). Informational otherwise.
  let selectedEngine: EngineKind = "chromium";
  let engineSelectionError: string | undefined;
  try {
    selectedEngine = resolveEngineSelection(process.argv.slice(2)) ?? "chromium";
  } catch (e) {
    engineSelectionError =
      e instanceof UnknownEngineError ? e.message : e instanceof Error ? e.message : String(e);
  }
  if (engineSelectionError) {
    checks.push({
      name: "engine",
      ok: false,
      detail: engineSelectionError,
      fix: `set BROWX_ENGINE (or --engine) to one of: ${IMPLEMENTED_ENGINES.join(", ")}`,
    });
  } else {
    const explicit =
      !!process.env.BROWX_ENGINE?.trim() ||
      process.argv.slice(2).some((a) => a === "--engine" || a.startsWith("--engine="));
    // The availability row matching the selected engine ran above (chromium ✓,
    // firefox/webkit/android −). Name it so doctor's engine line is self-contained.
    const readinessRow =
      selectedEngine === "chromium"
        ? "see `chromium` row above"
        : `see \`${selectedEngine}\` row above`;
    checks.push({
      name: "engine",
      ok: true,
      info: true,
      detail:
        `${selectedEngine}${explicit ? "" : " (default)"} — ${readinessRow}; ` +
        `implemented: ${IMPLEMENTED_ENGINES.join(", ")}`,
    });
  }

  // 9. Plugins — declaration / install drift / lock health / manifest
  // sanity. Pure inspection of the same files the runtime's resolution
  // stage reads; doctor NEVER executes a plugin's register module.
  try {
    const ws = resolveWorkspace();
    const store = new ConfigStore(ws.root);
    checks.push(
      ...pluginChecks({
        workspaceRoot: ws.root,
        enabledCapabilities,
        extraDeclared: store.resolve().plugins,
      }),
    );
  } catch (e) {
    checks.push({
      name: "plugins",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: "inspect <workspace>/plugins.json, plugins-lock.json and plugins/node_modules/ by hand",
    });
  }

  // Print + exit.
  const { text, allOk } = formatDoctor(checks, { verbose: opts.verbose, version: PACKAGE_VERSION });
  process.stdout.write(text);
  return allOk ? 0 : 1;
}

interface DoctorOpts {
  verbose: boolean;
}

function parseDoctorArgs(args: readonly string[]): DoctorOpts | null {
  let verbose = false;
  for (const a of args) {
    if (a === "--verbose") verbose = true;
    else return null;
  }
  return { verbose };
}
