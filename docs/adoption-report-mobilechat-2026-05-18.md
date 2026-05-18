# Adoption report: browxai mobile-virtual-scroller QA (2026-05-18)

**Adopter:** Claude Code (Opus 4.7), driving browxai MCP against a staging
authed SPA.
**Scope:** live verification of a mobile virtual-scroller fix that **passed
all unit + integration tests but still mis-behaved in the deployed build**.

This report is target-agnostic by construction — it names the *shape* of the
operations, not the deployment.

## TL;DR

browxai **directly closed a bug that green tests could not catch**. The
device-emulation + isolated-session + measurement-loop toolset is the right
shape for "verify the deployed build behaves on the real device class, past
the test suite." Verdict: **strong win**, with a small set of friction points.

## What the task needed

- An emulated **mobile device session** (touch viewport, mobile layout).
- **Forged-auth injection** via `localStorage` + reload (QA on owned infra).
- **Quantitative DOM measurement** of scroll behaviour over many frames
  (per-render `scrollTop` drift, content-shift on scroll-up) — the defect is
  sub-10px and invisible in a still screenshot.
- An **incognito / isolated** context so the forged identity didn't collide.

## What worked very well

1. **`open_session` with `device` + `viewport` + incognito (W-H6).** Singled
   out as the most valuable addition. The whole "passes on desktop, broken on
   mobile" class is only reachable with real touch-viewport emulation in an
   isolated context; it replaced a brittle bespoke harness outright.
2. **`eval_js` as a measurement instrument.** An `async` IIFE that scripts the
   scroller and returns a structured JSON verdict turned a subjective "feels
   jumpy" into a deterministic number (settle-drift `0`, worst per-step shift
   `-1px` over 120 steps). `returnType:"void"` for fire-and-forget reloads was
   noted as a nice touch. This is what closed the ticket.
3. **`ActionResult` richness on actions (W-F2 / W-F5).** `element.hit`
   before/after confirmed a control expanded without a screenshot round-trip;
   `network.mutations` + `responseShape` confirmed the expected fetch fired on
   expand.
4. **`coords` click escape hatch (W-E3).** When ref-finding kept returning
   hidden off-screen dialogs and text selectors timed out, computing the rect
   via `eval_js` then `click({ coords })` was a reliable last resort.
5. **Auth + state survived `location.reload()`** within a session — forged
   identity re-picked-up exactly like a real refresh. Correct for this flow.
6. **Session lifecycle.** `open_session` → many ops → `close_session` was
   clean; the `wasOpen` ack reassuring.

## Friction points (problem classes)

1. **SPA readiness gating.** `wait_for` only accepts a target
   (ref/selector/named/coords) — no "wait until this text appears" mode. After
   a reload the agent wanted to gate on visible text and instead hand-rolled a
   shell-sleep + poll loop. Highest-value gap for real apps.
2. **`find()` ranked hidden modals above the visible target.** A query for a
   plainly-visible element returned only off-screen/clipped `role=dialog`
   candidates (`actionable:"off-screen"`, `bbox:null`) at low score and never
   surfaced the visible one. When *every* candidate is non-visible that's a
   strong "wrong match" signal the result should flag.
3. **Tool schemas are client-deferred** and cost a load round-trip on first
   use of each tool. (MCP-client concern, not browxai's — the server already
   advertises its full surface.)
4. **Repeated hand-rolled "poll an in-page condition until truthy."** The most
   common measurement-QA pattern; rebuilt in-page each time.
5. **No production-build component-state introspection.** Expected (prod
   builds strip framework dev hooks) — not browxai's fault; had to use a
   behavioural proxy to infer the deployed value.
6. **Frame-aligned metric sampling rebuilt by hand.** Sampling a DOM metric
   every animation frame for N ms (for scroll-drift / jank / CLS) had to be
   reconstructed in-page each run.

## Net assessment

browxai enabled closing a bug the test suite structurally could not. The
device-emulation + isolated-session + measurement loop is exactly the right
toolset for past-the-suite deployed-build verification. The follow-on asks are
tracked in `docs/first-consumer-asks.md` (round-10).

## Round 2 — verification of the shipped round-10 primitives

The three round-10 additions were exercised live on a follow-up
predictable-sizing scroll fix. They removed exactly the Round-1 friction.

- **`sample` (W-J3) — biggest win.** A `scrollTop` sample over 3 s at every
  rAF returned 363 points, all identical — a *provably* flat line, i.e. zero
  residual sub-pixel scroll creep while idle. This converted "is there
  jitter?" from a hand-rolled in-page rAF eval loop into a one-call,
  tamper-proof measurement. The fixed-enum / no-agent-JS shape is the right
  call — it answered the exact question with no eval surface. **Follow-up
  (non-blocking):** long high-rate windows serialise large; an optional
  server-side `summary` reducer (`{min,max,distinctCount,firstChange,…}`)
  would keep the signal without the payload.
- **`wait_for({ text })` (W-J1) — works, one sharp edge (fixed).** SPA
  readiness after reload worked, but a short token timed out because the
  matcher lowered to Playwright's quoted/exact-ish text engine while the
  documented contract is *substring*. Doc-vs-behaviour mismatch; corrected to
  honour true substring matching (round-11).
- **Visibility-aware `find()` (W-J2) — not retriggered this run** (coords/
  eval_js used deterministically); the capability-aware warning design was
  reaffirmed as correct.

Net: the round-10 set turned claims into proofs. The only queued follow-up is
the optional `sample` reducer; the `wait_for` substring fix shipped in
round-11. Tracked in `docs/first-consumer-asks.md` (round-11).
