// The operator's policy ceiling. `set_config` is an MCP tool, so the agent can
// call it, and a saved layer outlives the session that wrote it. Every key that
// loosens policy is therefore bounded by what the server's environment (or the
// built-in default, when the env leaves a key unset) allows. A saved or session
// layer can tighten each key and never loosen it:
//
//   capabilities        subset of the ceiling
//   confirmRequired     superset of the ceiling (hooks can be added, not removed),
//                       except a hook whose absence is stricter
//                       (`STRICTER_WHEN_ABSENT`): that one can be removed and
//                       never added past the ceiling
//   allowedOrigins      subset of a non-empty ceiling; an empty or disjoint list
//                       falls back to the ceiling (empty would mean "anywhere")
//   blockedOrigins      superset of the ceiling
//   disableWebSecurity  can be true only when the env turned it on
//   plugins             subset of the ceiling
//   chromiumSandbox     at least the ceiling's level, where off < auto < on. With
//                       no BROWX_CHROMIUM_SANDBOX the ceiling is auto, so a saved
//                       layer can ask for on and cannot turn the sandbox off.
//
// Origins compare as exact strings. A saved `https://a.example.com` does not
// narrow an env `https://*.example.com`; list the narrower origin in the env.

import { sandboxBelow, type ChromiumSandboxMode } from "./chromium-sandbox.js";

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
import type { ConfigLayer, ResolvedConfig } from "./config-store.js";
import { STRICTER_WHEN_ABSENT } from "./capabilities.js";

const stricterWhenAbsent = (hook: string): boolean =>
  (STRICTER_WHEN_ABSENT as readonly string[]).includes(hook);

/** Hooks are added freely and never removed, except a stricter-when-absent
 *  hook, which survives only when both the ceiling and the config hold it. */
function clampHooks(ceiling: readonly string[], wanted: readonly string[]): string[] {
  return union(ceiling, wanted).filter(
    (h) => !stricterWhenAbsent(h) || (ceiling.includes(h) && wanted.includes(h)),
  );
}

export interface PolicyCeiling {
  capabilities: readonly string[];
  confirmRequired: readonly string[];
  allowedOrigins: readonly string[];
  blockedOrigins: readonly string[];
  disableWebSecurity: boolean;
  plugins: readonly string[];
  chromiumSandbox: ChromiumSandboxMode;
}

/** Build the ceiling from the env layer, falling back to `defaults`. */
export function policyCeiling(env: ConfigLayer, defaults: ResolvedConfig): PolicyCeiling {
  return {
    capabilities: env.capabilities ?? defaults.capabilities,
    confirmRequired: env.confirmRequired ?? defaults.confirmRequired,
    allowedOrigins: env.allowedOrigins ?? defaults.allowedOrigins,
    blockedOrigins: env.blockedOrigins ?? defaults.blockedOrigins,
    disableWebSecurity: env.disableWebSecurity === true,
    plugins: env.plugins ?? defaults.plugins,
    chromiumSandbox: env.chromiumSandbox ?? defaults.chromiumSandbox ?? "auto",
  };
}

/** Bound a merged config by the ceiling. */
export function clampPolicy(c: ResolvedConfig, ceil: PolicyCeiling): ResolvedConfig {
  const capCeiling = new Set(ceil.capabilities);
  const plugins = new Set(ceil.plugins);
  let allowedOrigins = c.allowedOrigins;
  if (ceil.allowedOrigins.length > 0) {
    const allowed = new Set(ceil.allowedOrigins);
    const inside = c.allowedOrigins.filter((o) => allowed.has(o));
    allowedOrigins = inside.length > 0 ? inside : [...ceil.allowedOrigins];
  }
  const out: ResolvedConfig = {
    ...c,
    capabilities: c.capabilities.filter((x) => capCeiling.has(x)),
    confirmRequired: clampHooks(ceil.confirmRequired, c.confirmRequired),
    allowedOrigins,
    blockedOrigins: union(ceil.blockedOrigins, c.blockedOrigins),
    plugins: c.plugins.filter((p) => plugins.has(p)),
  };
  if (ceil.disableWebSecurity && c.disableWebSecurity !== false) out.disableWebSecurity = true;
  else delete out.disableWebSecurity;
  const sandbox = c.chromiumSandbox ?? ceil.chromiumSandbox;
  out.chromiumSandbox = sandboxBelow(sandbox, ceil.chromiumSandbox)
    ? ceil.chromiumSandbox
    : sandbox;
  return out;
}

/** What a patch would loosen past the ceiling, per key. Empty when the patch
 *  only tightens. `capabilities` is checked by the caller against the live set. */
export function policyWidening(patch: ConfigLayer, ceil: PolicyCeiling): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const missing = (need: readonly string[], have: readonly string[]) =>
    need.filter((x) => !have.includes(x));
  if (patch.confirmRequired) {
    const removed = missing(ceil.confirmRequired, patch.confirmRequired).filter(
      (h) => !stricterWhenAbsent(h),
    );
    const added = missing(patch.confirmRequired, ceil.confirmRequired).filter(stricterWhenAbsent);
    if (removed.length || added.length) out.confirmRequired = [...removed, ...added];
  }
  if (patch.allowedOrigins && ceil.allowedOrigins.length > 0) {
    if (patch.allowedOrigins.length === 0) out.allowedOrigins = ["(empty list: any origin)"];
    else {
      const extra = missing(patch.allowedOrigins, ceil.allowedOrigins);
      if (extra.length) out.allowedOrigins = extra;
    }
  }
  if (patch.blockedOrigins) {
    const removed = missing(ceil.blockedOrigins, patch.blockedOrigins);
    if (removed.length) out.blockedOrigins = removed;
  }
  if (patch.disableWebSecurity === true && !ceil.disableWebSecurity)
    out.disableWebSecurity = [true];
  if (patch.plugins) {
    const extra = missing(patch.plugins, ceil.plugins);
    if (extra.length) out.plugins = extra;
  }
  if (patch.chromiumSandbox && sandboxBelow(patch.chromiumSandbox, ceil.chromiumSandbox))
    out.chromiumSandbox = [patch.chromiumSandbox];
  return out;
}

/** Keys where `clamped` differs from `raw`, for the startup warning. */
export function policyAdjustments(raw: ResolvedConfig, clamped: ResolvedConfig): string[] {
  const keys = [
    "capabilities",
    "confirmRequired",
    "allowedOrigins",
    "blockedOrigins",
    "disableWebSecurity",
    "plugins",
    "chromiumSandbox",
  ] as const;
  return keys.filter((k) => JSON.stringify(raw[k] ?? null) !== JSON.stringify(clamped[k] ?? null));
}
