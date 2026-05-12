# Port-plan: site-docs browser-lifecycle code → browxai

> Phase-0 deliverable. Inventories the browser-lifecycle code in `automated-site-documentation-bot`
> (the "site-docs" impl repo) and maps it onto browxai. Source refs are paths under
> `automated-site-documentation-bot/packages/engine/src/` unless noted. Companion reading:
> the portfolio's `projects/agent-browser-bridge/{spec.md,roadmap.md,research-open-questions.md}`
> (esp. research §2 = the `__browx` channel, §3 = the security/trust model).
>
> Bottom line: the Playwright launch/attach/persistent-profile/storageState plumbing ports
> almost verbatim; the on-page helper is a *generalisation* not a port; the security flags
> *invert* (lowered-by-default → safe-by-default + warned opt-in); and everything site-docs-engine-
> specific (doc-packs, flow-files, `runFlow`, calibration) stays in site-docs and becomes a
> *consumer* of browxai.

---

## 1. Inventory — browser-lifecycle code in site-docs today

site-docs's "browser stuff" lives in three engine modules plus two CLI commands that wire them:

| File | ~LOC | What it is |
| --- | --- | --- |
| `playwright-instrumented-browser.ts` | 186 | `PlaywrightInstrumentedBrowser implements InstrumentedBrowser` — the headed, **security-lowered**, instrumented Chrome that `manual-capture` drives. Three launch modes: ephemeral `chromium.launch`, persistent `chromium.launchPersistentContext(profileDir)`, and `chromium.connectOverCDP(connectOverCdp)` attach. Exports `SECURITY_LOWERED_ARGS` (`--disable-web-security`, `--disable-features=IsolateOrigins,site-per-process`, `--disable-site-isolation-trials`). Injects an on-page helper (`helperScript()` → `window.__siteDocs.capture()` console fn and/or an injected button, both wired via `context.exposeFunction("__siteDocs_capture", …)`), waits for the human to trigger it (`waitForCapture(trigger)` — `addInitScript` for future docs incl. post-SSO-redirect + `page.evaluate` for the current one), then harvests `storageState()` with a localStorage-merge belt-and-braces for CDP-attached contexts. `close()` is attach-aware (detaches, never kills the engineer's Chrome) and persistent-aware (`context.close()` flushes the profile). |
| `playwright-driver.ts` | 164 | `launchPlaywrightSession(opts) → PlaywrightSession` — the *execution-mode* browser: `chromium.launch({headless})` (or `connectOverCDP`) → `newContext({baseURL, storageState, ignoreHTTPSErrors})` → `newPage()`; returns `{browser, context, page, driver, storageState(), close()}`. Plus `PlaywrightDriver implements BrowserDriver`: `goto/click/fill/press/hover/selectOption/setChecked`, waits (`waitForNetworkIdle/Load/ElementStable/Selector/Timeout`), predicates (`isVisible/urlMatches/textContains`), context getters (`currentUrl/count/textOf/boundingBox`), `screenshot(relPath)`. This is the one place that touches Playwright on the execution side; the runtime is written against the `BrowserDriver` interface. |
| `auth.ts` | 333 | The target-site auth layer. `StorageState` structural type (deliberately *not* importing Playwright's). `InstrumentedBrowser` interface (`open/waitForCapture/storageState/close`) + `CaptureTrigger` (`"console"|"button"`). `ManualCaptureStrategy implements AuthStrategy` (calls `open → waitForCapture → storageState`, deliberately reports no `expiresAt`). `LocalStorageStateCache` (`.auth/<role>.json` load/save/clear, with the `auth_cookie`→`ttl`→`session`/1h expiry-priority logic and `cookieExpiryByName`/`earliestCookieExpiry` helpers). `parseAuthStrategyFile` (zod-validated `auth/strategy.yaml` parser) + `resolveCredsEnv` (role `creds_env` name-map → values from `process.env`). `makeStrategy` registry (only `manual-capture` built; others throw `NotImplementedStrategyError`). `AuthStrategyConfigError`. |
| `cli.ts` → `cmdCaptureAuth` | ~105 of 566 | Wires `capture-auth`: reads `auth/strategy.yaml`, resolves the role + creds, builds `PlaywrightInstrumentedBrowser` with `{headless, ignoreHTTPSErrors, connectOverCdp?, profileDir?}` (`profileDir` defaults to `<ws>/.auth/chrome-profile/` unless `--fresh`/`--cdp`), runs the strategy, prints the cookie jar, persists via `LocalStorageStateCache.save`. |
| `cli.ts` → `cmdInspect` | ~100 of 566 | Wires `inspect`: loads the cached `storageState`, calls `launchPlaywrightSession({connectOverCdp? | baseURL+headed+storageState})`, navigates, dumps `[data-testid]` elements (or `--selector` HTML). The `storageState → fresh-Playwright-context` bridge in action — the closest existing analogue of browxai's default "managed profile + injected cookies" path. |
| `cli.ts` → `cmdRun` | ~95 of 566 | Wires `run`: loads cached `storageState`, `launchPlaywrightSession`, feeds `session.driver` to `runFlow`. Pure consumer of the lifecycle pieces. |

Also relevant context (not lifecycle, but referenced by it): `flow-runtime.ts` (`BrowserDriver` interface + `runFlow`), `doc-pack.ts` (schemas incl. `BoundingBox`, `StorageState`-adjacent `AuthStrategyDescriptor`), `flow-file.ts`, `calibrate.ts`, `workspace.ts` — all site-docs-engine-specific (see §4).

Total lifecycle-relevant code is roughly **600–700 LOC** of the ~2.3k-LOC engine, and it has exactly three runtime deps: `playwright-core`, `yaml`, `zod` (browxai already has `playwright-core`; it would pick up `zod` for the strategy/config parsing, and `yaml` only if it ports the `strategy.yaml` parser, which it likely won't — see §4).

---

## 2. Ports cleanly (little change) — and the browxai module layout

These lift with cosmetic edits (rename `__siteDocs` → `__browx`/`browxai`; drop `docPackRoot` from `screenshot`; drop the `BrowserDriver`/`runFlow` coupling). They become browxai's transport core:

- **`PlaywrightInstrumentedBrowser`'s three launch modes** — ephemeral `chromium.launch`, persistent `chromium.launchPersistentContext(profileDir)`, `chromium.connectOverCDP(endpoint)` attach — are *exactly* browxai's "session lifecycle" primitive: `launch (managed profile) | attach (BYOB/CDP)`. The attach-aware `close()` semantics ("never kill a browser we didn't launch", "`context.close()` flushes a persistent profile") are precisely right and should be kept verbatim. → `src/browser/session.ts` exporting `BrowxSession` (≈ `PlaywrightSession`: `{browser, context, page, storageState(), close()}`) and `openSession(opts)` (the merge of `launchPlaywrightSession` + `PlaywrightInstrumentedBrowser.open` — one function, mode-switched on `opts.attach`/`opts.profileDir`).
- **The `storageState()` localStorage-merge belt-and-braces** (`playwright-instrumented-browser.ts` lines ~139–168 — Playwright's `storageState()` on a CDP-attached context returns `origins: []`, so it reads `localStorage` off each open same-origin page via string-form `evaluate` and merges). Port verbatim into `src/browser/session.ts`; browxai will hit the same Playwright behaviour the moment it does BYOB attach. This is hard-won; don't re-derive it.
- **`StorageState` structural type + the cookie-expiry helpers** (`auth.ts`: `StorageState`, `cookieExpiryByName`, `earliestCookieExpiry`) — pure, dependency-free, useful for browxai's "inject these cookies into a managed profile" path. → `src/browser/storage-state.ts`.
- **`LocalStorageStateCache`** (`.auth/<role>.json`, the `auth_cookie`→`ttl`→default expiry-priority logic) — browxai needs a session-state store for "remember the authed session between MCP server restarts". Port mostly as-is; generalise the key from `role` to a caller-supplied `sessionId`. → `src/sessions/state-cache.ts`. (zod dependency comes along here.)
- **`PlaywrightDriver`'s primitive ops** — `goto/click/fill/press/hover/selectOption/setChecked`, the waits, `currentUrl/count/textOf/boundingBox/screenshot`, `isVisible/urlMatches/textContains`. These *are* the raw-Playwright-op layer browxai's MCP tools wrap (`navigate`, `click`, `type`, `screenshot`, …). Keep the thin one-line-per-op shape; drop the `BrowserDriver` interface name (that's site-docs's contract) and the `docPackRoot`-relative `screenshot` (browxai returns the screenshot bytes/base64 over MCP, or writes to a caller-given path). → `src/browser/primitives.ts`.
- **`ignoreHTTPSErrors` / `baseURL` / extra-args plumbing** — keep; map `extraArgs`/`chromiumArgs` to browxai's (gated) lowered-flags path (§3).

Layout summary (browxai side):

```
src/browser/session.ts        # openSession / BrowxSession  ← PlaywrightInstrumentedBrowser + launchPlaywrightSession merged
src/browser/primitives.ts     # raw Playwright ops          ← PlaywrightDriver (renamed, decoupled)
src/browser/storage-state.ts  # StorageState type + cookie helpers  ← auth.ts (pure bits)
src/browser/page-channel.ts   # window.__browx binding + re-injection + polling fallback  ← generalised helperScript (see §3)
src/sessions/state-cache.ts   # LocalStorageStateCache (keyed by sessionId)  ← auth.ts
src/security/flags.ts         # SECURITY_LOWERED_ARGS + the warned-opt-in gate  ← auth.ts/instrumented-browser, inverted (see §3)
src/mcp/tools/*.ts            # navigate / snapshot / screenshot / … MCP tool defs (new; thin wrappers over src/browser/*)
```

---

## 3. Needs generalisation — what has to change

### 3a. `window.__siteDocs.capture()` → the `window.__browx` channel

site-docs's helper (`helperScript()` in `playwright-instrumented-browser.ts`) is a *single fire-and-forget signal*: `window.__siteDocs.capture()` → `context.exposeFunction("__siteDocs_capture", …)` → resolves one promise. browxai needs the **bidirectional `__browx` channel** from research §2:

- **Human→agent signals** (the generalisation of `capture()`): `__browx.signal(name, data?)` plus sugar `proceed()/abort()/done()`. site-docs's `waitForCapture` becomes `awaitHuman({kind:"acknowledge", prompt:"Log in, then continue"})`.
- **Agent→human requests**: a *server-side MCP tool* `awaitHuman({kind, prompt, choices?, timeoutMs?})`, `kind ∈ confirm | choose | input | pick_element | acknowledge`, returns `{kind, value, timedOut}`. The page renders a **shadow-DOM-isolated** fixed banner showing status + the pending prompt + response controls (so the page CSS can't clobber it — site-docs's inline-styled `__siteDocs_btn` is *not* isolated; that's an upgrade).
- **`pick_element` overlay mode**: hover-highlight + click-to-select + ESC-to-cancel; returns the same locator+evidence record `find()` produces.
- **Transport**: `page.exposeBinding` / CDP `Runtime.addBinding` (site-docs already uses `context.exposeFunction`, which is the same machinery — so this is an *extension*, not a rewrite). The `__browx` JS API is a thin wrapper over `__browx_send(payload)`. **Re-inject the init script on every navigation / new target** (`framenavigated` / new-target events) — site-docs does the equivalent (`context.addInitScript` + a `page.evaluate` for the already-loaded doc); browxai must also handle multi-target. **DOM-attribute-polling fallback**: when the binding is unavailable or gets clobbered (BYOB multi-attach — see §6), the helper writes responses into a known DOM attribute and Node polls for it. site-docs has no fallback; this is new.

So `helperScript()` → `src/browser/page-channel.ts`: a (much larger) injected script + a Node-side `PageChannel` class managing the binding, the re-injection hooks, the pending-request map, timeouts, and the polling fallback. The *shape* of the wiring (init-script-for-future-docs + evaluate-for-current-doc) ports; the protocol is built fresh per research §2's spec.

### 3b. Security flags — invert the default

site-docs's instrumented browser is **lowered-by-default**: `SECURITY_LOWERED_ARGS` (`--disable-web-security`, `--disable-features=IsolateOrigins,site-per-process`, `--disable-site-isolation-trials`) is unconditionally prepended to *both* the ephemeral and persistent launches (`playwright-instrumented-browser.ts` lines 100, 117), and the `--cdp` docs tell the engineer to start Chrome with `--disable-web-security` too. That is correct *for site-docs's narrow capture-from-the-engineer's-own-machine use case* and **wrong for browxai's default** (research §3).

browxai inverts it:

- **Default = managed dedicated profile, normal flags, sandbox on.** A Playwright-downloaded Chromium, a `profileDir` *separate from the human's daily-driver Chrome*, no `--disable-web-security`, no `--no-sandbox`. site-docs's `httpOnly`-cookie pain is solved by *injecting the captured cookies into a fresh managed context* (`newContext({storageState})` — already in `playwright-driver.ts`/`cmdInspect`), not by attaching to the human's logged-in Chrome.
- **Lowered flags + BYOB attach = off-by-default, behind an explicit flag.** Keep `SECURITY_LOWERED_ARGS` in `src/security/flags.ts`, but it's only applied when the caller passes an explicitly-named "I-accept-the-risks" flag (e.g. `--unsafe-disable-web-security` / a config field with that word in it), which prints a **loud one-time warning naming exactly what's exposed** (cross-origin response reads for any page the agent — or a prompt-injected agent — visits). If a managed-profile launch ever sets it, same gate.
- **CDP bound to loopback only.** Whenever browxai opens a CDP port (its own, or instructs BYOB setup), it's `127.0.0.1` only — never `0.0.0.0`. (site-docs's `--cdp` docs are silent on this; browxai's must not be.)
- **`extraArgs`/`chromiumArgs` pass-through stays**, but lowered-security args specifically can't sneak in that way without tripping the gate.

This is config/policy code, not Playwright code — small, but it's the load-bearing difference from site-docs.

### 3c. Smaller generalisations

- `LocalStorageStateCache` keyed by `role` → keyed by `sessionId` (browxai isn't role-aware; site-docs's "role" is its own concept).
- `PlaywrightDriver.screenshot(relPath)` resolves against `docPackRoot` → browxai returns bytes/base64 over MCP (or writes to an explicit absolute path); no implicit doc-pack root.
- `connectOverCdp` is currently a plain string endpoint → browxai should also accept "launch-with-a-CDP-port-and-tell-me-the-endpoint" so a host agent (or `awaitHuman` confirmation hooks) can be wired in.

---

## 4. Doesn't port / out of scope

These are **site-docs-engine specifics** — browxai exposes browser *primitives*; site-docs's deterministic-doc machinery is a *consumer* of browxai, not part of it:

- **`flow-runtime.ts` — `runFlow`, `executeAction`, `applyWait`, `checkSuccess`, `resolveTarget`, `FlowExecutionError`, the `ExecutedStep`/`RunFlowResult` types.** This is site-docs's flow-execution engine; it consumes a `BrowserDriver`. Post-port, site-docs's `BrowserDriver` impl just wraps browxai's MCP tools (or `src/browser/primitives.ts` directly). `runFlow` does **not** move into browxai.
- **`flow-file.ts`** — the `.flow.yaml` parser, `extends` resolution, `locatorRefName`. Site-docs's input format. Stays.
- **`doc-pack.ts`** — doc-pack schemas (`AnnotationsFile`, `Step`, `SuccessSpec`, `WaitSpec`, `AuthStrategyDescriptor`, `RoleAuth`, `BoundingBox`, …). Stays. (browxai re-derives its *own* tiny `StorageState` + bounding-box types in `src/browser/`, not these.)
- **`calibrate.ts`, `pipeline.ts`, `workspace.ts`** — calibration stages, the pipeline, the `.site-docs.json` workspace + `initWorkspace`. Entirely site-docs's. Stays.
- **The site-docs `auth/strategy.yaml` format + `parseAuthStrategyFile` + `resolveCredsEnv` + `makeStrategy` registry + `ManualCaptureStrategy`.** browxai has no notion of "auth strategies" or "roles"; it has *sessions*. It ports the *mechanism* `ManualCaptureStrategy` orchestrates (open → wait-for-human → storageState), not the strategy/registry/yaml-descriptor wrapper. site-docs keeps `ManualCaptureStrategy` and re-implements it as a browxai client (`session = browxai.openSession({headed, profileDir}); await browxai.awaitHuman({kind:"acknowledge",…}); state = await browxai.storageState()`).
- **The viewer (`site-docs render` / `site-docs-viewer`)** — unrelated.
- **CLI commands `init` / `calibrate` / `run` / `render`** — site-docs's. browxai gets its own MCP-server entrypoint (already stubbed: `src/cli.ts`, `src/index.ts`). Only `capture-auth` and `inspect` are *informative* (they show the lifecycle wiring) — their *logic* is what ports, not the commands.

---

## 5. Concrete first-PR slice

**Goal:** a browxai MCP server that launches a managed-profile Chromium and exposes `navigate` + `snapshot` + `screenshot`, reusing site-docs's launch code. Minimal, end-to-end, no `__browx`, no BYOB, no security gate yet.

1. **`src/browser/session.ts`** — port `launchPlaywrightSession` (the managed-launch branch only: `chromium.launch({headless})` → `newContext({baseURL?, ignoreHTTPSErrors?, storageState?})` → `newPage()`), renamed `openSession`, returning `BrowxSession {browser, context, page, storageState(), close()}`. Drop the `connectOverCdp` branch and the `BrowserDriver` wiring for now. Add `profileDir?` (port `launchPersistentContext` from `PlaywrightInstrumentedBrowser`) so "managed *dedicated profile*" is the literal default — pass a browxai-owned temp/config dir if the caller gives none. Bring the `storageState()` localStorage-merge along (it's free and correct).
2. **`src/browser/primitives.ts`** — port `PlaywrightDriver.goto` (→ `navigate(url)`) and `.screenshot` (→ return a `Buffer`/base64 via `page.screenshot()` with no path, *or* write to a caller-given absolute path). Add a minimal `snapshot()` — for the first PR this can be Playwright's `page.accessibility.snapshot()` serialised to text, or even just `page.content()` truncated; the *real* curated `snapshot()`/`find()` is Phase-1 work (and the spike). Just enough that the MCP tool returns *something* page-state-shaped.
3. **`src/mcp/server.ts` + `src/mcp/tools/{navigate,snapshot,screenshot}.ts`** — stand up the `@modelcontextprotocol/sdk` server (it's already a dep), register three tools that hold a single `BrowxSession` (lazy-opened on first tool call), and wire `src/cli.ts` to start it over stdio. `navigate({url})` → `session.page.goto`; `snapshot()` → the §5.2 stub; `screenshot()` → bytes back.
4. **Smoke test** (`vitest`): start the server in-process, call `navigate` to `https://example.com`, assert `snapshot` contains "Example Domain" and `screenshot` returns non-empty PNG bytes. Needs `npx playwright install chromium` in CI (mirror site-docs's "no browser binary → install one" error message from `cmdRun`).

That's ~150–250 LOC of mostly-copied code + the MCP boilerplate. Defers: `__browx` channel, BYOB/CDP attach, the security-flag gate, the curated `find()`/`ActionResult`, the state cache. Each is its own follow-up PR tracked against the Phase-1 roadmap.

---

## 6. Open risks

- **Playwright `exposeBinding`-lost-on-multi-CDP-attach ([microsoft/playwright#34359](https://github.com/microsoft/playwright/issues/34359)).** When a second CDP client attaches to the same target (the BYOB scenario — browxai *and* e.g. Claude-in-Chrome, or browxai *and* DevTools), exposed bindings can silently disappear → the `__browx` channel dies mid-session. Mitigation (already in the §2 design, must be in the port): re-assert the init script on `framenavigated`/new-target events; detect a missing binding (probe `typeof window.__browx_send`) and re-inject; ship the DOM-attribute-polling fallback as a first-class path, not an afterthought. The first-PR slice dodges this by not doing BYOB or `__browx` yet, but it's the headline risk for the lifecycle work overall.
- **`storageState()` on CDP-attached contexts returns `origins: []`.** site-docs already worked around this (the localStorage-merge in `playwright-instrumented-browser.ts`); the risk is *forgetting to port the workaround* and silently losing localStorage-backed auth/state in browxai's BYOB path. Port it with the launch code, not later.
- **site-docs assumes things browxai's default mode won't have.** `PlaywrightInstrumentedBrowser` assumes (a) `--disable-web-security` is on, so its capture helper can touch cross-origin SSO-redirect pages and relaxed-CSP pages — under browxai's *normal-flags* default, an injected helper that needs cross-origin reach won't have it; the `__browx` banner itself is same-document so it's fine, but any "read state across the SSO redirect chain" trick site-docs relies on must move to the explicitly-warned lowered-flags path. (b) Headed by default — browxai's default for agent use is *headless*; the `__browx` banner is then invisible, so `awaitHuman` only makes sense in headed sessions and must error/no-op clearly in headless. (c) A single page/context — browxai will want multi-tab eventually; the site-docs code is single-`page`-centric throughout and the port should not bake that assumption deeper than it already is.
- **`page.exposeBinding` vs `context.exposeFunction`.** site-docs uses `context.exposeFunction` (one binding, all pages in the context). `page.exposeBinding` gives you the `source` (frame/page) of the call — browxai wants that (to know *which* tab/frame the human acted in). Switching is low-risk but is a behaviour change worth doing deliberately during the port, not by accident.
- **`profileDir` lock contention.** `launchPersistentContext` holds a lock on the profile dir; two browxai sessions (or a leftover Chromium) on the same managed-profile dir will fail. site-docs sidesteps this with a single CLI invocation; a long-lived MCP server needs to either serialise sessions per profile dir or mint per-session profile dirs (the latter aligns with the "ephemeral managed profile" safe-default and is probably right).
- **No browser binary in CI / on the user's machine.** `playwright-core` ships the API, not Chromium. site-docs surfaces this with a targeted error (`cmdRun`/`cmdInspect`: "no Chromium binary — `npx playwright install chromium`"). browxai must do the same at server startup, not fail cryptically on first tool call.
