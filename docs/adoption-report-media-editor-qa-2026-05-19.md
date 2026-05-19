# Adoption report: media-editor QA (2026-05-19)

**Adopter:** Codex leading multiple browxai sub-agent QA sessions.
Scope: an async response-mapping fix across old regenerate, async
regenerate, async script/translation completion, and manual restore/sync
flows. Target was a complex media-editor SPA with timeline rows,
video clips, audio clips, async jobs, and duplicated clip identities.

## TL;DR

browxai was useful for proving the bug class manually, especially with
multi-session sub-agent work and app-state inspection through `eval_js`. The
main missing pieces were not generic "click a button" problems. They were
media-editor problems: selecting the correct timeline row/clip, proving which
clip was selected/copied, and deterministically forcing backend responses to
arrive out of order. The highest-value improvements are coordinate target
inspection, selection/state diffs around actions, and first-class request
mocking/reordering.

## What worked well

- **Session isolation for sub-agents.** Separate browxai sessions let multiple
  agents test old regenerate, async regenerate, async completion, and manual
  restore flows in parallel without sharing refs or app state.
- **`eval_js` for app-state inspection.** The app exposed enough client-side
  state to verify whether selected scripts, generated audios, and TTS rows were
  mapped by stable identifiers instead of array positions.
- **`network_read` and per-action network slices.** Useful for confirming
  regenerate payloads and checking which backend endpoint fired after toolbar
  actions.
- **`find`, `snapshot`, and `text_search`.** These handled normal toolbar,
  button, and panel interactions well. The friction started once the target
  moved into custom timeline/media regions.

## Missing primitives / asks

### 1. Coordinate target probe for custom timelines

The most fragile flow was selecting the **audio** timeline segment that matched
the script, not the similarly positioned **video** clip above it. The correct
target was visually a purple segment on the third channel row. In this kind of
media editor, the important object is often not represented as a clean button
or accessible element.

Ask: a read-only primitive like `point_probe({ coords })` or
`elements_at_point({ coords })` that returns:

- the full `elementsFromPoint` stack;
- each element's role/name/test id/class summary;
- computed `pointer-events`, visibility, z-index, cursor, and bbox;
- nearest scroll container and clickable ancestor;
- a small screenshot crop around the point.

Also consider including this target stack in `click({ coords })` results. That
would let an agent prove "this coordinate hit the audio segment row" before
copying, instead of trusting a screenshot estimate.

### 2. Region screenshot crops and named visual refs

Element-cropped screenshots are less useful when the target is a virtualized
timeline, canvas-like layer, or unlabelled positioned div. The agent often
needs to crop "the third row segment at x=..." rather than an element ref.

Ask: `screenshot({ box: { x, y, width, height }, describe: true })`, plus a
way to bind that box as a named visual ref for later actions:
`name_region({ name, box })`, then `click({ named: "matching_audio_clip" })`.

This would reduce coordinate drift when a sub-agent needs to select, copy, and
then re-check the same media segment.

### 3. Selection/class/style diff around an action

For timeline QA, the critical assertion is often "which clip became selected"
or "which row now has the active clip state." That change may be expressed only
as CSS class/style/attribute changes, not visible text or accessibility tree
changes.

Ask: an `act_and_diff` primitive that performs one action and returns DOM diffs
within a scope, including:

- changed classes;
- changed `aria-*` and `data-*` attributes;
- changed inline style / selected border color;
- added or removed selection handles;
- before/after screenshots for the scoped region.

This would have directly helped the "copy the purple audio segment, not the
video channel clip" flow.

### 4. Network route mocking with delay/reorder controls

The fixed bug class was "response order differs from request order." Browser QA
needed to simulate old and new backend responses returning out of order. The
workaround is app-specific `eval_js`, monkey-patching, or manual state
injection, all of which are easy to get subtly wrong.

Ask: a scoped network mocking primitive, behind an explicit capability, for
race-condition QA:

- `route({ urlPattern, method?, response })`;
- `route_delay({ urlPattern, delayMs })`;
- `route_queue({ urlPattern, responses: [...] })`;
- automatic teardown at session close or explicit `unroute`.

An even narrower variant would be `act_and_reorder_responses`, where the agent
declares "for the next matching requests, resolve response 2 before response
1." That is exactly the class of failure this fix addresses.

### 5. Act-and-network-wait with predicates

`ActionResult.network` is helpful, but async SPAs often fire follow-up requests
after the immediate action result window. Agents then poll `network_read` and
manually filter noisy entries.

Ask: `act_and_wait_for_network({ action, match, timeoutMs })`, returning the
matching request/response shape and a concise timeout reason when absent.
Useful match fields:

- URL substring or regex;
- method;
- request JSON key/value;
- response status;
- GraphQL operation name when detectable.

This would make toolbar regenerate tests easier: click regenerate, wait for
the exact audio-generation request, assert the selected audio/script ids.

### 6. Bounded app-state polling

`eval_js` is powerful, but using it for waits is awkward. A long-running
in-page promise can trip the anti-wedge timeout; repeated one-shot eval calls
are noisy.

Ask: a gated `poll_eval({ expr, intervalMs, timeoutMs, returnType: "json" })`
that repeatedly evaluates a JSON-serializable expression until it returns a
truthy value or a structured predicate result. The result is still
page-controlled and should be labeled as such.

This would have helped wait for async job completion and Redux/store updates
without writing ad hoc loops inside the page context.

### 7. Pointer gesture primitives beyond click

The current tested fix mostly needed click and keyboard copy, but media editors
quickly need drag selection, clip trim, scrub, lasso, and row scroll gestures.
Coordinate-only `click` is not enough for future timeline regressions.

Ask: explicit pointer tools:

- `drag({ from, to, steps?, button? })`;
- `mouse_down`, `mouse_move`, `mouse_up` for lower-level cases;
- `double_click`;
- optional `act_and_trace_pointer` output with hit targets along the path.

These should pair with `point_probe` so an agent can verify the gesture starts
on the intended clip handle or timeline row.

### 8. Clipboard / keyboard shortcut observability

The user-facing flow involved selecting a timeline segment and copying it.
`press({ key: "Control+C" })` can drive the shortcut, but browxai does not
make it easy to prove what was copied or whether the app handled the shortcut.
Some apps use an internal clipboard rather than the OS clipboard.

Ask: a small observability layer for shortcut actions:

- action result notes when `copy`, `paste`, or `cut` events fire;
- target element / active element at the time of the shortcut;
- optional clipboard read/write behind a capability where the browser permits
  it;
- event listener trace for `keydown`, `copy`, `paste`, and default-prevented
  status over a bounded window.

This would have reduced uncertainty in "the audio segment was copied, not the
video segment."

### 9. Cross-session QA summaries

The sub-agent pattern worked, but aggregating manual QA evidence required
reading each agent's notes and normalizing terminology by hand.

Ask: optional session labels and a report helper:

- `open_session({ session, labels: [...] })`;
- `annotate_session({ note })`;
- `export_session_report({ prefix })` with actions, screenshots, network
  highlights, console errors, and open sessions.

This is lower priority than the media-editor primitives, but it would make
multi-agent QA results easier to audit.

## Concrete incidents from this run

- The initial user correction was specifically to select the audio segment
  matching the script, visually the purple clip on the third channel row,
  instead of the video-channel clip. browxai could drive the page, but could
  not reliably explain or verify the coordinate target.
- Duplicate source/copy media rows shared clip identities. Browser QA had
  to verify that regenerated responses were matched by script or clip keys, not
  response index.
- Async completion and manual restore/sync paths could be made to misassign
  data when completion responses arrived in a different order than requests.
  Deterministic route reordering would have made this a browser-level proof
  instead of a mix of browser work and unit tests.
- Some UI results were visible only as selected row/clip styling. Standard text
  and accessibility snapshots did not capture enough about the state change.

## Prioritized next steps

1. Add coordinate target probing and include target stacks in coord-based
   action results.
2. Add scoped action DOM/style diffing for selection-heavy UIs.
3. Add route mocking with delay/reorder controls for race-condition QA.
4. Add `act_and_wait_for_network` for precise request assertions.
5. Add bounded `poll_eval` for app-state waits behind the existing eval
   capability.

These are target-agnostic enough to fit browxai's surface, but they directly
address the failure modes from this media-editor QA campaign.
