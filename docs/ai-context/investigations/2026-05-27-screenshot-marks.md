# `screenshot_marks` — tool-fit investigation (2026-05-27)

This investigation was scoped from a wrightxai early-discovery tool-fit question:
the wrightxai spec at `projects/webwright-on-browxai/spec.md` line 57 says
wrightxai "never re-exposes …`screenshot_marks`", yet wrightxai's curated
`BrowxaiToolName` union includes `screenshot_marks` in the agent-callable
set. Builder C interpreted the spec line as forbidding _re-exposing_
(wrightxai-level duplicate surface) NOT _calling_ — same reading applied
to `extract` / `verify_*` / `plan` / `execute` which the loop also calls.
The owner asked for a substantive read on whether `screenshot_marks` is
the right fit for wrightxai's loop usage pattern.

## Contract recap

- **Signature**: `screenshot_marks({ candidates, label?, session? })`.
  `candidates` is 1..50 rows of `{ref}` (bare; bbox looked up against the
  current snapshot walk) or full `find()` candidate `{ref, role, name, testId,
bbox}` (fast-path, no extra walk). `label` ∈ `"index"` (default) / `"ref"`
  / `"role"`.
- **Returns**: `{ marks:[{index, ref, role?, name?, testId?, bbox, painted}],
mapping:{"1":"eN", …}, warnings }` + a base64 PNG of the viewport with a
  numbered overlay painted at each candidate's bbox.
- **Capability**: `read`. Also in the `batch` whitelist. Pure compose over
  `find()` / `snapshot()` — only browser side-effect is a transient in-page
  overlay installed for the duration of the screenshot and removed before
  return.

## Namespace-sharing claim — verified

CHANGELOG v0.2.0: "The numbering scheme SHARES the existing `name_ref` /
`eN` namespace — no parallel ID space — so `mapping["2"] === "e7"` and the
agent can address either way."

End-to-end smoke (live, against `example.com` / `developer.mozilla.org` /
`en.wikipedia.org/wiki/Main_Page`) confirms:

- For every candidate passed in (bare or full), `mapping[String(index)] ===
candidate.ref`. The map is built by appending each entry in order;
  there's no shuffle.
- For full-candidate fast-path inputs, `marks[i].bbox === candidates[i].bbox`
  (object equality) — the bbox is passed through unmodified, so by
  construction matches `find().evidence.bbox`.
- For bare-`{ref}` inputs, `marks[i].bbox` comes from the same
  `composeSnapshot` + `visibleRect` path `find()` uses; same calibration,
  same numeric result.

Artifacts captured (under `artifacts/`):

- `marks-example.png` — 16.6 KB. Single ref painted with index `1`.
- `marks-wiki.png` — 198 KB. Index `1` painted on the matched link.
- `marks-overlap.png` — 18 KB. Two index labels painted on overlapping
  bboxes (e1, e2 at near-identical coords). Both readable.

## Wall-clock — before/after the fix this investigation surfaced

Before fix (`tools/profile-*.json`, first run):

| target                | snapshot |    find() | screenshot |     screenshot_marks (bare) |
| --------------------- | -------: | --------: | ---------: | --------------------------: |
| example.com           |     6 ms |      4 ms |      13 ms |                   60 038 ms |
| en.wikipedia.org      |    43 ms |     36 ms |      37 ms |                   60 131 ms |
| developer.mozilla.org |    15 ms | 30 028 ms |      34 ms | **deadline-timeout (90 s)** |

After fix:

|                target |                        screenshot_marks (bare) |
| --------------------: | ---------------------------------------------: |
|           example.com | 2.0 s (2 refs × ≤ 1 s fallback cap + overhead) |
|      en.wikipedia.org |                                          2.1 s |
| developer.mozilla.org |                                          3.1 s |

Total investigation suite time: 458 s → 53 s.

The residual ~2-3 s for bare-ref bare-page targets is the bounded
fallback cost (each unresolvable bare ref burns up to its 1 s cap).
A wrightxai-loop pattern that pipes `find()` rows straight into
`screenshot_marks` (fast-path) hits **~30-40 ms regardless of target
size** — see the perf-probe `tM3` measurement (`38 ms` on
`example.com`).

## Root cause of the 30-s-per-unresolvable-ref wedge

In `src/page/set-of-marks.ts`'s `resolveCandidates`, when the bare-ref
path's CDP `visibleRect(cdp, backendDOMNodeId)` returns null (synthetic
a11y nodes like the document root `RootWebArea` have no real DOM
backing), the code falls back to `locatorBoundingBox(page, hint)`. The
hint is produced by `buildSelectorHint` and looks like
`role=RootWebArea[name="Example Domain"]`. Playwright doesn't resolve
that to a DOM element (`RootWebArea` is a Chrome a11y internal role,
not a standard ARIA role), AND `boundingBox()` **auto-waits**:

> Playwright `locator.boundingBox()` returns the bounding box of the
> element, with respect to the main frame's viewport. Method waits for
> the element to be visible. _(default action timeout: 30 000 ms)_

So every unresolved bare-ref candidate burned 30 seconds of dead time
before returning null. Two such candidates on `example.com` → 60 s; the
heavier MDN page blew past the per-call deadline entirely.

### Fix shipped

`src/page/bbox.ts:locatorBoundingBox` grows a `{ timeoutMs? }` option.
`screenshot_marks` passes `timeoutMs: 1000` — synthetic-ref fallbacks
fail in ≤ 1 s instead of waiting out the 30 s. Default behavior
(other call sites) unchanged: omitting the option preserves Playwright's
default.

Unit test locked in: `src/page/bbox.test.ts` — asserts the `{ timeout:
1000 }` arg is forwarded, and that omitting the option calls
`boundingBox()` with no args (Playwright default).

## Edge-case probe

- **Unresolvable bare-ref** (e.g. `e999999`): `marks` row populated with
  `painted: false`, `bbox: null`, and a per-ref warning. No throw. The
  per-skipped-candidate warning is a single "N of M candidate(s) had no
  bbox" line, not one per entry — terser than `find()`'s pattern but
  consistent.
- **Caller-provided `bbox: null`** (clipped/off-screen): same as
  unresolvable — `painted: false`, kept in `marks` so the index↔ref
  mapping stays complete.
- **Overlapping bboxes**: rendered legibly. Each box's label badge
  flips to the inside corner when the box sits within 22 px of the
  viewport edge, so adjacent labels don't clip; overlapping interiors
  still get distinct badges. See `artifacts/marks-overlap.png`.
- **Label modes** — all three documented modes behave as documented.
  `label:"index"` paints the array position 1..N. `label:"ref"` paints
  the existing `eN` directly. `label:"role"` paints the candidate's
  role (falling back to `ref` when role is absent).

## Verdict: KEEP-WITH-CAVEAT

`screenshot_marks` is strictly useful for wrightxai's perception step:
the vision-grounded action choice ("click 2") is the prototypical
multimodal-agent pattern, and the namespace-sharing design makes the
LLM↔harness handoff one-line (`click({ ref: mapping[choice] })`). The
contract is sound; the spec-line-57 reading "forbids re-exposing, not
calling" is consistent with how the same line treats `extract` /
`verify_*` / `plan` / `execute`.

**The caveat that emerged**: the bare-`{ref}` path is meaningfully
slower than the fast-path. Even after the 30-s wedge fix, the
fast-path remains the right default — the caller already has bboxes
from the `find()` it just ran, and piping them through avoids any
fallback risk entirely.

**Recommended wrightxai loop pattern:**

1. `find(query) → candidates[]` (already in the curated union).
2. Pick the K candidates the loop wants to ground visually.
3. `screenshot_marks({ candidates: pickedFindRows, label:"index" })`
   — the **full-candidate fast path**.
4. Send the painted PNG to the vision-judge along with the
   `{index → ref}` mapping; the judge picks an index; the harness
   translates back to `eN` for the next action.

The bare-`{ref}` form remains available for ad-hoc "I have a ref
from somewhere else, paint me a box" usage, but the wrightxai loop
should standardise on the fast-path.

## Spec-line-57 ambiguity — drop-in replacement

The current wording — "wrightxai never re-exposes …`screenshot_marks`"
— invites the misreading that wrightxai also can't _call_ it. Builder
C, Reviewer C, and the owner all flagged the same ambiguity. Suggested
rewrite for wrightxai's `spec.md`:

```markdown
- **Browxai surface duplication** — wrightxai never re-exposes a
  parallel implementation of `extract(schema)`, `verify_*`, `plan` /
  `execute`, storage-state CRUD, `generate_locator`, or
  `screenshot_marks`. These remain browxai-owned surfaces; wrightxai's
  loop calls them through the curated `BrowxaiToolName` union but
  does not wrap, re-skin, or reimplement them.
```

Diff summary: replaces "never re-exposes X" with "never re-exposes a
parallel implementation of X … wrightxai's loop calls them through the
curated union". Removes the ambiguity by being explicit that _calling
via the curated union is the intended path_, and _re-implementing /
wrapping is what's forbidden_.

## Files touched in this cycle

- `src/page/bbox.ts` — `locatorBoundingBox` grows `{ timeoutMs }`.
- `src/page/bbox.test.ts` — locks in `{ timeout: 1000 }` forwarding.
- `src/page/set-of-marks.ts` — bare-ref fallback passes
  `timeoutMs: 1000`.
- `CHANGELOG.md` — Unreleased ▸ Fixed entry.
- `test/investigation/screenshot-marks.investigation.test.ts` — live
  smoke for namespace sharing + edge cases (run via the dedicated
  `vitest.investigation.config.ts`; excluded from `pnpm test`).
- `test/investigation/perf-probe.test.ts` — wall-clock probe used to
  surface the defect.
- `test/investigation/trace-runner.ts` — standalone-CLI tracer.
- `vitest.investigation.config.ts` — config for the live-network suite.
- `vitest.config.ts` — exclude `test/investigation/**` from the unit
  run so `pnpm test` stays hermetic.

## What I did NOT do

- No public-contract change to `screenshot_marks` (same args, same
  return shape, same namespace semantics).
- No edit to the wrightxai repo or the project-ideas portfolio — both
  are read-only references for this investigation.
- No new tool added.
- No CHANGELOG bump beyond the Unreleased ▸ Fixed entry; v0.2.0 stays
  shipped as-is.
- No publish / no visibility flip.
