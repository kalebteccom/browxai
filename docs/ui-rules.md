# Kalebtec product rules (all products, all changes)

Seed copy, owned by the orchestrator. The rules live IN each repository, in its agentic instructions (CLAUDE.md and AGENTS.md, written out in full, plus docs/ui-rules.md for the detail), committed and kept current as we go. They must not depend on anything outside the repo and must survive the end of the orchestrator work. Every new feature, fix and copy change follows them. A rule learned in one product is committed in that repo and broadcast so every other repo gets it.

Source: Rowin 2026-10-24 (orders 29, 30, 31, 32, 33).

## 1. Public and user-facing copy

- No operator or private info on any user-visible surface: env var names, config keys, internal ids, hostnames, ticket ids, procedures, infra detail, internal tool names, confidentiality framing. Legal minimum, plus GTM copy that doesn't leak procedures.
- Developer-facing products keep documented env vars, flags and tool names that a user is meant to set. Operator or maintainer-only detail never appears.
- Empty states and errors say what the user does next, never what the operator configures.
- Cut words by about 50%. Plain language, no jargon, no filler, no stacked adjectives, no heading restated in the next line. No duplicated activity text.
- All shipped locales get the same change (en, es and the others that exist). Never change the meaning of a published promise, price or legal text.
- CI check on every repo for ALL_CAPS_WITH_UNDERSCORES, env var names, internal hostnames and ticket ids in public output.

- Tool descriptions, refusal text and error messages shown to users or models never cite ARD, ticket or internal ids.

## 2. Design system

- One spacing scale, one radius scale, one type scale per product, sharing token names across products.
- One component per pattern (page, sheet, section, list row, card, badge, button, code block, carousel, chip, property row). A pattern in 2 or more places is a shared component. Extend before extracting.
- No raw padding, margin or font classes outside the primitives. A guard in CI enforces it.
- Reference quality bar: Linear. Tight rows, title first with the id as a quiet prefix, quiet property lists instead of boxed chips, compact grouped headers, empty relations collapse into one add control.
- Sans for text. Mono only for ids, code and tabular numbers.
- One floating action at most, it never covers content and never duplicates a header action.
- Touch targets at least 44px. Visible focus. Reduced motion respected.

## 3. Geometry, responsiveness and overflow (checked on every screen, sheet and component)

- Centering: icon in button, button in row, badge on icon. Child centre within 1px of parent centre where centred.
- Equal insets left and right. Sheet gutter on every block, no block flush to the screen edge unless it is intentionally full bleed.
- No horizontal scroll, no clipped or covered content, no text past its container, no overlapping fixed elements.
- Widths: 320, 360, 390, 430, 768, 1024, 1280, 1920, portrait and landscape. Keyboard open (composer sits flush above it), safe areas, long strings, large text.
- Both themes, every shipped locale.
- Automate: browxai overflow_detect plus bounding-box checks. Cheap static guards in CI.
- The layout check script lives in the repo and runs the full width matrix, not one-off manual checks.
- Verify computed style on production, not only in source: a CSS declaration can vanish from the production bundle (cookie banner padding).

## 4. Interaction and mobile-friendly controls

- Every pattern ships with its mobile-native control, not only the desktop one. A pattern is not done until it works by touch.
- Carousels, galleries, lightboxes, tab strips and steppers: touch swipe with snap and rubber-band, drag, keyboard arrows, counter or dots inside the frame, safe-area aware, one shared component. Every carousel in every product uses it.
- Sheets, drawers, modals and popovers: swipe or drag down to dismiss, drag handle where it applies, tap outside to close, Escape, focus trap and return, bottom placement on mobile.
- Horizontally overflowing rows (chips, tabs, filters): scrollable with snap and an edge fade, never clipped.
- Lists: swipe or long-press row actions where desktop has hover actions, pull to refresh where data refreshes, tap targets at least 44px.
- Forms: right input type and autocomplete, composer flush above the keyboard, primary action reachable one-handed.
- Hover-only affordances always have a touch equivalent.
- Lists and rows keep the title readable on mobile: no row actions that truncate it.
- Onboarding and first-run paths are tested end to end with real commands in a clean environment.

- Lazy-loaded chunks have a stale-build path: a dead hashed chunk after a deploy reloads the page once, never retries forever, and a chunk landing late never steals focus.

- Performance changes that add eager loading never load the hidden theme variant of an image.
- Generated strings never carry env var names unless users set them. Tool-string cuts update their pinned tests in the same PR (ship as their own PR when many tests pin them).

## 5. Proof before push

- Real screenshots at 390 and 1280 via browxai before each push. Before/after pairs for UI changes, attached to Rowin through expose_artifact when a batch lands.
- One gate and one deploy per integration batch (order 23).

- Audits and sweeps read files from real main (`git archive refs/remotes/origin/main`), never a working tree or a bare `origin/main` that can resolve to a stale local ref. A sweep that reads shipped locales reads them from that same snapshot.
- Before copying this file into a repo, check for an existing docs/ui-rules.md. If one exists, keep it, add this file beside it (docs/kalebtec-ui-rules.md) and link both from the top.

- Reviewer and audit agents can be cut off by tooling outages mid-run. A partial result is marked PARTIAL and the unchecked parts are re-run.

## 6. Learning loop

- Any correction from Rowin, any finding from an audit and any bug class that repeats becomes a rule in this file the same day, with a date and the trigger in one line.
- Leads report new rules in the hourly CONFIRM ("rules learned: ..."). The orchestrator merges them here and broadcasts the diff.
- Every PR description has a one-line "ui-rules checked" statement. Reviewers (human or agent) reject UI changes without it.

## 7. Where the rules live

- In the repo: CLAUDE.md and AGENTS.md carry the rules in full (not only a link), docs/ui-rules.md carries the detail and examples. Both are committed, reviewed and updated in the same PR that introduces or changes a rule.
- Sub-agent and builder briefs say "follow CLAUDE.md and docs/ui-rules.md".
- Nothing in ~/.local/state is a dependency. It is a seed and a broadcast channel.

## Rules log

- 2026-10-24: no env var names on public pages (websites operator queue).
- 2026-10-24: carousels swipe on touch.
- 2026-10-24: centering and insets are checked, not eyeballed (remotxai stop button off-centre).
- 2026-10-24: no block flush to the screen edge on sheets (remotxai Ordenadores).
- 2026-10-24: every pattern includes its mobile-native control (swipe on every carousel, drag-to-dismiss sheets, touch equivalents for hover).
- 2026-10-24: rules live in each repo's agentic instructions and stay current there.
- 2026-10-24: (trackxai) tool descriptions and refusal text carry no ARD or ticket ids.
- 2026-10-24: (trackxai) lazy chunks need a stale-build path and must not steal focus.
- 2026-10-24: (trackxai) audits read from real main via git archive, not a working tree.
- 2026-10-24: (browxai) layout script lives in the repo and runs the width matrix.
- 2026-10-24: (kw) verify computed style on prod; eager-loading perf changes never load the hidden theme variant.
- 2026-10-24: (kw, order 35) a card and its shadow fit the viewport at 320, gutter at least the shadow spread.
- 2026-10-24: (kw, order 35) fixed or last-in-page controls pad with env(safe-area-inset-bottom) and the page uses dvh with viewport-fit.
- 2026-10-24: (kw, order 35) input:-webkit-autofill is overridden to the field tokens in every theme.
- 2026-10-24: (kw, order 35) a pending button state always has a timeout and a failure path that restores the label and announces the error.
- 2026-10-24: (remotxai, order 35) a default entity name ("New host") is a bug: name from the source at creation.
- 2026-10-24: (remotxai, order 35) auth prompts never auto-fire on arrival and never show an error before a user action.
- 2026-10-24: (remotxai, order 35) a connect screen reaches a terminal failure state in under 30 s and names the cause.
- 2026-10-24: (remotxai, order 35) a queued label on a message clears the moment its turn starts.
- 2026-10-24: (docsxai) a public repo gets a sanitized copy of the rules file: no orders, tool names or sibling-product anecdotes.
- 2026-10-24: (docsxai) a green gate can hide Chromium-only regressions when CI skips browser tests: keep the browser keystones in the loop on the CI box.
- 2026-10-24: (docsxai) secret-scan runs per commit: build credential-looking test literals from pieces.
- 2026-10-24: (Rowin, order 36) status, helper, error and progress lines never shift layout: reserve their space before they appear; verify element top and height are identical across idle, pending, slow, failed and done.
- 2026-10-24: (Rowin, order 36) while one action is pending, conflicting actions are disabled and the inputs it uses are read-only; one pending action at a time, no double submit, the state returns on failure.
- 2026-10-24: (trackxai) agents cut off by a spend limit or hook outage are marked PARTIAL and resumed, never counted as done.
- 2026-10-24: (docsxai) session-limit kills delete subagent transcripts, so write findings files early and respawn reading them. Public-copy lints parse string literals (AST) and strip allowed tokens before testing forbidden ones.
- 2026-10-24: (browxai) read audit inputs via git archive of the fetched origin ref.
- 2026-10-24: (trackxai) check every cut-list item for inbound users before it goes on a plan (MCP-parity pages, one-time plaintext blocks, build-contract strings, externally held artifacts). A collapse-empty-groups change keeps an add control mounted, or the keyboard chord and palette action do nothing.
- 2026-10-24: (kw) a redirect that doesn't leave the page releases its lock. Enter must not fire the wrong submit when two submit buttons share a form. A block that mounts after an async check (passkey) is reserved until the check finishes. Use aria-disabled with a guard, not disabled, on buttons a keyboard user may be on. iOS zooms on focus for inputs under 16px: --text-field max(16px,1rem).
- 2026-10-24: (trackxai) a branch cut from an unmerged parent that later squash-merged: cherry-pick its own commits (git log parent..branch), don't merge, or the squashed history conflicts.
- docsxai: never edit .woodpecker from a copy sweep (config hashes are guarded); infra-detail removal there is an owner decision.
- trackxai: a test written by a builder that cannot run vitest must pass CI before it is trusted. Run prettier --check and check-size locally before push.
- remotxai: composer dock never double-adds safe-area on top of the keyboard inset.
- kw: an a11y name must start with the visible text (label-content-name-mismatch); don't override a card link with an aria-label.
- kw: reveal animations that stagger cards past 0.5 s make contrast checks read mid-fade colours; cap the stagger.
- kw: a new Playwright spec must run once on the CI box before it enters a gate batch.
- browxai: rebase stacked layout and lock branches in one order to avoid CSS/component conflicts.
- docsxai: when the hook service is down agents stop and wait; uncommitted work survives in worktrees, so respawn with 'commit what exists first'.
- browxai: when a status slot replaces a hidden element, tests that matched the old class (empty:hidden) must move to the slot contract. Run cargo fmt before pushing test edits.
- kw: neutralise hover transforms in layout-stability specs (move the pointer away); a busy button's accessible name changes, find it by the busy name.
- trackxai: run check:readme and the size cap locally before push (three PRs failed the static step on them). Use bash, not zsh, for CI log helpers (zsh doesn't word-split).
- trackxai: queued push waiters must be chained, not parallel (several waiters fire several gates when the queue empties).
- browxai: run pnpm lint on new scripts before pushing (browser globals in page.evaluate fail the gate). The commit hook rejects git commit --amend --no-edit: use a new commit.
- trackxai/remotxai: a killed pipeline cannot be approved or restarted into a deploy; fix is a fresh push to main (deploy guards want parent 0).
