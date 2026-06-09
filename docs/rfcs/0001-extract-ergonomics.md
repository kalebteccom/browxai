# `extract()` ergonomics — proposals deferred to owner sign-off

**Date:** 2026-05-28
**Investigator:** Claude (Opus 4.7) — `investigation/extract-ergonomics-2026-05-28`
**Trigger:** wrightxai Phase-1 Wave-4 trial-1 against `hn-frontpage-rank-extract` showed the agent burning ~3-5k output tokens learning `extract()`'s schema convention on a cold start. This doc captures the conservative-NOW fixes (shipped on the same branch) and the contract-affecting proposals deferred for owner approval.

**Status update (2026-05-28):** Proposals A, B, and D are **SHIPPED in v0.2.3** on `release/v0.2.3-extract-relaxations`. Proposal C (`dialect:"plain"`) remains deferred to v0.3.x scope. See `CHANGELOG.md` for the per-proposal contract notes; the per-proposal status flags below are updated inline.

## What shipped on the branch (contract-preserving)

1. **Validator error messages now include "Did you mean...?" hints.** `type:"integer"` → "supported: object, array, string, number, boolean — did you mean 'number'?". Same for `bool`, `str`, `list`, `dict`, `int`, `float`. The schema is still rejected — the call still returns `{ok:false, failure:{kind:"invalid-schema"}}` with the same shape.
2. **Unknown `x-browx-source` key diagnostics.** When a schema uses, e.g., `attribute:"href"` (instead of `attr`) or `transform:"int"` (which is wholly unsupported), the resolver now emits a diagnostic into `evidence.partialMisses` on the first observation: `"url: unknown \`x-browx-source\` key \`attribute\`; did you mean \`attr\`?"`. **Outcome is unchanged** — the call still succeeds with `ok:true` and the leaf still falls back to innerText — but the agent sees the typo on the same turn instead of having to debug silently-wrong leaf values.
3. **Array-without-`collection` partial miss now spells out the fix.** Was: `"items: array needs \`x-browx-source.collection\`"`. Now: `"items: array needs \`x-browx-source.collection\` (a CSS selector or NL query for the row container; each match becomes a per-row scope for \`items\`)"`. Same `ok` outcome.
4. **Tool description (`server.ts`) calls out:** the closed type set, `integer` NOT supported (use `number`), the full `x-browx-source` key list with explicit "NOT `attribute` / NOT `property`" callouts, the no-`transform` rule (the leaf coercer handles `$1,234.50 → 1234.5` for `type:"number"`), and that `collection` is required on every array.

These four changes ship as v0.2.2 patch — no API break, all 912 existing unit tests still pass (920 total now, +8 new regression tests).

## Proposed but deferred — owner sign-off needed

### Proposal A: auto-coerce `type:"integer"` → `type:"number"` with a warning — **SHIPPED in v0.2.3**

**Why it'd help:** the wrightxai trial-1 agent emitted `integer` on its first attempt (turn 2). The schema was rejected with `invalid-schema`; the agent retried. A second observation + retry costs ~400-600 output tokens. If `integer` was accepted (silently coerced to `number` + a deprecation warning in `evidence`), turn 2 would succeed first-try.

**Why it's deferred:** this changes the success/failure outcome for an existing input shape. An adopter test asserting `{type:"integer"}` → `ok:false` (we have one, `extract.test.ts:340`) would flip. The "is this contract-preserving?" reading hinges on whether `integer` was ever a "valid" input — formally it wasn't (the type was rejected), but flipping a rejection to acceptance is the dictionary definition of a contract loosening.

**Risk profile:** the _leaf coercer_ already handles integer-shaped values cleanly (`coerceLeaf("330", "number")` → `330`, a JS number; consumers can `Math.trunc()` if they want enforced ints). The coercion would be transparent to callers who emitted `integer` expecting "a number." But anyone relying on the rejection (to catch their own bug) would silently start succeeding.

**Recommendation:** SHIP if the owner is willing to call this a "schema-dialect relaxation" rather than a break. Document it under "additive: now accepts `integer` as an alias for `number`" in the changelog. Suggest also accepting `int`, `float`, `double`, `long` by the same logic (they all lower to `number`).

### Proposal B: auto-add `x-browx-source.collection` for top-level array schemas from sibling `selector` / `query` hints — **SHIPPED in v0.2.3**

**Why it'd help:** the trial-1 turn-5 / turn-6 transition was the agent learning that arrays need an explicit `collection`. A nicer DX would be: if the schema is `{type:"array", items:{...}, "x-browx-source":{selector:"tr.athing"}}`, treat `selector` as `collection`. (Arrays don't have a leaf-`selector` semantics anyway — `selector` on an array is meaningless today.)

**Why it's deferred:** it's adding implicit behavior. Today, `selector` on an array is silently dropped (it's not in the `collection` lookup path). Promoting it to act as `collection` is a contract change for that edge case.

**Recommendation:** SHIP as a no-op-overlap promotion (since `selector` on an array does nothing today, repurposing it can't break anyone who was relying on it). Call it out in the changelog under "additive: `x-browx-source.selector` on an array is now an alias for `x-browx-source.collection`."

### Proposal C: a simpler schema dialect (`mode:"plain"` or `dialect:"plain"`)

**Why it'd help:** wrightxai is one adopter. The cross-adopter cost of every cold-start agent learning the `x-browx-source` DSL is the larger pattern. A `dialect:"plain"` that uses a CSS-string-as-property-value shorthand would be a separate, cleaner surface — but that's a meaningful API addition, not a patch.

**Recommendation:** scope as a separate v0.3.x feature. Not for this branch.

### Proposal D: tighten the validator on unknown keys (reject vs warn) — **SHIPPED in v0.2.3 (opt-in via `BROWX_EXTRACT_STRICT=1`)**

Currently we emit a `partialMisses` diagnostic for unknown `x-browx-source` keys. We could instead reject the schema with `invalid-schema`. **Pro:** the agent gets an immediate, structured failure on turn 1 instead of receiving wrong data + a diagnostic. **Con:** it's a stricter contract — schemas that used to succeed (with silently-wrong leaves) would now fail.

**Recommendation:** SHIP as a v0.3.0 minor (the rejection IS a contract change, but a defensible one given the silently-wrong-leaf bug). For v0.2.2 we ship the warning-only diagnostic. Open question for owner: a `BROWX_EXTRACT_STRICT=1` opt-in toggle for the strict-reject behavior could ship in the same patch — adopters who want first-class typo-detection enable it.

## Cross-cut: documentation

Independent of the code/test changes, the `docs/tool-reference.md#extract` section should be reviewed for the same omissions the tool description had (no enumerated type list, no `attr`-not-`attribute` callout). I haven't touched docs/ in this branch — flagging for the docs-pass cycle.

## Estimated wave-4 re-run token savings (post-shipped-fixes)

The wrightxai trial-1 burned ~15 115 output tokens across turns 5/6/7 — schema-discovery + recovery. With the shipped changes:

- Turn 2 `integer` rejection → still happens but agent sees `did you mean "number"?`. Saves ~300-500 output tokens by skipping the `eval_js`-detour turn 4.
- Turn 5 array-no-collection → message tells the agent the fix is a CSS-selector-or-query for the row container. Saves the "what does collection mean?" exploration turn (~500-800 output tokens of CoT + a partial schema retry).
- Turn 6 silent `attribute`/`transform` typos → `evidence.partialMisses` now flags both with suggestions. The agent could land turn-6 + turn-7 in a single retry that uses the correct `attr` key, saving ~3-5k output tokens (turn 7's 7 556 output_tokens was overwhelmingly the agent re-emitting the same big schema with a fix).

**Conservative estimate: -4k to -6k output tokens** on a second cold-start trial-1 run. From 20 268 down to ~14-16k. Still well above the Webwright baseline of 8 574, but the gap closes from 2.36× to ~1.7-1.9× — meaningful but not the gate-passing margin. The leverage thesis still needs the multi-task N=3 evidence the Phase-0 doc calls for.

## Open question for the owner

The shipped changes are pure-diagnostic — they don't break the contract but they _add_ entries to `evidence.partialMisses` in cases where it would previously be empty (specifically: schemas with unknown `x-browx-source` keys that currently silently succeed). If an adopter has a regression test asserting `evidence.partialMisses === []` on such a schema, it would now fail.

**This is plausibly a contract change in the strict sense** — the evidence-shape grew on a previously-clean output. Calling it out explicitly so the owner can decide whether to (a) ship as v0.2.2 patch with a changelog flag, or (b) tag as v0.3.0 minor. Recommended: (a) — the schemas in question were already broken (silently-wrong leaves), the new diagnostic just makes the brokenness visible.
