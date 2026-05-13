# browxai — Phase 1 design note

> Ratifies the recommendations in the portfolio's `research-open-questions.md` into concrete,
> implementer-facing design for the Phase-1 MVP. Canonical spec/roadmap:
> `kalebteccom/project-ideas` → `projects/agent-browser-bridge/`. If implementation forces a
> change here, update the portfolio spec too. Status: **mostly implemented — see
> `docs/tool-reference.md` for the as-shipped surface**. A few details (notably `snapshotDelta`
> scope-down and the `tree_diff` mode) are Phase-1.5 — they're called out at the relevant sections.

## 0. What Phase 1 ships

A standalone MCP server (`browxai`, stdio transport) on `playwright-core` + CDP, exposing:

**Entrypoint** (per first-consumer ask #2 — see `first-consumer-asks.md`): `pnpm browxai`
locally, `browxai` as the published bin, eventually `npx @kalebtec/browxai`. The
spike entrypoint was deleted once the canonical reached parity.

| Tool | Purpose |
|---|---|
| `snapshot` | accessibility tree + key interactive elements with stable refs/selectors; token-efficient |
| `find` | natural-language element description → ranked candidate locators + evidence |
| `click` / `fill` / `select` / `press` / `hover` / `navigate` / `goBack` / `goForward` / `waitFor` | act on the page; each returns an `ActionResult` |
| `screenshot` | full page or element-cropped PNG |
| `consoleRead` / `networkRead` | recent console messages / network requests (filtered) |
| `awaitHuman` | block until the human responds in the page (confirm / choose / input / pick_element / acknowledge) |
| `session` (or launch flags) | open/attach/close a browser session: `managed` (default) or `byob` (opt-in) |

Plus the injected on-page helper `window.__browx`. Headless mode is a Phase-1 *target* but the
designated cut if the phase runs long; the headed managed-profile path is the must-have.

Out of Phase 1 (→ Phase 2): full capability-toggle system, origin allow/blocklist, confirmation
hooks, network-egress filtering, the written threat-model doc, learned `find()` ranking, richer
diff modes beyond `ActionResult`'s `mode` set. The cheap security non-negotiables (§5) *are* in Phase 1.

## 1. Module layout (`src/`)

```
src/
  index.ts            public exports (NAME, VERSION, createServer)
  cli.ts              the `browxai` bin — parse flags, start the MCP server
  server.ts           MCP server wiring: register tools, dispatch, error mapping
  session/
    types.ts          BrowserSession interface (managed | byob), SessionOptions
    managed.ts        launch a managed dedicated-profile Chromium (normal flags, sandbox on)
    byob.ts           CDP-attach to an external Chrome (opt-in; loopback only; loud warning)
    profile.ts        profile-dir management (the .browx-profile/ default location, gitignored)
  page/
    snapshot.ts       a11y-tree extraction + stable-selector synthesis + compact serialisation
    refs.ts           the stable element-key ↔ ref registry (see §2)
    find.ts           candidate gathering (a11y tree + DOM + screenshot crop) + evidence + ranking
    actions.ts        click/fill/navigate/... wrapped to produce an ActionResult
    actionresult.ts   the ActionResult builder: change-detector + scoped re-snapshot + signals
    network.ts        CDP Network.* capture for the action window; consoleRead/networkRead
    screenshot.ts     full-page / element-cropped screenshots
  helper/
    inject.ts         re-inject window.__browx on every navigation/new target (addInitScript)
    browx-page.ts      the in-page script source (compiled/bundled string): __browx API + overlay UI
    bridge.ts         the server side: exposeBinding callback, awaitHuman, signal queue, polling fallback
  util/
    tokens.ts         rough token estimation + truncation helpers (snapshotDelta is the elastic part)
    logging.ts        structured stderr logging (never stdout — that's the MCP channel)
```

Vitest tests alongside (`*.test.ts`); a `test/keystone` later (a real Chromium round-trip), once
there's something to round-trip.

## 2. Accessibility serialisation + the ref scheme (the coherence constraint)

**One serialisation, one ref scheme, used everywhere** — `snapshot()`, `find()` candidates, and
`ActionResult.snapshotDelta.tree` must all emit byte-identical structure for the same node, and a
ref the agent learns from any of them must be usable in the next action.

- **Compact a11y serialisation** (`page/snapshot.ts`): a nested, indentation-based text form —
  `role "name" [ref=eN] [state...]` per line, children indented; only semantically meaningful /
  interactable nodes (drop generic containers, presentational nodes, `aria-hidden`); collapse long
  text; include `[disabled]`/`[checked]`/`[expanded]`/`[selected]`/`[value="…"]` etc. as bracketed
  states; optionally a `[testid=…]` hint when present. (This is close to `@playwright/mcp`'s and
  `agent-browser`'s shapes; finalise the exact grammar after reading both — see `divergence-notes.md`.)
  Output is scoped/paginated/prioritised, never a full DOM dump.

- **Stable refs** (`page/refs.ts`): a ref `eN` is assigned by a **stable element key**, not by
  enumeration order. Key = a hash of `(role, accessible-name, a structural DOM path, testid if any)`.
  A `RefRegistry` per page maps key → `eN` and `eN` → a resolver (a Playwright `Locator` /
  CDP backendNodeId). When a node persists across snapshots it keeps its `eN`; new nodes get fresh
  ones; gone nodes' refs become stale (and `ActionResult.element.stillAttached` / a `find()` re-run
  surfaces that). This is what makes `tree_diff` line-stable and lets a delta's refs be acted on
  immediately. (Contrast: `@playwright/mcp`'s refs are per-snapshot.)

- Refs are resolved to actions via Playwright locators where possible (so we inherit auto-waiting
  and the strict-match checks); fall back to CDP `DOM.resolveNode` for the awkward cases.

### 2a. Bbox in `find()` / `snapshot()` evidence — visible rect, not raw rect

Per first-consumer ask #5: every `bbox` browxai emits in candidate evidence (from `find()`)
or in `snapshotDelta` element metadata is the **visible** bounding rect — the element's
`getBoundingClientRect()` intersected with each ancestor whose `overflow !== visible` and
with the viewport. If the result is empty (the element is fully clipped, scrolled out of
view, or inside a collapsed parent), emit `bbox: null` and `clipped: true` rather than the
raw rect. This matches the runtime bbox computation site-docs's Playwright driver already
does, so a locator captured during calibration produces the same bbox at execution time.

### 2b. `selectorHint` quality bar — preference order + stability flag

Per first-consumer ask #4: when `find()` (and `snapshot()`'s per-node hints) produce a
`selectorHint`, they pick from this preference order, top to bottom, taking the first that
uniquely matches:

1. `[data-testid="…"]` — or any project-conventional test attribute (`[data-test="…"]`,
   `[data-cy="…"]`, …). Configurable list, `data-testid` as the default.
2. **Role + accessible name** — Playwright `getByRole(role, { name })` shape, or its
   CSS-equivalent `role=<role>[name="…"]` when a selector-only consumer needs it.
3. **Stable text content on a stable role** — e.g. `role=link >> text="Sign in"`.
4. **Stable structural** — `#id`, semantic tag with a non-generated attribute.
5. **Positional — last resort only** — `nth-child` / `nth-match` / descendant chains with
   generated class names.

Every candidate returned by `find()` includes `selectorHint.stability ∈ "high" | "medium" |
"low"`: `high` = tier 1, `medium` = tier 2–3, `low` = tier 4–5. When only tier-4-or-below
is available, `stability: "low"` lets a calibration agent flag it for a human or push a
`data-testid` ask back to the app team rather than transcribing a brittle selector into
a flow-file. (This is exactly site-docs's flow-file `locators:` use case.)

## 3. `ActionResult` (the action-feedback shape)

Every action primitive returns this (the MCP tool serialises it as JSON; also offer a `text`
rendering toggle since some clients prefer text — `agent-browser`-style):

```jsonc
{
  "ok": true,                        // action dispatched without throwing
  "action": { "type": "click", "ref": "e42", "selector": "role=button[name=\"Submit\"]" },

  // --- cheap, high-value, ALWAYS present ---
  "navigation": {
    "changed": true,
    "from": "https://app.example.com/cart",
    "to":   "https://app.example.com/checkout",
    "kind": "full_load"              // "full_load" | "spa" | "hash" | null
  },
  "structure": {                     // page-level appearances/disappearances
    "appeared": [ { "role": "dialog", "name": "Confirm order", "ref": "e88" } ],
    "removed": [],
    "newTabs": []                    // [{ "url": "...", "title": "..." }]
  },
  "console": { "errors": [/* strings */], "warnings": 0 },
  "pageErrors": [/* uncaught exception messages */],
  "element": { "ref": "e42", "stillAttached": false, "value": null, "checked": null, "focused": false },

  // --- the changed a11y subtree, scoped + token-budgeted ---
  "snapshotDelta": {
    "mode": "scoped_snapshot",       // "scoped_snapshot" (default) | "tree_diff" | "full" | "none"
    "scope": "ref=e42 ancestors+2 / +appeared regions",
    "tree": "<compact a11y snapshot of the changed region — same serialisation as snapshot()>",
    "truncated": false
  },

  // --- network the action triggered; summarised by default ---
  "network": {
    "summary": { "total": 3, "byType": { "xhr": 2, "document": 1 }, "failed": 0 },
    "requests": [                    // included only when count <= cap (default 10), else summary only
      { "method": "POST", "url": "/api/orders", "status": 200, "type": "xhr", "ms": 142 }
    ]
  },

  "tokensEstimate": 180,
  "warnings": []                     // e.g. "snapshotDelta truncated to budget; call snapshot() for full"
}
```

**Per-call params** on every action tool: `mode` (default `scoped_snapshot`), `maxResultTokens`
(default ~600), `network` opts (`includeQuery`/`includeHeaders`/`includeBodies`, all default off).

**How it's built** (`page/actionresult.ts`):
1. Before dispatch: record current URL, install a `MutationObserver` (via the on-page helper) and
   start CDP `Network.*` capture; snapshot the set of top-level regions/tabs.
2. Dispatch the action (Playwright locator action; let auto-waiting do its thing); then wait for a
   short quiet window (`networkidle`-ish or a small timeout).
3. The `MutationObserver` is the **change-detector only** — its records tell us which subtrees
   changed and whether dialogs/regions appeared; we do **not** put records in the result.
4. `navigation.kind`: `full_load` via CDP `Page.frameNavigated` on the main frame; `spa` via the
   helper's `pushState`/`replaceState`/`popstate` hooks; `hash` if only the fragment changed.
5. `snapshotDelta`:
   - `scoped_snapshot` (default): re-serialise (i) the subtree around `action.ref` (the element +
     ~2 ancestor levels + their interactive descendants) and (ii) any newly-appeared top-level
     region (dialog/toast/alert/new tab) — using the §2 serialisation + refs.
   - `tree_diff`: take the prior compact-snapshot lines and the new ones, line-diff, emit `+`/`-`
     + a summary line. (Requires the §2 stable refs.)
   - `full`: the whole fresh `snapshot()`. `none`: omit `tree` entirely.
6. `network`: from the CDP capture for the action window; default-filter `image`/`font`/`stylesheet`/
   `media`/analytics-beacon types out of `requests` (still counted in `summary.byType.other`);
   path-only URLs with query truncated unless opted in.
7. Token budget: `snapshotDelta.tree` is the elastic part — truncate it first (drop deepest/
   least-relevant nodes), then drop `network.requests` to its summary; always keep `navigation` /
   `structure` / `console.errors` / `pageErrors` / `element`. Emit a `warnings[]` note on truncation.

## 4. The `window.__browx` helper channel + `awaitHuman`

Injected when the helper is enabled (always, in Phase 1 — it's also how the `MutationObserver`
change-detector and the SPA-navigation hooks get installed). Name configurable; banner UI in a
shadow root so the page can't clobber it.

**In-page API** (`helper/browx-page.ts`):
```ts
interface BrowxHelper {
  // human → agent: fire-and-forget signals
  signal(name: string, data?: unknown): void;
  proceed(data?: unknown): void;     // sugar: signal("proceed", data)
  abort(reason?: string): void;      // sugar: signal("abort", { reason })
  done(what: string, data?: unknown): void;  // "I did X" — signal("did", { what, data })
  status(): { state: "running" | "awaiting_human" | "paused"; prompt?: string };
  // internal: change-detector + nav hooks (not part of the human-facing surface)
}
```

**Server-side MCP tool** `awaitHuman({ kind, prompt, choices?, timeoutMs? }) -> HumanResponse`:
- `kind = "acknowledge"` — render "click when ready", resolve on any `proceed()`/banner click (the
  site-docs login case: `awaitHuman({ kind: "acknowledge", prompt: "Log in, then continue" })`).
- `kind = "confirm"` — yes/no buttons → `{ value: boolean }`.
- `kind = "choose"` — render `choices` (e.g. the `find()` candidate list) → `{ value: <chosen index/id> }`.
- `kind = "input"` — a text field (e.g. a 2FA code) → `{ value: string }`.
- `kind = "pick_element"` — enter an overlay: hover-highlight, click selects, ESC cancels →
  `{ value: { ref, selector, evidence: { role, name, testId, bbox, screenshotCrop, xpath, ... } } }`
  (same evidence shape `find()` produces).
- All resolve with `{ kind, value, timedOut }`; `timeoutMs` → `timedOut: true`.

Also surface unsolicited `signal()`s to the agent (an MCP notification or a `pollSignals()` tool) —
the human pre-emptively hitting "proceed".

**Transport** (`helper/bridge.ts`):
- Default: a real `window.__browx_send` function installed via `page.exposeBinding` (Playwright) /
  CDP `Runtime.addBinding`; calling it from page JS delivers the arg straight to Node over the
  existing CDP connection. No extra port, no websocket, works headed and headless. Re-inject the
  init script on every `framenavigated` / new-target event (Playwright `addInitScript` covers
  new documents; also re-assert defensively after navigation).
- Fallback: the helper writes `document.documentElement.dataset.browxSignal = JSON.stringify(...)`
  and the server polls via `page.evaluate` (~250ms). Used when the binding is unavailable or gets
  clobbered — notably BYOB multi-attach (Playwright #34359, where a second CDP client can lose the
  binding). Detect a missing binding → re-inject; if still missing → polling mode + a warning.
- Agent → human direction needs no transport question: the server calls `page.evaluate` /
  `page.addStyleTag` to render the banner/overlay, then blocks on the binding callback (or polls).

## 4a. The no-trace consumer-repo contract (NFR — Phase 1)

browxai's whole point is to be driven *from* other repos, and those repos' working trees
must stay clean. Concretely, the server MUST satisfy all of:

- **All paths the server writes to are rooted at `BROWX_WORKSPACE`** (env var; default
  `~/.browxai/`). The server resolves this once at startup, absolute, and uses it for the
  managed-profile dir (`$BROWX_WORKSPACE/profile/`), any captured `storageState`
  (`$BROWX_WORKSPACE/storage/<role>.json`), any logs (`$BROWX_WORKSPACE/logs/`), and any
  helper / debug artefacts (`$BROWX_WORKSPACE/artifacts/`). **`cwd` is never used for
  output paths** — verified by review and a CI test that runs the server with a fake
  consumer-repo cwd and asserts the cwd is untouched.
- The server logs its resolved `workspace=` to stderr at startup so the agent / operator
  can verify.
- **Two registration patterns** in client docs: (A) user-scope MCP config
  (`~/.claude.json`) for ongoing reuse; (B) a workspace-scope `.mcp.json` that lives *in*
  the `BROWX_WORKSPACE` dir, not in any consumer repo. The `cwd` of the spawned process is
  the browxai repo (so pnpm finds deps); the `BROWX_WORKSPACE` env points outside any
  consumer repo. Never instruct an operator to drop a `.mcp.json` inside a consumer repo.
- (The Phase-0 spike server applied the same rule before it was retired in Phase 1.)

Test: spawn the server with `cwd=/tmp/fake-consumer-repo` (an empty git repo), run a
calibration cycle, then `git -C /tmp/fake-consumer-repo status --porcelain` MUST be empty.

## 5. Session lifecycle + the Phase-1 security non-negotiables

Two modes (`src/session/`):

- **`managed` (default)** — launch a fresh Chromium (playwright-core's managed download) with a
  **dedicated persistent profile dir** at `$BROWX_WORKSPACE/profile/` (not the human's daily-driver
  Chrome profile, not in `cwd`), **normal Chrome flags**, **sandbox on**. Login survives between
  sessions in that profile. For a consumer's `httpOnly`-cookie flow: inject the captured cookies
  into a fresh context here, rather than attaching to the user's real Chrome.
- **`byob` (opt-in, dangerous) — `BROWX_ATTACH_CDP=<endpoint>`** — CDP-attach to an externally
  launched Chrome (e.g. one a consumer like site-docs already started with
  `--remote-debugging-port=9222`). **Off by default.** Set `BROWX_ATTACH_CDP=http://127.0.0.1:9222`
  (loopback only — the server refuses non-loopback hosts) to enable; the server then calls
  `chromium.connectOverCDP(endpoint)` instead of launching. The attached browser is **not-owned**:
  on shutdown browxai detaches but does *not* close the browser, does *not* reset its storage, does
  *not* delete its profile. The startup log says `attached=<endpoint> owner=external` so the
  operator sees the non-owned posture. The same loud one-time warning applies — the real profile
  (every cookie/password/authed tab), SOP possibly disabled if that Chrome was launched with
  `--disable-web-security`, and an unauthenticated CDP port. browxai itself **never** launches
  Chrome with `--disable-web-security` in `managed` mode. **First-consumer ask #1** — this is the
  unblocker for site-docs's "one Chrome holds the auth" pattern (`capture-auth --cdp …` → browxai
  attaches to that same Chrome → no second login, no `httpOnly` translation).

Non-negotiables that hold in **both** modes, in Phase 1:
- The CDP endpoint browxai opens/uses is bound to **`127.0.0.1` only** (never `0.0.0.0`); prefer a
  pipe/unix socket where feasible; document that the port is unauthenticated.
- **All page-derived text is untrusted** — `snapshot()` / `find()` / `ActionResult.snapshotDelta`
  output is attacker-controlled. The server must not interpret it (no promptable ranking heuristics,
  no auto-following instructions found in page text in any server-side logic). The MCP tool
  descriptions tell the host agent it's untrusted (the `@playwright/mcp` #1479 lesson).
- If the caller supplies the task's expected origin(s), default-restrict navigation to them — even
  though (like `@playwright/mcp`) this is "not a security boundary," it's a cheap blast-radius
  reducer and the hook point for Phase-2 confirmation. (Lightweight in Phase 1; the full
  allow/blocklist + confirmation hooks are Phase 2.)

### 5a. Storage-state handoff to a deterministic execution mode (first-consumer ask #3)

When browxai is **attached** (`BROWX_ATTACH_CDP`), the storage-state handoff to a consumer's
own headless/deterministic execution stage is automatic: the consumer reads `storageState()`
off the same Chrome it asked browxai to attach to — *no browxai MCP tool needed*. The two
processes share the browser; the auth lives there. This is how site-docs's
`capture-auth --cdp …` → `site-docs run` pairing already works; browxai just slots in as a
third client on the same Chrome between them. **Phase 1.**

When browxai is in `managed` mode (it owns the profile), a `dump_storage_state({ outputPath })`
MCP tool that writes Playwright's standard `storageState` JSON (cookies + origins/localStorage)
is the path. **Phase 2** — not needed for the first-consumer adoption since site-docs uses the
attached pattern.

### 5b. Workspace co-location with a consumer (first-consumer ask #6)

`BROWX_WORKSPACE` is consumer-pickable: a consumer that already maintains its own per-app
workspace dir (e.g. site-docs's `$WORKSPACE`) can set `BROWX_WORKSPACE=$WORKSPACE/.browxai/` so
the operator sees one workspace tree per app. browxai's env-var-rooted-everything discipline
(see §4a) means subdir nesting Just Works — no special code path. Documentation-only on
the browxai side.

## 6. MCP server wiring (`server.ts`)

- `@modelcontextprotocol/sdk` `Server` over `StdioServerTransport`. **stdout is the MCP channel —
  all logging goes to stderr.**
- Register the tools in §0 with JSON-schema input. Tool handlers are thin: resolve the session,
  call into `page/*`, return the structured result.
- Error mapping: a failed action (e.g. element not found, navigation timeout) returns an
  `ActionResult` with `ok: false` + a `warnings`/error field where useful, plus Playwright's call
  log — *not* an MCP protocol error. Protocol errors are reserved for "the tool was called wrong".
- Lifecycle: a `session` open/attach on demand (or eager on first tool call with default `managed`);
  close on shutdown; one active session for Phase 1 (multi-tab/multi-context is Phase 4).

## 7. Phase-1.5 follow-ons

The 2026-05-13 target-app adoption-run report (`docs/adoption-report-target-app-2026-05-13.md`) re-ordered
this list. The top three items are gating: until they land, browxai is materially blunted on
heavy-SPA targets (target-app-shape codebases — sparse a11y roles, dense `data-testid`/`data-type`).

**Adoption-driven (asks #7–#11 in `first-consumer-asks.md`):**

- 🔴 **`snapshot()` DOM-walk fallback.** When the a11y tree has zero/few interactive descendants
  under the root, augment with a DOM walk: emit interactive elements found via CSS predicates
  (`[role]`, `button`, `a[href]`, `input`, `select`, `textarea`, `[onclick]`, `[tabindex]`, `[contenteditable]`)
  as A11yNode-shaped entries (synthetic `role` taken from `[role]` attr or tagName; `name` from
  `aria-label` / textContent / placeholder; `testId` from the configured attribute list). Refs
  still come from the existing stable-key scheme (so they round-trip with the a11y entries when
  both are present). This unblocks the canonical discovery use case on real-world SPAs and is
  the **first Phase-1.5 priority**. ([adoption report §1 / ask #7](docs/adoption-report-target-app-2026-05-13.md))
- 🔴 **`snapshot` data-attribute projection** — either a `mode: "attrs"` (or a supplementary
  `find_attrs(query?)` tool) that lists every visible element bearing a configured data-attribute
  (`data-testid`, `data-test`, `data-cy`, `data-qa`, plus project-conventional names like
  `data-type` — config-driven). Tier-1 / stability `high` regardless of role wrapper. Probably
  trivial on top of the DOM-walk plumbing. ([ask #8 / #10])
- 🟡 **Auto-default `BROWX_ATTACH_CDP` when `127.0.0.1:9222` is reachable** (or a `browxai doctor`
  that prints the missing setup). Adopters using the user-scope MCP install today re-login each
  session because `BROWX_ATTACH_CDP` isn't set by default. Pair with a *persistent profile* (mirror
  site-docs's `--user-data-dir` pattern, already wired through `$BROWX_WORKSPACE/profile/`) so the
  managed-mode fallback at least carries auth across sessions. ([ask #9])
- 🟡 **`selectorHint` tier-1 must not gate on a role wrapper.** When ask #7 / #8 lands, ensure
  the testid-bearing DOM-walk node gets tier-1 / stability `high` even when its role tree
  ancestor is empty. ([ask #10])
- 🟢 **"Low-content snapshot" warning** — when a `snapshot()` has fewer than N (configurable,
  default 5) interactive descendants under the root, emit
  `warnings: ["a11y tree has N interactive descendants; SPA likely uses non-semantic markup. The DOM-walk fallback is on by default — these results combine both sources."]`
  (or, until #7 lands, "consider the DOM-walk fallback when it ships"). Helps adopters fail fast.
  ([ask #11])

**Already on the list pre-adoption (still wanted):**

- **`snapshotDelta` scope-down** — currently returns the full a11y tree with a warning that
  scoping is pending. The design (re-snapshot of just the changed region + any newly-appeared
  top-level region) is fully described in §3.
- **`mode: "tree_diff"`** — emits a unified `+`/`-` text delta of the a11y serialisation
  (à la Vercel `agent-browser`). Wire-compat decision deferred — see `divergence-notes.md` §5.
- **`await_human` `kind`s beyond `acknowledge`** — `confirm` / `choose` / `input` /
  `pick_element` and the shadow-DOM banner UI. Adopter feedback (adoption-report §"What worked")
  asks that the Phase-1.5 plan for these be discoverable in the tool description so adopters
  don't invent workarounds.
- **`network_read`** as a session-wide buffered stream — the per-action tap is the primary
  surface; standalone buffering is polish.
- **`find().selectorHint` tiers 3 (stable-text-on-stable-role) and 4 (id/semantic)** — Tiers 1, 2,
  and 5-stub are live; 3/4 land with the DOM-walk plumbing.
- **No-trace CI test** — spawn the server with `cwd=/tmp/fake-consumer-repo`, exercise tools,
  assert the cwd is untouched. The contract is enforced in code (every output path roots at
  `BROWX_WORKSPACE`); the CI test makes it tamper-evident.
