import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ActionHost,
  ConfigHost,
  ServerServicesHost,
} from "./host.js";
import { registerActionCoreTools } from "./action-core-tools.js";
import { registerActionGestureTools } from "./action-gesture-tools.js";
import { registerActionFormTools } from "./action-form-tools.js";
import { registerActionHistoryTools } from "./action-history-tools.js";

/**
 * Navigation + core action tools — the verbs an agent drives a page with:
 * navigate / click / fill / press / shortcut / drag / double_click / hover /
 * select / wait_for / scroll / choose_option / go_back / go_forward /
 * set_viewport.
 *
 * RFC 0004 P3 / D3 (SRP) + D4 (DRY): the registrations were split by cohesive
 * family into four sibling modules (core / gesture / form / history), and the four
 * canonical confirm-gated target-resolving handlers (click / fill / hover /
 * select) now ride the `actionTool` wrapper. This module stays the single entry
 * point `server.ts` + `tool-metadata.ts` call, and invokes each family in the
 * EXACT prior source order so the registered-name set + the derived maps stay
 * byte-identical.
 *
 * The parameter is narrowed to the sub-ports this family touches (RFC 0004 P3 /
 * D3 ISP) — the signature compiles a guarantee that the action family reaches
 * nothing outside gating, session resolution, action dispatch, and config.
 */
export function registerActionTools(
  host: RegisterHost & GateHost & SessionHost & ActionHost & ConfigHost & ServerServicesHost,
): void {
  registerActionCoreTools(host);
  registerActionGestureTools(host);
  registerActionFormTools(host);
  registerActionHistoryTools(host);
}
