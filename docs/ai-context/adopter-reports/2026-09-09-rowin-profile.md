# Browxai Report - 2026-09-09 - rowin-profile

## Context

Six months of daily driving from an external repo (`rowin-profile`): ATS form
filling, job-application status checks, LinkedIn messaging, design-QA
screenshots, and (new this cycle) Gmail. About a dozen platforms, four carrying
a browser-specific workaround. Attached mode against a real Chrome on `:9222`
is the primary lane because managed mode is detected.

Reporter is a consumer, not a contributor. Every claim below was re-verified
against source during triage; the "Verified" line on each item records what the
code actually does, which in two cases is worse than reported.

## Items

### 1. Attached-mode session ids do not isolate (CRITICAL)

Four agents against one attached Chrome; every session id resolved to the same
page. One agent had roughly half its calls land on another agent's page. The
failure is silent: a wrong write, not an error. Form state read from and
written to the wrong application.

**Verified.** `src/engine/adapters/playwright-chromium.ts:90-91`:

```ts
const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext());
const page = context.pages()[0] ?? (await context.newPage());
```

Worse than reported. Every attach takes the first context's first page, and
`byob-attach.ts` freezes it in the session record as `page: () => page`. N
sessions against one Chrome do not merely race for a target, they share one
`Page` object by construction. There is no target identity on the session
record and no liveness check, so a closed page leaves every session holding a
stale handle.

### 2. `ok:true` on an authentication redirect

`navigate` to `https://mail.google.com/mail/u/0/` while signed out returned
`ok:true` with `navigation.to` pointing at
`https://workspace.google.com/intl/en-US/gmail/`. Requested origin and landed
origin differ and nothing says so. A caller that does not diff its own input
against `navigation.to` will snapshot a marketing page and conclude the inbox
is empty.

**Verified.** `describeNavigation(from, to, frameNavigated)` in
`src/page/actionresult-shape.ts:70` compares the URL _before_ the action to the
URL _after_. The URL the caller _requested_ is never passed in, so no
comparison against it is possible. The classification is structurally unable to
notice an off-origin landing.

### 3. No way to ask which profile holds a live session for an origin

~140 directories under the profiles root, no TTL, no collection. Opening the
`job-search` profile expecting Gmail returned the signed-out page because Gmail
was only ever authenticated in `job-search-live`. `auth_list` answers a
different question.

**Verified.** `src/session/profile-snapshot.ts:32` resolves
`<root>/profiles/<name>` and nothing enumerates the directory or maps profiles
to the origins they hold cookies for.

### 4. `click` thrashes on realtime SPAs

LinkedIn conversations: Playwright's actionability check never settles against
a realtime fetch loop, throwing 200+ `ERR_FAILED` requests per attempt. The
working substitute is a hand-dispatched
`pointerdown → mousedown → pointerup → mouseup → click` through `eval_js`.

**Partially verified, then measured precisely.** `src/page/actions.ts:74-102`
already auto-recovers to `force: true` after an actionability budget and says so
in a warning, so "force does not help" is not right as stated.

Measured against every unsettled-layout shape that could be built (rAF box
jitter, scroll churn, node rebuild at rAF rate): on a target whose **node
identity is stable**, `force` succeeds in 3–216 ms every time. It fails only
when the target's node identity churns faster than one pointer action can
complete, which is exactly the SPA re-render shape the reporter hit. So the gap
is narrower than reported and real.

Two things fell out of that measurement and shaped the fix. `boundingBox()`
returned `null` 4/4 and `locator.evaluate(el => el.getBoundingClientRect())`
returned a 0×0 rect 6/6 on the failure shape, because both split resolution from
measurement across two round trips and the handle is already detached. So the
mode needs a single `page.evaluate` that queries and measures atomically, and
therefore a CSS-addressable target. And awaiting the three CDP sends separately
leaves a round trip between `mousePressed` and `mouseReleased` long enough for
the subtree to swap, after which the browser fires **no `click` at all**, the two
targets having no connected common ancestor.

### 5. `approve_actions(["byob_action"])` is required and undiscoverable

The first blocked action does not name the call that unblocks it.

**Not reproduced. Already fixed.** The same finding is
`2026-05-19-fanfest-qa.md` §2, and it was addressed by `472acfe feat:
approve_actions discoverability`. Every confirm-gated action routes through
`denyContent` (`src/tools/host-build.ts:193`), whose hint names
`approve_actions({ scopes:[…], ttlSeconds })`, gives `["byob_action"]` as the
worked example, lists the two alternatives, and says explicitly that the
feature is gated rather than broken.

The reporting repo is running a build that predates the fix. No code change.
The durable lesson is about the consumer's upgrade cadence, not the surface:
a finding six months into daily use should be re-checked against `HEAD` before
it is filed.

### 6. Background-tab throttling

Chrome pauses `requestAnimationFrame` in background tabs, throttles timers
after five minutes, and can freeze a hidden+occluded tab. An agent in a
background tab waiting on a poll sits there until deadline and it reads as a
page bug. Asks for `--disable-background-timer-throttling`,
`--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`.

**Verified absent.** The only Chromium launch args in the tree are the
`--disable-web-security` pair (`src/session/launch-options.ts:55,169`) and
`--no-first-run` / `--no-default-browser-check` in the `browxai chrome`
launcher (`src/cli/chrome.ts:55`).

**Design conflict worth naming:** `2026-05-19-fanfest-qa.md` §1 asked for the
_opposite_: the ability to genuinely throttle a backgrounded tab to reproduce
lifecycle bugs. Same knob, two directions. Neither is a global flag; this is a
per-session default with an override.

### 7. Script export drops every read

`export_playwright_script` emitted valid TypeScript for a two-step recording
and the spec passed in 8.5s with no hand-editing. But the recorder keys off
`DispatchedAction`, so it captures navigate / click / fill / press / hover /
select / waitFor / chooseOption / goBack / goForward and nothing else.
`find`, `extract`, `snapshot` and `eval_js` produce no dispatched action and
never enter the trace.

**Verified.** `src/page/recording.ts:104-121` and the `lowerStep` switch in
`src/page/export-playwright-script.ts:125-150`. A session whose purpose was to
read something exports as a script that performs the navigation and returns
nothing. A replayable script that produces no output is a macro; the ask is a
function.

Secondary: no parameters. The URL is baked in and nothing distinguishes a value
incidental to the recording from a value that is the input.

Friction: a fresh `@playwright/test` install has no browsers, so the first run
dies on executable-not-found before reaching the page. Emitting a
`playwright.config.ts` with `use:{channel:'chrome'}` beside the spec turns a
confusing failure into a copy-paste.

### 8. `find` missed an exact accessible-name match

Query "the past link in the top navigation bar" on the Hacker News front page,
where the nav contains a link whose accessible name is exactly `past`. Returned
three story headlines, all scored 3, every one flagged `clipped:true` and
`actionable:off-screen` on a page that had just finished loading. Two defects
in one result: the ranker did not privilege an exact accessible-name hit, and
the visibility computation called on-screen nav links off-screen. The warning
text then suggests falling back to coords, which on a misidentified element is
the worst available advice.

### 9. Managed mode is detected; attach mode cannot clear a login challenge

Measured on Toptal, July 2026. Two tiers. Light Cloudflare on marketing pages
passes once attached to a real Chrome. Strict managed challenge on login
probes for an attached CDP client and serves an endless "Just a moment"
spinner even with `navigator.webdriver === false`. Current workaround is a
Chrome launched with no debug port, a human clearing the challenge by hand, and
automation running behind the persisted cookies.

The failure mode that matters to browxai is not the challenge. It is that the
challenge presents as an indefinite hang with no structured result.

Also: the attached MCP server is hardwired to `9222`, so a second Chrome on
another port is unreachable.

## Patterns worth not breaking

- `open_session {mode:"persistent", profile:"<name>"}` isolates properly where
  a second attached session does not. A 14-application LinkedIn sweep ran clean.
- `batch` with self-guarding evals collapses check-then-act into one call and
  removes the window where another agent moves the page. A mitigation for item
  1, not a fix, but it holds.
- The `ActionResult` shape generally: navigation, structure diff, console slice
  and network summary in one return is most of what a caller needs without a
  second call.

## Durable lessons captured

**Item 1 → [RFC 0005](../../rfcs/0005-attached-target-pool.md), landed.** Sessions
lease distinct CDP targets; ceiling, reclamation and dispatch-as-heartbeat on
top; real-Chromium keystone is the gate. Two design details the RFC missed and
implementation caught: acquisition must be serialized per endpoint (enumerate
-then-claim spans an await), and endpoint keys must be normalized or
`localhost:9222` and `127.0.0.1:9222` split one Chrome into two disjoint pools.

**Item 2 → landed.** `ActionResult.navigation.offOrigin`. The root cause was
narrower than the report: `describeNavigation` compared before-URL to after-URL
and was never passed the URL the caller _requested_, so the classification was
structurally unable to notice. Hosts are compared rather than origins, so an
http→https upgrade stays quiet while a www/apex hop fires.

**Item 3 → landed.** `profile_status`. Scoped honestly: a closed profile's
cookie store is OS-key-encrypted, so the tool reports size, file count, newest
mtime, live-session binding, and the already-open context's cookie **domains**
where a session happens to be open. It says in its own description that it
cannot tell you whether a closed profile is authenticated. `modifiedAt` is what
makes 140 directories collectable.

**Item 4 → landed.** `click({ dispatch: "direct" })` resolves the target to a
point and dispatches `mouseMoved`/`mousePressed`/`mouseReleased` through CDP,
skipping the locator engine's pre-dispatch path. Events are trusted (real input
pipeline, not page-side synthesis), and the browser still hit-tests. A keystone
asserts an overlay eats the click and a disabled control fires nothing, so it
cannot punch through a consent scrim. Kept out of the capability lattice
deliberately: it reaches no data, origin or device that capability `action` did
not already reach, `force` already ships ungated with the same see-through
property and is applied automatically as a recovery, and a server-restart-scoped
capability is the wrong granularity for something that should be per-call. The
mitigation is evidence: every direct dispatch returns a warning naming the
coordinate and the skipped checks, plus `element.hit.before`/`.after`.

Refuses with a named reason on non-CDP engines and on targets that are not
CSS-addressable (role/name-only refs, child-frame refs; an iframe's
`getBoundingClientRect()` is frame-relative while CDP dispatches in main-frame
viewport coordinates).

**Item 5 → no change; already fixed.** See the item. The lesson is about the
consumer's upgrade cadence.

**Item 6 → landed.** `open_session({ backgroundThrottling: "disabled" })` and
`browxai chrome start --disable-background-throttling`. Default unchanged,
because the FanFest report wanted the opposite knob and no existing launch
should change behaviour silently.

**Item 7 → landed.** The recorder now captures `extract` / `find` / `snapshot` /
`eval_js` as a second step kind, and both the YAML and the `.spec.ts` lower
them, so an exported spec returns values. The format additions that turn a
recording into a callable tool are [RFC 0006](../../rfcs/0006-flow-files-as-connectors.md),
unbuilt.

**Item 8 → landed, and the root cause was neither of the two hypotheses.**
Ranking compared the accessible name against the _entire_ query, so the bonus
never fired for natural-language input; the `past` link went from score 1 (rank 4) to 11 (rank 1). The visibility half was not a viewport or timing problem: a
thin CDP a11y tree pushes candidates to the DOM-walk fallback, which reports an
element's bare tag as `role`, producing `role=a[name="past"]`, a locator
Playwright's role engine rejects, so every bbox probe failed and every visible
link read as off-screen. The coordinate-suggesting warning is reworded.

**Item 9 → detection landed, evasion declined.** `ActionResult.challenge` names
Cloudflare interstitials, Turnstile widgets and Anubis, and a deadline expiry
behind a gate now names the gate and points at `await_human` instead of a
generic timeout. `open_session({ channel: "chrome" })` addresses the stated root
cause (managed mode drives Chrome for Testing) with a stock Playwright option.
A 2026 benchmark measured `rebrowser-playwright` at parity with vanilla
Playwright against live Cloudflare, and the only tool that cleared it is
AGPL-3.0 Python that is not a Playwright drop-in. So no anti-detect dependency
was adopted, and none is recommended.

**Process lessons, both about trusting stale premises:**

1. **A field report six months into daily use needs re-verification against
   `HEAD` before triage.** One of nine items was already fixed four months
   earlier. Two others were worse than described, and one had a wrong diagnosis
   attached to a real gap. The report was valuable; every individual claim in it
   still had to be checked against source.

2. **Documented invariants drift silently.** `docs/tool-reference.md` claimed
   "different ids are always isolated browser contexts regardless of mode",
   which was false for attached mode and is _still_ only half-true after the
   fix: sessions get distinct tabs but share one cookie jar. The adopter
   reasonably believed the doc. A claim of isolation is exactly the kind that
   needs a test behind it, and now has one.
