# The RETIRED\_\* registry pattern

browxai's config-input surface (`BROWX_CAPABILITIES` values, `BROWX_CONFIRM_REQUIRED` hooks, config-store keys, tool names, enum values) is a **public contract**. Adopters' configs name these values. Evolving that surface must never crash an existing adopter on their next restart.

## Adding is free

Additive: any new value, new tool, new capability, new enum variant. No deprecation cycle required.

## Removing or renaming is a deprecation cycle

Never a deletion. The progression:

1. **Move the value to a `RETIRED_*` registry.** The parser accepts the retired value, ignores it semantically, and emits a non-fatal deprecation warning that says what to do instead.
2. **Genuine typos still error loudly.** A value that was _never_ valid must be rejected — `BROWX_CAPABILITIES=evel` (typo) errors; `BROWX_CAPABILITIES=unstable` (formerly valid, now retired) warns.
3. **Full removal** happens only at a **major** version bump, with a CHANGELOG entry under `### Removed`.

The distinction is **"formerly valid" (tolerate + warn) vs. "never valid" (reject)**.

## Reference implementation — `RETIRED_CAPABILITIES`

`src/util/capabilities.ts` is the canonical example. When the `unstable` capability was retired:

- `unstable` moved from the active set to `RETIRED_CAPABILITIES`.
- The parser checks the retired set: present → emit deprecation warning, skip silently. Absent from both active and retired → reject as unknown.
- The tools formerly behind `unstable` moved to the appropriate stable capabilities (e.g. `diagnostics` for recorder, `eval` for `poll_eval`).
- The deprecation warning names the replacement: "capability `unstable` is retired; use `diagnostics` for recorder tools or `eval` for `poll_eval`."

## Applying the pattern elsewhere

Any future retirement, on any config-input parser:

```ts
const ACTIVE_VALUES = new Set(["foo", "bar", "baz"]);
const RETIRED_VALUES: Record<string, string> = {
  qux: "Use `foo` instead; `qux` was renamed in v0.X.",
};

function parseValue(input: string): "foo" | "bar" | "baz" | null {
  if (ACTIVE_VALUES.has(input)) return input as "foo" | "bar" | "baz";
  if (input in RETIRED_VALUES) {
    console.warn(`browxai: config value "${input}" is retired. ${RETIRED_VALUES[input]}`);
    return null;
  }
  throw new BrowxaiConfigError(`unknown config value: ${input}`);
}
```

## Prefer additive evolution

Design inputs so this rarely bites. Favour additive evolution; keep the set of breaking primitives small. Every breaking change costs an adopter migration; deprecation cycles cost less but still cost real time.

## Related

- [`semver-clock.md`](semver-clock.md) — when the API-stable clock resets.
- [`../architecture/capability-posture-map.md`](../architecture/capability-posture-map.md)
