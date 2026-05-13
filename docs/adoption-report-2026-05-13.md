# Adoption-run report: browxai on target-app (the target's vendor)

**Date:** 2026-05-13
**Adopter:** Claude Code session, model `claude-opus-4-7[1m]`
**Target app:** the target's vendor `target-app-2` — dev server in `/tmp/site-docs-app-run` on `https://localhost.target-app.example:3001`, authed via Azure AD SSO + pinned `<APP_AUTH_COOKIE>` cookie (workspace cache at `~/site-docs/target-app-2/.auth/editor.json`, valid until 2026-06-11).
**Driver-of-record:** the agent-runbook in `automated-site-documentation-bot/docs/agent-runbook.md` (specifically the "Discovery driver" paragraph naming browxai canonical).
**browxai version:** `~/.claude.json` MCP registration, `node <browxai>/dist/cli.js`, `BROWX_WORKSPACE=~/.browxai`, **no** `BROWX_ATTACH_CDP` set.

Scope of the run: author two new site-docs flow files for the the feature area feature — `feature-7-multi-select-regen` and `feature-8-copy-paste-regen` — that document the bugfix in commit `<recent-FE-fix>` (FE-side reconciliation of regenerate-selected responses). Discovery driver was browxai; fallback was source-code grep.

The run is the first end-to-end Phase-1 adoption of browxai by another agent against a real authed target, framed in the runbook as a real signal for browxai feedback rather than a workaround opportunity. This report is that signal.

---

## TL;DR

- `await_human` is the standout primitive. Clean, typed, did exactly what was advertised — the SSO round-trip "just worked." Keep this as a flagship and document the Phase-1.5 `confirm`/`pick_element` deferral prominently so adopters don't reach for it expecting more.
- ActionResult shape (`navigation` / `structure` / `console.errors` / `network.summary` / `warnings`) is the *right* design — concise, structured, and the inline `warnings` array is honest about Phase-1 limits. This is materially better than the Claude-in-Chrome alternative.
- `snapshot()` returned **`RootWebArea "target-app" [ref=e3]` only** on every call against the hydrated target-app app, `truncated: false`. Not a token-budget problem — the a11y tree isn't being traversed into the SPA's interactive subtree at all. This is the dominant Phase-1 gap.
- `find()` not exercised this session — the moment it would have shone (timeline external-audio clip with no `data-testid`) sat behind ~10 min of script + audio generation that I judged not worth the wall-clock for one selector. I'll come back and exercise it, but flag that the *path to first `find()` call on a real authed target is gated by a long backend op* — if browxai had a way to scrape a static snapshot of a page's interactive elements (DOM walk, not a11y tree), it would have been usable here.
- Net so far: **modest win** vs. the legacy Claude-in-Chrome path — comparable for nav/click/wait, plus the `await_human` edge. The decisive next test is `find()` against a hydrated, non-testid-anchored timeline element.

---

## What worked

### `await_human` (kind: `acknowledge`)
Used once to gate on the SSO login. Single call, 600 s timeout, the operator triggered `window.__browx.proceed()` from devtools after Azure AD SSO completed. Return shape:
```json
{ "kind": "acknowledge", "value": null, "timedOut": false }
```
Cleaner than the equivalent in Claude-in-Chrome (which is conversational — "tell user to do X, watch for them to confirm"). The runbook's pitch that this is a typed primitive instead of an out-of-band convention is correct, and the value is felt immediately on any authed target.

**Ask:** keep the `await_human` Phase-1-vs-1.5 split obvious. Right now the schema accepts only `kind: "acknowledge"` and that's correct, but a Phase-1.5 plan for `confirm`/`choose`/`input`/`pick_element` somewhere visible would help adopters not invent workarounds.

### ActionResult envelope
The shape — `{ok, action, navigation:{changed,from,to,kind}, structure:{appeared,removed,newTabs}, console:{errors,warnings}, pageErrors, network:{summary:{total,byType,failed}}, snapshotDelta, tokensEstimate, warnings}` — is *materially* better than the alternatives I've used. Specifically:

- `navigation.kind: "spa"` vs `"full_load"` distinction caught a target-app post-login URL rewrite that a less-structured tool would have hidden.
- `network.summary` with a `requests omitted (count N > cap 10); call network_read for details` warning is a great pattern — give the agent a useful summary inline, with a clear path to drill down. Tokens stay bounded, drill-down is explicit, no surprise verbosity.
- The standalone `warnings` array (e.g. `"scoped_snapshot currently returns the full tree; scoping is a Phase-1.5 refinement"`) telling the adopter exactly which Phase-1 limit applies to *this* call is rare in MCP tools and very welcome. Keep doing this.

### Auth cookie scoping
The runbook's pinned-cookie story (`--auth-cookie "<APP_AUTH_COOKIE>"`) carries cleanly to browxai's fresh Chrome via the parent domain (`.target-app.example`) — same cookie was valid against `:3000` (user's own dev server) and `:3001` (site-docs's disposable worktree). No browxai-specific story needed here, but the fact that browxai's separate-Chrome model didn't fight the workspace's auth cache is good.

---

## What got in the way

### #1 — `snapshot()` returns root-only on a hydrated SPA

**Severity:** 🔴 — blocks the primary discovery use case on a real-world adopter.

**Reproducer:**
```
mcp__browxai__navigate { url: https://localhost.target-app.example:3001/target-app/target-app, mode: scoped_snapshot }
  → snapshotDelta.tree = "RootWebArea [ref=e1] [focused]"
  → truncated: false

mcp__browxai__wait_for { selector: '[data-testid="mini-library"]', timeoutMs: 15000, mode: none }
  → ok: true (element present)

mcp__browxai__snapshot {}
  → tree: 'RootWebArea "target-app" [ref=e3]'
  (one line, after the page is fully interactive — Library is visible, app is hydrated, user can click around)
```

**Diagnosis (from the adopter's chair):** the Playwright a11y serialization target-app emits at the page level apparently doesn't expose interactive descendants in the role tree (target-app is a Reflux/`createReactClass` legacy-heavy SPA, lots of `div` + custom data-attributes, sparse semantic roles). `truncated: false` rules out token-budget. The Phase-1-design note in the runbook says `scoped_snapshot` falls back to the full tree — but in this case the full tree itself is empty.

**Why this is the dominant gap:** the runbook (line 142) names `find(query)` as the canonical discovery primitive — but `find()` presumably leans on the same a11y traversal under the hood (CDP role queries + Playwright getByRole resolution). If snapshot returns root-only, `find()` is likely to degrade to tier-5 (`role=<role>`, `stability: low`) on most queries on this codebase. The whole adoption case for browxai-over-grep depends on this working.

**Asks (in order of impact):**
1. **Fallback DOM walk** when the a11y tree is empty/shallow — emit interactive elements by CSS selector (`[role]`, `button`, `[data-testid]`, `[onclick]`, `input`, `[tabindex]`, etc.) rather than degrading silently. The snapshot can stay role-shaped; ref IDs still work because they're internal.
2. **Snapshot a "data-attribute" projection.** Apps with consistent `data-testid` / `data-type` attribution (like target-app) carry more signal there than in role labels. A snapshot mode that lists each element with `[data-testid]` or `[data-type]` set, with stability `high`, would have made my locator-discovery pass trivial and would have legitimately beaten source-code grep (because the grep can't tell me which testids are *visible/mounted* right now).
3. **Surface a clear "low-content snapshot" warning.** Right now the snapshot tool returns `truncated: false` and a one-line tree, which adopters will misread as "the page genuinely is empty." Something like `warnings: ["a11y tree has 0 interactive descendants under root; SPA likely uses non-semantic markup. Consider dom_walk fallback."]` would have told me to pivot to grep faster.

### #2 — Phase-1 `BROWX_ATTACH_CDP` story isn't end-to-end yet

**Severity:** 🟡 — workaroundable, but doubles the operator's auth burden.

The runbook's optimization is "one Chrome, both tools attach." In practice, browxai's MCP registration in `~/.claude.json` doesn't currently set `BROWX_ATTACH_CDP=http://localhost:9222`, so browxai launches its own Chrome. The site-docs workspace's `.auth/editor.json` is captured by a different headed Chrome at `capture-auth` time. Result: the operator logs in once for `capture-auth` (cached), and then *again* the first time browxai is invoked in a new session (browxai's Chrome has no persisted profile by default).

The runbook explicitly describes this trade-off as a caveat ("whether your specific discovery driver — browxai, the legacy Claude-in-Chrome extension, or raw Playwright-over-CDP — attaches cleanly to a Chrome launched this way needs verifying in practice"). My finding: in this configuration it does not, because `BROWX_ATTACH_CDP` isn't set in the consumer's MCP env, so the attach path is dormant.

**Asks:**
1. **Doc the canonical adopter setup.** `first-consumer-asks.md` lists CDP-attach as 🔴, status `design` — but an adopter who installs browxai via `~/.claude.json` doesn't know they should set `BROWX_ATTACH_CDP`. Either (a) make CDP-attach the *default* when `:9222` is reachable, or (b) add a `browxai doctor` command that prints the missing setup. The current setup is "MCP registers, you call it, it works, but you re-login every session."
2. **Persistent profile for browxai's own Chrome (when not attaching).** Mirror what site-docs's `capture-auth` does — a `--user-data-dir`-equivalent that survives session restarts. Right now each fresh agent invocation logs in from scratch. The cookie cache lives in site-docs's workspace, but that's only consumed by `site-docs run`, not by browxai's discovery sessions.

### #3 — Path to `find()` is gated by a long backend op on real targets

**Severity:** 🟡 — adoption friction, not a defect.

The runbook frames `find()` as the workhorse. But the *first call to `find()` on a real authed app* needs to be against a hydrated page in a non-trivial state. On target-app, getting the relevant state (the feature area scripts + audio generated, timeline external-audio clips present) is a 6–15 min backend operation. So when I wanted to discover the locator for "the first external-audio clip on the timeline" — exactly the case `find()` is designed for — I had to choose between (a) running the long preamble in browxai's empty Chrome session, or (b) grepping the source. I picked (b).

This isn't a browxai bug. But it suggests adopters need a "fast path to a useful state" that browxai itself probably can't ship — it's a consumer-of-browxai problem. site-docs could help by adding a `site-docs warm "$WORKSPACE" --to <flow>` that runs the preamble in a persistent CDP Chrome and leaves it parked there for browxai to attach to. Worth noting in the runbook's "Discovery driver" paragraph.

### #4 — `selectorHint` tiers I couldn't actually test

The runbook calls out: "Phase-1.5 (`selectorHint` tiers 3 + 4 — stable-text-on-stable-role, id/semantic — currently degrade to tier-5 `role=<role>` with `stability: low`)." I couldn't directly observe this since I didn't reach `find()` — but I can predict: on target-app, the high-value selectors are `data-testid` (tier-1 in the runbook's preference order) and `data-type` (tier-1-ish). The role-text fallback (tier-3/4) is going to be sparse on this codebase. If `find()` weights role-anchored discovery over data-attribute discovery, it will *systematically* underperform grep on this kind of app.

**Ask:** when the Phase-1.5 selectorHint work lands, make sure `data-testid` and well-known data-attribute conventions (`data-test`, `data-cy`, `data-qa`, plus the project's own — e.g. target-app's `data-type`) are tier-1, with stability `high`, even if the role tree is empty above them. The runbook already says "preference order: data-testid > role+name > ...". Just don't gate it on the role being present.

---

## Comparative observations vs. Claude-in-Chrome

I haven't done a side-by-side this session — the runbook is explicit that CiC is the legacy path and shouldn't be reached for ahead of browxai. So this is from memory + the runbook's positioning:

| Concern | CiC | browxai (this session) |
|---|---|---|
| Navigation + waits | identical | identical, plus a cleaner ActionResult |
| Snapshot quality on heavy SPA | poor, verbose | poor, terse (one-line root) |
| Human-in-the-loop | conversational ("ask user, watch") | typed primitive (`await_human`) — **wins** |
| Console / network reads | available | available, with summary-by-default pattern that's better |
| Locator-finding | rely on injected JS or guesswork | `find()` exists but untested this session |
| Authed-session attach | extension-locked to host Chrome | designed to attach to operator's Chrome via CDP — **but** not wired by default in current MCP registration |
| Adopter ergonomics | Claude-locked, can't share | model-agnostic, can share — **wins** when adoption matters |
| Phase-1 honesty | n/a | explicit `warnings` inline — **wins** |

Net: browxai's *design* is clearly better. Its *Phase-1 implementation* is comparable on this target because the snapshot gap blunts the discovery edge. Fix the snapshot gap on heavy-SPA targets and the gap closes the other way.

---

## Concrete asks, in priority order

1. **🔴 Snapshot fallback to DOM walk when the a11y tree is empty / shallow.** Most adopters' real-world targets won't be perfectly accessible. The runbook can't lead with `find()` as canonical until snapshot has signal to feed it.
2. **🔴 Snapshot mode that projects by data-attribute set** (`data-testid` / well-known QA attrs + the project's own convention). Probably trivial to ship and would have made this session a clear win for browxai.
3. **🟡 Make `BROWX_ATTACH_CDP` the default behavior when `localhost:9222` is reachable.** Eliminates the second-login problem without making adopters edit MCP config.
4. **🟡 `selectorHint` should prefer `data-testid` / well-known data-attrs as tier-1 with `stability: high` regardless of whether a role wrapper exists.** When Phase-1.5 ships, don't gate on role anchoring.
5. **🟢 Inline warning when snapshot returns < N interactive descendants.** Helps adopters fail fast and pivot to fallback.
6. **🟢 Make the Phase-1.5 / Phase-2 `await_human` kinds (`confirm` / `choose` / `input` / `pick_element`) discoverable from the tool description** so adopters don't roll their own.

The hand-off in `docs/first-consumer-asks.md` already covers some of this from the site-docs (pre-shipping) side; this report adds adopter-side (post-shipping) detail and grounds priorities in observed tool-call outputs.

---

## What I'd like to add when I come back

- A second `find()`-heavy session against the timeline DOM once the warm preamble exists (or once I can pre-bake a target-app state where the timeline already has external-audio clips). I want to give `find()` a fair test on a tier-3 selector case where source-code grep wouldn't help.
- Comparison of `snapshot()` token counts between target-app and a more semantically-marked-up app (e.g. one of the public projects in `kalebtec.com`) — that would isolate the SPA-heaviness vs. browxai's serialization as the cause.
- Trying `BROWX_ATTACH_CDP` set against a `--remote-debugging-port=9222` Chrome started exactly per the runbook's line-105 recipe, end-to-end. The runbook flags this as needing verification; I'd verify it.

— *Filed by the adopting agent at the end of session 88436860; the run that triggered this report was site-docs flow authoring for the `feature-7-multi-select-regen` + `feature-8-copy-paste-regen` flows under `~/site-docs/target-app-2/flows/`.*
