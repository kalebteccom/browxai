# Adoption report: multi-agent contest-reliability QA campaign (2026-05-19)

**Adopter:** Claude Code acting as team-lead over multiple `qa-expert`
sub-agents. Period 2026-05-18 → 05-19. Scope: a large multi-session,
multi-agent live-QA campaign against a deployed staging SPA (and a dev
tunnel), driving contest pipelines as host + multiple concurrent users, plus
an earlier mobile-chat verification. Target-agnostic by construction.

## TL;DR

browxai was **decisive** — it caught production-blocking bugs green test
suites missed (mobile chat jitter; realtime producer-count; a stage
deactivate/tear race), across device classes and multi-user realtime, which
nothing else in the stack could verify. The one thing that nearly sank the
campaign — **indefinite wedging** — is exactly what the W-M1 anti-wedge
deadline fixes; with that in, this is a strong **unattended multi-agent QA
platform**. Biggest remaining gap: purpose-built loading/transition capture.

## Scale / how it was used

- Managed **incognito** sessions, multiple per agent (a Desktop host + two
  mobile-emulated users), several agents concurrently → ~6 live contexts.
- **Device emulation** (`open_session({ device })`) — essential; the
  mobile-only bugs are unreachable without it.
- **`set_config`** to toggle `disableWebSecurity` for a CORS case, then
  confirm it off. Config-as-API is the right model.
- **`eval_js`** as the workhorse (forged-auth bootstrap via `localStorage` +
  reload, DOM/state assertions).
- Standard drive/measure surface (`navigate`/`click`/`screenshot`/`find`/
  `scroll`/`wait_for`/`sample`); out-of-band API for fast state setup.

## What worked well

- **Device + incognito multi-session isolation** — independent contexts,
  separate cookie jars/refs, zero cross-session bleed under load.
- **`sample` (rAF metric trace)** — turned "is there jitter?" into a
  tamper-proof flat-line proof. Fixed-enum / no-agent-JS is the correct
  safety posture.
- **`eval_js` forged-auth bootstrap** — CDP eval correctly bypassed page CSP
  where a page-injected script would have been blocked.
- **`ActionResult` richness** — `element.hit` before/after,
  `network.mutations` + `responseShape`, console capture — assert
  "fetch fired / panel opened" with no extra round trips.
- **Config precedence + `set_config`** (project/user layers) unblocked an
  otherwise-dead path mid-campaign.
- **`list_sessions`** was the critical recovery primitive when agents wedged
  — enumerate + force-close a wedged agent's sessions from the team-lead.

## The critical failure that W-M1 fixed

- **Symptom:** sub-agents driving slow/occasionally-stalling targets went
  silent for 28+ minutes — blocked *inside* an MCP call that never returned.
- **Root cause (pre-W-M1):** no client-side deadline on `eval_js` (a
  never-resolving in-page expression — the prime culprit), action bodies,
  read CDP paths on a wedged renderer, `await_human timeoutMs:0`.
- **Why prompt-level mitigation failed:** "check elapsed time before every
  call" is useless — the agent can't run its next guard because it's
  suspended inside the hung call. **Only a transport/runtime deadline can
  rescue a hung MCP round trip.** Single most important lesson.
- **Blast radius:** stranded sessions (memory pressure), orphaned seeded
  server state, repeated kill/relaunch cycles.
- **W-M1 worked:** hung calls return `ok:false "anti-wedge timeout"`; agents
  retry-once / abort cleanly. Endorsed shipped-on-by-default at the 5s default.

## Follow-on asks (problem classes — tracked as round-14)

1. **Bulk session reaping.** Per-id `close_session` is O(n) at multi-agent
   scale; a wedged/killed agent strands sessions. Want bulk close by prefix /
   all / idle-age.
2. **Act-then-trace.** A tool round trip is ~seconds, so `action` then a
   separate `read` lands *after* transient UI (spinner/pending) resolved →
   false "fine". Want: perform one action and return a bounded metric trace
   across the transition, in one call. Highest-value new capability.
3. **`sample` summary default** for long high-rate windows (token budget).
4. **Config `hideOverlaySelectors`** — auto-strip dev overlays that intercept
   coordinate clicks (every agent hand-rolled iframe removal).
5. Keep tightening visibility-aware `find()` — only-hidden-candidate results
   still mislead into coordinate fallbacks.
6. Docs: prefer a deployed target over a dev tunnel (tunnel first-load >15s);
   `navigate`'s deadline is a soft signal, not a hard failure.

## Net

Decisive for cross-device, multi-user, realtime verification the rest of the
stack can't do. W-M1 makes unattended multi-agent QA viable. Remaining gap:
loading/responsiveness capture tooling (ask 2).
