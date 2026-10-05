// Guard for the tools that can replace an `ask-human` policy
// (`set_permission_policy`, `set_fs_picker_policy`, `set_notification_policy`,
// and `open_session` on a name that last held one).
//
// `ask-human` holds a page's permission request or file-picker call until a
// person answers on the human channel. Both setters are `action` tools, so
// without a guard the agent could switch the policy to `allow` and answer the
// prompt itself. A change that moves any key off `ask-human` is therefore the
// operator's call, behind the off-by-default `human-gate-override` capability.
//
// Pure function over the shape both policy modules share (a top-level mode plus
// a per-key override map), so the decision is unit-testable without a session.

export type PolicyModeName = "allow" | "deny" | "raise" | "ask-human";

export interface PolicyShape {
  mode: PolicyModeName;
  overrides?: Readonly<Record<string, PolicyModeName | undefined>>;
}

/** Effective mode of one key: its override when present, else the top-level mode. */
function effective(p: PolicyShape, key: string): PolicyModeName {
  return p.overrides?.[key] ?? p.mode;
}

/**
 * Keys that are `ask-human` under `current` and would be anything else under
 * `next`, plus `"*"` when the top-level default itself leaves `ask-human` (it
 * also covers names outside `supportedKeys`). Empty when the change keeps every
 * `ask-human` key in place, which includes the case where `current` has none.
 *
 * Keys are compared by effective mode, so a top-level change that un-asks a key
 * only covered by the old default is caught, and so is an override that
 * replaces a per-key `ask-human`.
 */
export function leavingAskHuman(
  current: PolicyShape,
  next: PolicyShape,
  supportedKeys: readonly string[],
): string[] {
  const moved: string[] = [];
  if (current.mode === "ask-human" && next.mode !== "ask-human") moved.push("*");
  for (const key of supportedKeys) {
    if (effective(current, key) === "ask-human" && effective(next, key) !== "ask-human") {
      moved.push(key);
    }
  }
  return moved;
}

/** Whether a policy holds anything for a human: the top-level mode or any
 *  per-key override is `ask-human`. */
export function holdsAskHuman(p: PolicyShape): boolean {
  return p.mode === "ask-human" || Object.values(p.overrides ?? {}).includes("ask-human");
}
