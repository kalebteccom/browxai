# browxai — Divergence Notes (Phase 0)

> Status: Phase-0 reference. The point of this doc is that every place browxai
> looks different from the two closest prior arts is a *deliberate* choice with a
> reason recorded here — not an accident of not-having-read-the-prior-art. Pair
> this with `../PHASE-0.md` and the design source of truth in the project-ideas
> repo (`projects/agent-browser-bridge/{spec.md,roadmap.md,research-open-questions.md}`).

The two closest prior arts:

- **Microsoft `@playwright/mcp`** — github.com/microsoft/playwright-mcp, docs at playwright.dev/mcp
- **Vercel Labs `agent-browser`** — agent-browser.dev, github.com/vercel-labs/agent-browser

(Anthropic Claude-in-Chrome is the *usefulness* bar but isn't a structural prior
art — it's Claude-locked, extension-only, no headless, and ships a side-panel
permission UI rather than a programmatic surface; it's covered in
`research-open-questions.md` §2–§3, not here.)

---

## 1. The two prior arts, one paragraph each

**Microsoft `@playwright/mcp`.** An MIT-licensed, model-agnostic MCP server that
exposes Playwright over the Model Context Protocol. Its core observation primitive
is `browser_snapshot`, which returns the page's *accessibility tree as text* with
`[ref=eN]` element refs; almost every interaction tool (`browser_click`,
`browser_type`, `browser_fill_form`, `browser_select_option`, `browser_hover`,
`browser_press_key`, `browser_navigate`, …) returns a *fresh full* accessibility
snapshot afterwards plus page metadata (URL, title, load state). It has a broad
surface — 70+ tools across core automation, tab management (`browser_tabs`),
network (`browser_network_requests`, `browser_network_request`, `browser_route`,
…), storage (`browser_cookie_*`, `browser_localstorage_*`, `browser_storage_state`),
devtools (tracing/video/`browser_annotate`/`browser_highlight`), PDF
(`browser_pdf_save`), testing assertions (`browser_verify_*`, `browser_generate_locator`),
and coordinate-based input (`browser_mouse_*_xy`) — and a capability system
(`--caps core,vision,pdf,devtools,network,storage,testing,config`; `core` on by
default). It runs a **persistent profile by default** (logged-in state survives
across sessions, stored under an OS cache path), with `--isolated` for an
in-memory ephemeral session and `--extension` to attach to an existing Chrome.
It has `--allowed-origins` / `--blocked-origins` (semicolon-separated; blocklist
evaluated first; explicitly *"not a security boundary"*, no redirect handling),
a `--no-sandbox` / `--sandbox` pair, and an open/closed prompt-injection thread
(issue #1479: hidden instructions in aria-labels land in the LLM context via the
a11y snapshot — closed with a docs-treat-it-as-untrusted recommendation, no code
mitigation). It is *good at*: being the broad, neutral, well-maintained
Playwright-over-MCP substrate; a kitchen-sink developer-facing surface; faithful
exposure of Playwright/CDP.

**Vercel Labs `agent-browser`.** A Rust **CLI** (client-daemon: the CLI talks to a
native daemon that drives Chrome over CDP) — *not* an MCP server. ~33k★. Its
observation primitive is `snapshot`, returning a *token-efficient* accessibility
tree (~200–400 tokens vs ~3–5k for a screenshot) with `@eN` element refs
(`- heading "Example Domain" [ref=e1]` / `- link "More information..." [ref=e2]`).
Its standout feature is `diff`: a **unified-diff-style text delta of the a11y
tree** — `+`/`-` lines for added/removed/changed accessible nodes
(`- button "Submit" [ref=e2]` / `+ button "Submit" [ref=e2] [disabled]`) plus a
summary line (`3 additions, 2 removals, 41 unchanged`), with `--selector` (CSS or
`@ref`) to scope, `--compact` to shrink each node line, and `--depth <n>` to limit
tree depth. Refs are **reused across snapshots** so a node keeps the same `@eN`
before and after an action — that's what makes the diff line-stable. ~50+
commands (`open`/`close`, `click`, `screenshot`, …). It does *not* own an
authenticated-session lifecycle — no built-in profile management, no
"attach to the human's logged-in Chrome" story. It is *good at*: being a
shell-pipeable, deterministic, deeply token-conscious browser surface for agents
that live in a terminal; the explicit a11y-tree `diff`.

---

## 2. What browxai borrows (copy vs. re-derive)

- **A11y-tree-as-the-snapshot** — from `@playwright/mcp` (and `agent-browser`).
  browxai's `snapshot()` returns the accessibility tree with stable element refs,
  not raw HTML. *Re-derive, don't copy:* we want a tighter, more aggressively
  scoped/paginated/prioritised serialisation than `@playwright/mcp`'s (its
  dev-first surface dumps the whole tree), so we write our own serialiser — but
  the *shape* (role + accessible name + key properties, `[ref=eN]` style) is
  proven and we adopt it.

- **The `tree_diff` mode + stable-ref scheme** — from `agent-browser`'s `diff`.
  browxai exposes `tree_diff` as a per-call `mode` on `ActionResult` (and a
  standalone diff helper), producing the same `+`/`-`-lines-plus-summary shape
  over the *compact a11y serialisation*. *Read the `agent-browser` diff
  implementation in Phase 1 before finalising* (`--compact`/`--depth`/`--selector`
  scoping are good ideas worth matching); the algorithm itself (line-diff of two
  compact snapshots) we re-derive. Whether to be *wire-compatible* with
  `agent-browser`'s exact diff text — see §5.

- **Re-snapshot-after-action as the baseline mental model** — from `@playwright/mcp`.
  The industry consensus (browser-use, Stagehand, chrome-devtools-mcp, Claude-in-Chrome
  all do it) is "re-observe rather than trust a diff", because page state mutates
  out-of-band. browxai keeps that as the *floor* — but ships a *scoped* re-snapshot
  by default, not a full one (see §3). *Re-derive:* the scoping/budgeting logic is
  ours.

- **`--caps`-style capability toggles and `--allowed/blocked-origins`-style origin
  controls** — *the ideas* from `@playwright/mcp`, deferred to browxai's Phase 2,
  and shipped with a tighter default set and the same honest "not a security
  boundary" caveat (see §3, last bullet).

What browxai does **not** borrow: the kitchen-sink 70-tool surface (we curate),
the persistent-profile-by-default-on-the-cache-path posture (we default to a
*managed dedicated* profile and treat "attach to the human's Chrome" as the
warned opt-in — see §3), the CLI/daemon architecture (`agent-browser`), or
faithful 1:1 Playwright exposure as a design goal.

---

## 3. Where browxai diverges, and why

**(a) MCP-native server — not a CLI shell tool, not raw Playwright.**
`agent-browser` is a Rust CLI: an agent drives it by shelling out and parsing
stdout. `@playwright/mcp` is MCP-native but its callers often end up reaching for
raw Playwright/CDP underneath when they need lifecycle control it doesn't model.
browxai is a first-class MCP server (`@modelcontextprotocol/sdk`, TS/Node)
exposing a *curated* tool set over the standard MCP transport — no shell shim
required, no model-specific behaviour, and the lifecycle (next bullet) is *in the
server*, not something the caller bolts on. *Why:* the primary consumer
(site-docs's calibration stage and its host agent) and the secondary consumers
(MCP clients generally) want to call tools, not parse a CLI; and the
auth-session lifecycle has to be owned somewhere — putting it in the server is
the whole point.

**(b) `ActionResult` = scoped a11y re-snapshot + always-on cheap signals — not a
full re-snapshot (`@playwright/mcp`) and not just a diff (`agent-browser`).**
After `click`/`fill`/`navigate`/etc. browxai returns a structured `ActionResult`
whose centrepiece is a **scoped** re-snapshot — the subtree around the acted-on
element + any newly-appeared top-level region (dialog/toast/new tab) — *plus*
always-present cheap signals: `navigation` (from/to/`kind` ∈ `full_load`|`spa`|`hash`|null),
`structure` (`appeared`/`removed`/`newTabs`), `console.errors` + `pageErrors`,
and a per-element `element` confirmation (`stillAttached`/`value`/`checked`/`focused`).
Network is *summarised by default* (per-request list only under a count cap;
URLs/headers/bodies redacted/truncated unless opted in). The `mode` is **per
call**: `scoped_snapshot` (default) | `tree_diff` (the `agent-browser`-style
unified delta) | `full` (the `@playwright/mcp`-style whole fresh snapshot) |
`none`. A `MutationObserver` (installed via the on-page helper) is the
change-*detector* only — it tells the server which subtrees to re-serialise; its
records are never handed to the model. *Why:* `@playwright/mcp`'s full re-snapshot
is robust but expensive on big pages; `agent-browser`'s diff is cheap but can miss
out-of-band changes and presumes the caller holds the prior snapshot. The scoped
re-snapshot is "fresh observation, but only the part that changed + any new
region" — robust like a re-snapshot, cheap like a diff — and the always-on
`navigation`/`structure`/`errors`/`element` block is the single highest-value,
cheapest signal agents constantly mis-judge ("did that click navigate?"). See
`research-open-questions.md` §1 for the full shape and rationale.

**(c) Owns the BYOB / persistent-profile / CDP-attach / `httpOnly`-session
lifecycle and the `window.__browx` human↔agent channel — neither prior art does.**
`@playwright/mcp` has *a* persistent profile and an `--extension` mode but doesn't
model "attach the bridge to a Chrome the human launched and logged into so authed
flows just work" as a first-class, security-gated capability; `agent-browser` has
no profile/session management at all. browxai owns: launch-with-managed-profile
(default), CDP-attach to an external human-launched Chrome (BYOB — off by default,
behind an explicitly-named "I-accept-the-risks" flag with a loud warning),
loopback-only CDP, injecting captured `httpOnly` cookies into a fresh context, and
`window.__browx` — the generalised human↔agent helper channel
(`signal`/`proceed`/`abort`/`done` human→agent; a server-side
`awaitHuman({kind,prompt,choices?,timeoutMs?})` agent→human with
`kind` ∈ confirm/choose/input/pick_element/acknowledge; a `pick_element` overlay
returning the same locator+evidence record `find()` produces), transported over a
CDP binding (`page.exposeBinding`/`Runtime.addBinding`) re-injected per navigation,
with a DOM-attribute-polling fallback. *Why:* this lifecycle is *the* friction
that motivated the project — site-docs's calibration stage hit the
`httpOnly`-cookie / separate-instance wall with Claude-in-Chrome; neither prior
art removes it; this is browxai's load-bearing differentiation. (Seeded by
site-docs's `PlaywrightInstrumentedBrowser` / `manual-capture` prototype —
`--cdp`, `profileDir`, `window.__siteDocs.capture()` — which covers ~60%.)

**(d) Token-efficiency as a first-class output-shape constraint.**
`@playwright/mcp`'s surface is dev-first: broad, faithful, not optimised for an
LLM consumer's context budget. browxai treats every tool's output shape as an
LLM-consumer optimisation problem: `snapshot()` is compact/scoped/paginated/prioritised
by design; `ActionResult` carries a `maxResultTokens` budget (default ~600) where
`snapshotDelta` is the elastic part truncated first (deepest/least-relevant nodes
dropped), then the `network.requests` list collapses to its summary, while
`navigation`/`structure`/`console.errors`/`pageErrors`/`element` are always kept,
and a `warnings[]` note fires when truncation happened. Every result carries a
`tokensEstimate`. *Why:* this *is* the deliberate differentiator vs.
`@playwright/mcp`'s dev-first surface (and it's the dimension `agent-browser` got
right — we adopt the discipline, not the CLI). It's an NFR, not a nice-to-have.

**(e) `find(query)` — ranked candidate locators + evidence. Neither prior art has
this exact surface.** `@playwright/mcp` has `browser_generate_locator` (turn a ref
into a Playwright locator) but not "given the natural-language description 'the
primary submit button on the checkout form', here are ranked candidates with
evidence"; `agent-browser` has `snapshot` + refs but no NL→ranked-candidates step.
browxai's `find(query)` returns ≥1 ranked candidate with structured evidence per
candidate — role, text, test-id, bounding box, screenshot crop, position. Heuristic
ranking ships in Phase 1; learned/feedback-driven ranking is Phase 2 (the *how* of
the heuristics is the open Phase-1 design question, not the *whether*). *Why:*
"resolve an ambiguous element description confidently" is exactly what site-docs's
calibration stage leaned on Claude-in-Chrome's smart-targeting for; it's the
second pillar of the curated surface (after action-diffs) and the thing Phase 0's
spike measures (does it cut agent retries / wrong-element actions vs. raw
navigate/click/snapshot?).

**(f) Security posture — tighter default than `@playwright/mcp`'s.** browxai
*borrows the ideas* (`--caps`-style capability toggles; `--allowed/blocked-origins`-style
origin controls; the honest "not a security boundary" disclaimer) but ships a
tighter default and a phased rollout:
  - *Phase 1 non-negotiables (cheap, ship now):* default mode is launch-with-a-**managed
    dedicated profile** (Playwright-downloaded Chromium, `profileDir` *separate from
    the human's daily-driver Chrome*, normal flags, **sandbox on**) — contrast
    `@playwright/mcp`'s persistent-profile-on-the-cache-path default and its
    `--no-sandbox` opt-in being roughly symmetric with `--sandbox`. BYOB/CDP-attach
    is **off by default**, gated behind an explicitly-dangerous flag name with a
    loud one-time warning naming what's exposed (the real profile, SOP if
    `--disable-web-security` is needed, the unauthenticated CDP port). CDP bound
    to `127.0.0.1` only (or a unix socket/pipe). All page content
    (`snapshot()`/`find()`/`ActionResult.snapshotDelta.tree`) treated as untrusted
    input — the server never interprets it, ranking heuristics are not promptable,
    tool docs tell the host agent it's attacker-controlled (the #1479 lesson, with
    a code posture, not just a docs note).
  - *Phase 2:* the full model — capability toggles (navigation / network-read /
    file-download / file-upload / multi-tab / BYOB-attach / console-read, each
    independently enable-able, restrictive default set), origin allow/blocklist
    (blocklist-first, redirect-aware where possible, documented as defense-in-depth
    not a boundary), confirmation hooks (wired to `awaitHuman`) for
    navigation-off-allowlist / file I/O / BYOB actions, profile isolation as the
    documented default, network-egress visibility in `ActionResult.network`, and a
    written threat-model doc.
  *Why:* a browser-control server defaulting to "your real Chrome profile + a
  debugging port any local process can attach to" is a footgun (`chrome-devtools-mcp`'s
  blunt "you've been warned" posture, the ClaudeBleed extension-hijack, #1479);
  browxai's default path should be safe, with everything more powerful an explicit
  warned opt-in. (Full deferral rationale: `research-open-questions.md` §3 and
  roadmap Phase 2.)

---

## 4. Ref-scheme compatibility note

**One serialisation, one ref scheme, everywhere.** browxai's `snapshot()`,
`find()` candidate refs, and `ActionResult.snapshotDelta.tree` (in *all* modes,
including `tree_diff`) MUST use the **byte-identical** compact a11y serialisation
and the **identical** ref scheme. A ref an agent learns from an `ActionResult`
delta must be immediately usable as the target of the next `click`/`fill`, and a
ref from `find()` must mean the same node as the same ref in a later `snapshot()`.
This is the single most important coherence constraint in the curated surface.

To make that work, assign refs by a **stable element key** — e.g. a hash of
(role + accessible name + DOM path), reused for the same node across snapshots —
**not by enumeration order**. This is the `agent-browser` approach (refs survive
across snapshots, which is what makes its `diff` line-stable) and it is the
*deliberate divergence from `@playwright/mcp`*, whose `[ref=eN]` refs are
*per-snapshot* — "session-scoped, change after navigation or DOM updates, valid
only within the current snapshot context". Per-snapshot refs are fine for
"snapshot → act-on-a-ref-immediately" but break the moment you want a stable diff
or want a `find()` result to remain valid across an intervening observation.
Concretely: a node that moved in the DOM but kept its role+name should keep its
ref; a genuinely new node gets a new key; refs are stable across `scoped_snapshot`
deltas and `tree_diff` deltas alike.

(Open Phase-1 detail: collision/relabel policy when role+name+path isn't unique
— append a disambiguating index but keep it deterministic; and how aggressively
to normalise the DOM-path component so trivial wrapper-div churn doesn't rotate
the key.)

---

## 5. Things to watch / decide in Phase 1

- **Wire-compatibility with `agent-browser`'s diff text format.** browxai's
  `tree_diff` mode emits a `+`/`-`-lines-plus-summary delta of the compact a11y
  serialisation — the same *shape* as `agent-browser`'s `diff`. Decide whether to
  be *byte-compatible* (so tooling/parsers written against `agent-browser` work
  unchanged) or merely *shape-compatible* (same idea, our own line format tuned to
  our serialiser). Lean shape-compatible unless someone actually wants the
  interop; read the `agent-browser` `diff` source first.
- **Whether to expose a CLI shim too.** browxai is MCP-native by design, but a
  thin `browxai <cmd>` CLI over the same server (à la `agent-browser`'s ergonomics)
  could be cheap and useful for shell-based agents / debugging. Not in MVP scope;
  flag it for Phase 1+ as a small follow-on if demand appears — don't let it pull
  the surface dev-first.
- **The `exposeBinding`-lost-on-multi-CDP bug** (Playwright #34359 — exposed
  bindings can be clobbered when a second CDP client attaches to the same target).
  Directly relevant in BYOB mode (where the human's Chrome may have DevTools or
  another tool attached). Mitigations to build/verify in Phase 1: re-assert the
  init script on `framenavigated`/new-target events; detect a missing `__browx`
  binding and re-inject; fall back to DOM-attribute polling when the binding
  proves unreliable. Validate this *in the BYOB path* during the Phase-0/Phase-1
  spike, not just in clean managed-profile launches.
- **`maxResultTokens` defaults and truncation order** — confirm the ~600-token
  default and the truncation priority (drop `snapshotDelta` deepest-first → collapse
  `network.requests` to summary → never drop `navigation`/`structure`/`console.errors`/`pageErrors`/`element`)
  against real calibration-task `ActionResult`s in the spike; adjust before Phase 1
  freezes the shape.
- **Origin-default semantics** — when the caller (site-docs knows its target site)
  supplies expected origins, default `--allowed-origins` to them even though it's
  "not a security boundary"; decide the exact API for that and whether it warns on
  navigation outside the set even in Phase 1 (the Phase-2 confirmation hook hangs
  off this).

---

## Sources

- microsoft/playwright-mcp (README, tool list, `--caps`, `--isolated`, `--allowed/blocked-origins`, `--no-sandbox`): https://github.com/microsoft/playwright-mcp
- Playwright MCP — Snapshots (a11y snapshot format, `[ref=eN]`, ref stability): https://playwright.dev/mcp/snapshots
- Playwright MCP — Introduction / config: https://playwright.dev/mcp/introduction
- playwright-mcp issue #1479 (indirect prompt injection via a11y snapshots): https://github.com/microsoft/playwright-mcp/issues/1479
- playwright-mcp issue #1210 (restore `--allowed-origins`): https://github.com/microsoft/playwright-mcp/issues/1210
- Vercel agent-browser — site (CLI/daemon architecture, `snapshot`, `@eN` refs, token figures): https://agent-browser.dev/
- Vercel agent-browser — Diffing (`diff` output, summary line, `--selector`/`--compact`/`--depth`, stable refs): https://agent-browser.dev/diffing
- vercel-labs/agent-browser (repo): https://github.com/vercel-labs/agent-browser
- Playwright issue #34359 (exposed bindings lost with multiple CDP connections): https://github.com/microsoft/playwright/issues/34359
- Playwright — BrowserContext API (`exposeBinding`): https://playwright.dev/docs/api/class-browsercontext
- ChromeDevTools/chrome-devtools-mcp (security posture, for contrast): https://github.com/ChromeDevTools/chrome-devtools-mcp
- LayerX — "ClaudeBleed" extension-hijack flaw (plumbing-gets-popped reminder): https://layerxsecurity.com/blog/a-flaw-in-claudes-browser-extension-allows-any-extension-to-hijack-it/
- browxai design source of truth (project-ideas repo): `projects/agent-browser-bridge/{spec.md,roadmap.md,research-open-questions.md}` (2026-05-12)
