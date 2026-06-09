# Semver clock — the API-stable-clock

browxai is pre-1.0. The path to 1.0 runs through an "API stable ~1 week" clock that gates the public flip.

## What's frozen today (the stable surface)

- Tool names (every public tool in `docs/tool-reference.md`).
- Documented input shapes (Zod schemas).
- Documented output shapes (ActionResult fields).
- Default capability set (`read`, `navigation`, `action`, `human` on; everything else off).

Anything behind an off-by-default capability is **explicitly experimental** and not covered by the stable-surface guarantee.

## What resets the clock

- A change to a tool name.
- A removed / renamed required input field.
- A changed default for a documented input.
- A removed / renamed output field.
- A capability moved from default-on to off, or vice versa.

If you're not sure whether a change resets the clock, assume it does and discuss in the PR.

## What does NOT reset the clock

- Additive optional input fields (with documented defaults).
- Additive output fields.
- Behavior-only changes that preserve the documented contract.
- Changes behind an off-by-default capability.
- Bug fixes that bring behavior into line with documented contract.

## Decision matrix

| Change | Semver impact | Clock reset |
|---|---|---|
| New tool (default-on capability) | minor | yes |
| New tool (off-by-default capability) | minor | no |
| New optional input field | minor / patch | no |
| New required input field | major (pre-1.0: minor) | yes |
| Renamed tool / removed tool | major (pre-1.0: minor + RETIRED_*) | yes |
| Capability rename | major (use RETIRED_* pattern) | yes |
| Behavior fix (matches docs) | patch | no |
| Behavior change (diverges from docs) | minor | yes |

## Pre-1.0 minor bumps

Every minor bump pre-1.0 may include surface changes. The clock guards against *frequent* surface changes — not against any change. The "~1 week" target is for the API surface to be quiet enough that adopters can integrate without a moving target.

## Related

- [`retired-registry-pattern.md`](retired-registry-pattern.md)
- [`branch-protection.md`](branch-protection.md)
- [`../../tool-reference.md`](../../tool-reference.md) — public Stability & semver section.
