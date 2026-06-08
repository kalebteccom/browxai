// Phase 2.5 — browxai-managed config store.
//
// Precedence (lowest → highest):
//   built-in defaults < env (legacy BROWX_*) < user < project < session patch
//
// Persistent layers live in `<workspace>/config.json` as
// `{ "user": {...}, "project": {...} }` and are mutated ONLY via
// set_config / reset_config (the MCP tools). The file is machine-managed —
// a malformed file degrades to "ignore that layer + warn", never a crash.
//
// `workspace` (root path) is intentionally NOT config — it's the *location*
// the store itself lives at, resolved before the store exists.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logging.js";

/** Full resolved view consumed by the server. */
export interface ResolvedConfig {
  testAttributes: string[];
  capabilities: string[];
  confirmRequired: string[];
  allowedOrigins: string[];
  blockedOrigins: string[];
  headless: boolean;
  /** hard anti-wedge deadline (ms) applied to every action body /
   *  `eval_js` / read-CDP path. Default 5000. Per-call `timeoutMs` overrides.
   *  Clamped to [1, 3_600_000] at use. A real op completes well under this;
   *  raising it as a blanket masks no-ops/wedges. */
  actionTimeoutMs?: number;
  /** when true, `managed` / `incognito` sessions launch with
   *  `--disable-web-security --disable-site-isolation-trials` (SOP/CORS OFF
   *  browser-wide). Dangerous opt-in — off by default, loud-warned, and
   *  deliberately NOT mappable from the legacy env layer (set via MCP
   *  `set_config` or the managed config file only). No effect on
   *  `attached`/BYOB (externally launched). */
  disableWebSecurity?: boolean;
  /** default device-preset name for new sessions (Playwright device
   *  registry, e.g. "iPhone 14"). Overridable per `open_session`. */
  defaultDevice?: string;
  /** default viewport for new sessions. Overrides a preset's viewport
   *  when both are set. Overridable per `open_session`. */
  defaultViewport?: { width: number; height: number };
  /** CSS selectors for chrome/overlay elements (dev-build HMR widgets,
   *  devtools iframes, cookie/consent banners) that should be neutralised
   *  before the agent interacts with the page. A server-injected init
   *  script applies `pointer-events:none; display:none` to matches on every
   *  navigation — non-destructive (no node removal), config-driven, no
   *  agent JS. Default `[]` (feature off). */
  hideOverlaySelectors: string[];
  /** Phase 8 — declarative plugin set. Mirrors what `plugins.json`
   *  declares; persisted alongside other config so `set_config({plugins})`
   *  and `get_config({scope:"resolved"}).plugins` work without hand-editing
   *  the plugins.json file. Plugin lifecycle is RESOLVED ONCE AT SERVER
   *  START — `set_config` persists, but takes effect on next restart
   *  (mirrors `capabilities`). Empty array = "no plugins declared". */
  plugins: string[];
  /** Experimental / feature-flag knobs. Not stable; shallow-merged across layers. */
  unstable: Record<string, unknown>;
}

/** A partial override at one precedence layer. Every key optional. */
export type ConfigLayer = Partial<Omit<ResolvedConfig, "unstable">> & {
  unstable?: Record<string, unknown>;
};

export type PersistentScope = "user" | "project";
export type ConfigScope = "defaults" | "env" | PersistentScope | "session";

export const BUILTIN_DEFAULTS: ResolvedConfig = {
  testAttributes: ["data-testid", "data-test", "data-cy", "data-qa"],
  capabilities: ["read", "navigation", "action", "human"],
  confirmRequired: ["navigate_off_allowlist", "byob_action"],
  allowedOrigins: [],
  blockedOrigins: [],
  headless: false,
  hideOverlaySelectors: [],
  plugins: [],
  unstable: {},
};

const CONFIG_FILE = "config.json";

/** Legacy `BROWX_*` env vars as a low-precedence layer (above defaults). */
export function envLayer(env: NodeJS.ProcessEnv = process.env): ConfigLayer {
  const layer: ConfigLayer = {};
  const list = (v?: string) =>
    v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const ta = list(env.BROWX_TEST_ATTRIBUTES?.trim());
  if (ta) layer.testAttributes = ta;
  const caps = list(env.BROWX_CAPABILITIES?.trim());
  if (caps) layer.capabilities = caps;
  const cr = list(env.BROWX_CONFIRM_REQUIRED?.trim());
  if (cr) layer.confirmRequired = cr;
  const ao = list(env.BROWX_ALLOWED_ORIGINS?.trim());
  if (ao) layer.allowedOrigins = ao;
  const bo = list(env.BROWX_BLOCKED_ORIGINS?.trim());
  if (bo) layer.blockedOrigins = bo;
  const hl = env.BROWX_HEADLESS?.trim();
  if (hl) layer.headless = hl === "1" || hl.toLowerCase() === "true";
  const hos = list(env.BROWX_HIDE_OVERLAY_SELECTORS?.trim());
  if (hos) layer.hideOverlaySelectors = hos;
  return layer;
}

interface PersistedFile {
  user?: ConfigLayer;
  project?: ConfigLayer;
}

export class ConfigStore {
  private filePath: string;
  private persisted: PersistedFile = {};
  private env: ConfigLayer;

  constructor(workspaceRoot: string, env: NodeJS.ProcessEnv = process.env) {
    this.filePath = join(workspaceRoot, CONFIG_FILE);
    this.env = envLayer(env);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedFile;
      // Defensive: only accept the two known sections; ignore anything else.
      this.persisted = {
        ...(raw.user && typeof raw.user === "object" ? { user: raw.user } : {}),
        ...(raw.project && typeof raw.project === "object" ? { project: raw.project } : {}),
      };
    } catch (e) {
      log.warn(`config: ${CONFIG_FILE} is malformed — ignoring persistent layers`, {
        error: e instanceof Error ? e.message : String(e),
      });
      this.persisted = {};
    }
  }

  private save(): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(this.persisted, null, 2) + "\n", "utf8");
    } catch (e) {
      log.warn(`config: failed to write ${CONFIG_FILE}`, {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** Merge one layer onto an accumulator. Arrays replace; unstable shallow-merges. */
  private static apply(acc: ResolvedConfig, layer: ConfigLayer | undefined): ResolvedConfig {
    if (!layer) return acc;
    return {
      testAttributes: layer.testAttributes ?? acc.testAttributes,
      capabilities: layer.capabilities ?? acc.capabilities,
      confirmRequired: layer.confirmRequired ?? acc.confirmRequired,
      allowedOrigins: layer.allowedOrigins ?? acc.allowedOrigins,
      blockedOrigins: layer.blockedOrigins ?? acc.blockedOrigins,
      headless: layer.headless ?? acc.headless,
      actionTimeoutMs: layer.actionTimeoutMs ?? acc.actionTimeoutMs,
      disableWebSecurity: layer.disableWebSecurity ?? acc.disableWebSecurity,
      defaultDevice: layer.defaultDevice ?? acc.defaultDevice,
      defaultViewport: layer.defaultViewport ?? acc.defaultViewport,
      hideOverlaySelectors: layer.hideOverlaySelectors ?? acc.hideOverlaySelectors,
      plugins: layer.plugins ?? acc.plugins,
      unstable: layer.unstable ? { ...acc.unstable, ...layer.unstable } : acc.unstable,
    };
  }

  /** Resolve the full config. `sessionPatch` is the highest-precedence layer. */
  resolve(sessionPatch?: ConfigLayer): ResolvedConfig {
    let acc: ResolvedConfig = { ...BUILTIN_DEFAULTS, unstable: { ...BUILTIN_DEFAULTS.unstable } };
    acc = ConfigStore.apply(acc, this.env);
    acc = ConfigStore.apply(acc, this.persisted.user);
    acc = ConfigStore.apply(acc, this.persisted.project);
    acc = ConfigStore.apply(acc, sessionPatch);
    return acc;
  }

  /** Inspect one layer (raw, pre-merge) — for `get_config({ scope })`. */
  getLayer(scope: ConfigScope): ConfigLayer | ResolvedConfig {
    switch (scope) {
      case "defaults": return BUILTIN_DEFAULTS;
      case "env": return this.env;
      case "user": return this.persisted.user ?? {};
      case "project": return this.persisted.project ?? {};
      case "session": return {}; // session config isn't held here; it's per open_session
    }
  }

  /** Persist a patch into `user` or `project`. The only writer of config.json. */
  setLayer(scope: PersistentScope, patch: ConfigLayer): void {
    const current = this.persisted[scope] ?? {};
    this.persisted[scope] = {
      ...current,
      ...patch,
      ...(patch.unstable
        ? { unstable: { ...(current.unstable ?? {}), ...patch.unstable } }
        : {}),
    };
    this.save();
    log.info(`config: set scope="${scope}"`, { keys: Object.keys(patch) });
  }

  /** Clear a persistent layer entirely. */
  resetLayer(scope: PersistentScope): void {
    delete this.persisted[scope];
    this.save();
    log.info(`config: reset scope="${scope}"`);
  }
}

/**
 * Adapter: render a `ResolvedConfig` as an env-shaped record so the existing
 * env-driven resolvers (`resolveCapabilities` / `resolveOriginPolicy` /
 * `resolveConfirmHooks` / `resolveConfig`) can consume the *fully resolved*
 * precedence chain without each being rewritten. Precedence is already applied
 * in `ConfigStore.resolve()`; this just re-expresses the result in the shape
 * those functions parse.
 */
export function resolvedToEnv(c: ResolvedConfig): NodeJS.ProcessEnv {
  return {
    BROWX_TEST_ATTRIBUTES: c.testAttributes.join(","),
    BROWX_CAPABILITIES: c.capabilities.join(","),
    BROWX_CONFIRM_REQUIRED: c.confirmRequired.join(","),
    BROWX_ALLOWED_ORIGINS: c.allowedOrigins.join(","),
    BROWX_BLOCKED_ORIGINS: c.blockedOrigins.join(","),
    BROWX_HEADLESS: c.headless ? "1" : "",
  };
}
