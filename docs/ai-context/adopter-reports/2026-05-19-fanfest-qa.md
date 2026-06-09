# browxai feedback — FanFest contest/simulfest QA campaign (2026-05-19)

Field report from a multi-day agentic QA campaign (FanFest plans 076/077:
live multi-session contest + simulfest reliability, host+fan, staging).
Many qa-expert agents drove browxai under a team-lead. Below: what worked,
the friction that produced false negatives or wasted runs, and the missing
primitives — ordered by impact on test outcomes.

## TL;DR — highest-impact asks

1. **Backgrounded/hidden-tab control.** The single biggest gap. A whole class
   of real bugs only reproduces when the host tab is backgrounded; agents
   physically cannot test it.
2. **`approve_actions` should be obvious or default in managed QA.** Agents
   repeatedly misread click no-ops as a human "confirmation gate" and marked
   flows unverified.
3. **First-class act-then-capture-window primitive.** Roundtrip latency makes
   transient UI (spinners, bounded reveals) unobservable with separate calls.

## 1. Cannot simulate a backgrounded / hidden tab  — CRITICAL

The most severe contest bug this campaign (recurring "ghost" stage + a false
"could not finish syncing" toast + cross-quiz state bleed) only occurs when
the host browser tab is **backgrounded** during a transition: the browser
throttles `setTimeout`, pauses `requestAnimationFrame` (so framework
`@after-enter`/animation hooks never fire), and on return a focus/
visibilitychange handler + realtime rewind replays stale state. browxai keeps
the driven tab foreground/active, so every QA agent reported the flow
**PASS** while the operator kept hitting it manually. We only root-caused it
from operator-supplied console logs, not from agentic QA.

Ask: primitives to
- set `document.visibilityState = 'hidden'` + dispatch `visibilitychange`,
  and ideally **actually deprioritize the tab** so real timer/rAF throttling
  applies (a synthetic visibilitychange alone does not reproduce timer
  throttling);
- background a session (open/focus another tab) and later refocus it;
- a combined "run these actions, then background for N s, then foreground"
  script step.
Without this, any bug gated on tab visibility / background throttling /
on-focus refetch is invisible to agentic QA.

## 2. `approve_actions` is a hidden prerequisite; failures look like a human gate

Multiple agents reported UI flows "blocked by a confirmation gate /
`BROWX_CONFIRM_REQUIRED`" and left them **unverified** — when the actual
requirement was calling `approve_actions` at session start, and a
non-responding click is a **selector** problem, not a gate. This produced an
incorrect "not testable" verdict on a real feature (a two-tap producer
control) that was in fact fine.

Ask: in managed/incognito QA mode, either default actions to approved, or
make the blocked-result message explicitly state `call approve_actions to
enable action tools` (not language that implies a human approver). Surface it
in the first error, not only in docs.

## 3. State-capture latency makes transient UI unobservable

A tool roundtrip is ~seconds. A separate "read" call after an action
consistently lands **after** spinners, pending-button states, in-flight
counters, and bounded reveals (e.g. a 6 s poll-answer reveal, an 8 s
self-heal watchdog, a 12 s winner reveal) have already resolved → agents
score "loading state correct" when they never observed it. We worked around
this with `sample`/`watch`, but it is fiddly and easy to get wrong.

Ask: a first-class **act-and-capture-window** primitive: perform an action
and, in the same call, record DOM snapshots / chosen element attrs / console
/ network at an interval over a bounded window, returning the timeline. Plus
an ergonomic assertion helper for "indicator was SHOWN then CLEARED".

## 4. `eval_js` `element.click()` does not fire framework handlers

Recurring false negative: `eval_js` `el.click()` does not trigger Vue
(`@click`) handlers — no mutation dispatched — so agents concluded a feature
was broken. The real `click()` tool works. This cost several misdiagnoses
until it was written into our runbook.

Ask: document this prominently at the `eval_js` tool level; ideally have
`eval_js`-initiated clicks dispatch trusted-equivalent events, or emit a
warning when `.click()` is called inside `eval_js`.

## 5. Stranded sessions / no TTL

Agents stranded managed incognito sessions several times (aborts, hung calls
pre-timeout). The team-lead had to `list_sessions` → `close_session` to reap
orphans, and once found 2 sessions left open ~hours.

Ask: idle-session TTL/auto-expiry for managed sessions; a bulk "close all
sessions with label/prefix X" (we already use per-agent id prefixes — a
label-scoped teardown would make reaping reliable).

## 6. Real crash vs browxai context teardown is ambiguous

Earlier agents reported "page crashed to about:blank" after a realtime
(Ably) message burst; this turned out to be a browxai incognito context
artifact, not an app crash — but it took a dedicated re-run with an in-page
error trap to disprove. False "CRITICAL crash" findings are expensive.

Ask: distinguish, in tool output, an application navigation/crash from a
browxai-side context teardown/detach (e.g. a `reason` field), so agents
don't file app-crash defects for tool teardown.

## 7. Multi-session realtime timing is verbose

Host+fan (and simulfest viewer) multi-session with distinct device
emulation worked well and is a strength. But asserting "an action on session
A propagates to session B within a freshness budget" requires manual
interleaving of calls across sessions and is timing-fragile.

Ask: a cross-session capture primitive — drive an action in session A and
sample session B over a window in one call — for realtime-propagation
assertions (the core of multi-user contest QA).

## What worked well (keep)

- **Per-action `timeoutMs`** (added mid-campaign): eliminated the 28-minute
  wedges where a hung MCP call stalled an agent indefinitely. A hung call now
  returns `ok:false` and the agent retries-once-then-aborts. This single
  change made unattended overnight agent runs viable. Keep it mandatory /
  default; never regress to unbounded calls.
- Managed incognito sessions with isolated cookie jars + device emulation —
  solid for host/fan isolation.
- `find` / `inspect` / `snapshot` for relocating elements after DOM changes.
- `network_read` / `network_body` for confirming GraphQL op status — used to
  verify mutation outcomes (200 + payload) when UI state was ambiguous.

## Concrete incidents (for repro/prioritization)

- Backgrounded-tab ghost: 4+ agent runs reported the in-show quiz lifecycle
  PASS; operator reproduced it ~90% of the time by switching to another tab
  and back. Root cause (throttled `setTimeout` + paused rAF + on-focus
  replay) was only found from operator console logs. (#1)
- "Two-tap producer control blocked by confirm gate" → actually
  `approve_actions`/selector; feature was fine. Marked unverified
  incorrectly. (#2)
- 6 s poll reveal / 8 s watchdog / 12 s winner reveal: needed `sample`/
  `watch`; single delayed screenshots read as "blank"/"already cleared". (#3)
- `eval_js .click()` on a Reka UI switch / answer button: no Vue handler
  fired → false "answer button does nothing". (#4)
- `channel-host-qa` / `channel-fan-qa` sessions left open for hours;
  team-lead reaped them. (#5)
- "Crash to about:blank after endQuizQuestion Ably burst" filed CRITICAL;
  later disproved as a browxai incognito artifact. (#6)
