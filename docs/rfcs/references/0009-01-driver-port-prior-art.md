# Driver-port prior art: where the other abstractions leaked

**Prepared for:** [RFC 0009](../0009-page-free-session-port.md), the removal of `Page` from `BrowserSession` and the three proposed ports (`TargetSubstrate`, `ElementSubstrate`, `EventSubstrate`). Secondary audience: [RFC 0008](../0008-native-app-control.md), which supplies the second no-`Page` engine.
**Research date:** 2026-09-16. Repository HEADs read the same day unless a commit is named.
**Confidence key:** [HIGH] primary source (spec text, source file, maintainer comment in an issue, commit). [MED] secondary or vendor blog. [LOW] unverified or inferred.

The brief asked for the failures. Seven projects solved a version of browxai's problem and six of them are still paying for how they solved it. Their bills are itemised below.

---

## 0. Executive framing

### 0.1 Six things to copy

**1. WebDriver's two-error split for a ref that does not resolve.** The W3C spec separates `no such element` (this browsing context never saw that reference) from `stale element reference` (it saw it, the node is gone or its document was replaced), and the algorithm that distinguishes them is spelled out at [webdriver2 §12](https://www.w3.org/TR/webdriver2/#elements) [HIGH]. The distinction survived a 2021 attempt to delete it ([w3c/webdriver#1594](https://github.com/w3c/webdriver/issues/1594), whimboo, 2021-05-27) because an agent does different things in each case: re-find, or re-snapshot. browxai collapses both into one warning and then acts anyway (§1.3).

**2. Callstack `agent-device`'s ref-frame model, ADR 0014.** A session owns one ref frame carrying an epoch, the immutable tree that minted the refs, and an issuance scope. Every mutating command expires the frame synchronously at the device side-effect seam, before dispatch, with no success-only rollback. A ref from an expired frame is refused with one of four typed reasons and a recovery hint [HIGH] (`docs/adr/0014-session-ref-frame-lifetime.md`, github.com/callstack/agent-device, v0.21.4, 2026-09-15). The ADR's own framing is the thesis RFC 0009 needs: *"A generation pin such as `@e12~s42` identifies the namespace that issued the ref; it does not make the element stable."* This is MIT, written down, and it came out of the same trial the owner ran.

**3. Appium's `ElementsCache.restore()`: re-run the locator and verify identity.** On a suspected-stale native element, `restore()` replays the original `By` and then compares the re-found node's accessibility UUID against the original, throwing `StaleElementReferenceException` when they differ [HIGH] (appium-uiautomator2-server, `model/ElementsCache.java`). It refuses outright for any element that came from `findElements`, because a multi-match locator cannot be restored unambiguously. browxai already stores the locator recipe (`RefLocatorInputs`, `src/page/refs.ts`). It does not do the identity check, and it does not refuse the multi-match case.

**4. `tsPreCompilationDeps: true` in `.dependency-cruiser.cjs:93`, which browxai already has.** Playwright's equivalent checker skips type-only imports on purpose, and **265 imports pass its `DEPS.list` today that the allowlist does not authorize** [HIGH, reproduced]. browxai's cruiser sees type-only edges, so on this one axis its tooling is stricter than the best-disciplined codebase in the survey. The P1 leak happened anyway, for a reason §2.7 names, and the fix is two rule changes in tooling already installed.

**5. n8n's ratchet, including the rule that protects the rule.** [PR #35914](https://github.com/n8n-io/n8n/pull/35914), 2026-08-10, states the policy as *"Type-only imports count: compile-time coupling is still coupling"*, declares 31 boundary edges explicitly, keeps a 55-file grandfather list as *"a shrink-only ratchet with the usual 'NEVER add to this list' contract"*, and ships a second lint rule banning inline `eslint-disable` of the first [HIGH]. RFC 0009 states the same policy in prose. §2.8.

**6. The W3C TAG's absolute rule on promise-returning functions, as the port contract's first line.** *"Promise-returning functions must always return a promise, under all circumstances ... Even argument validation errors are not OK"* [HIGH]. Playwright enforces it with a generated double-`async` wrapper; the MCP TypeScript SDK enforces it by hoisting every handler through `Promise.resolve().then(...)` with the comment *"puts any synchronous errors into the monad as well."* browxai's 69-method defect is the same rule broken, one layer below the transport that already hoists. §3 has the rule, the lint, and why the type system cannot help.

### 0.2 Four things to avoid

**1. Puppeteer's inherit-and-throw.** `api/Page.ts` is an abstract class with 73 abstract members; `BidiPage extends Page` overrides the unsupported ones with `throw new UnsupportedOperation()`. There are 59 such sites at HEAD. `puppeteer.launch()` returns the abstract `Browser`, so no caller ever holds the subclass, and TypeScript sees nothing [HIGH]. The error class carries no capability identifier and most throw sites pass no message, which is why users paste `UnsupportedOperation` as the entire error string ([puppeteer#12293](https://github.com/puppeteer/puppeteer/issues/12293), 2024-04-18, open). `page(): Page` throwing `safari-no-playwright-page` is this pattern, and RFC 0009 is right to delete it.

**2. Optional members that nobody implements.** Playwright's `PageDelegate` declares `noUtilityWorld?`, which is read at five call sites through `?.()` and implemented by zero delegates [HIGH]. That is the rot an optional capability member accumulates. RFC 0009's P1 `page?(): Page` is time-boxed to one phase, which contains the risk, and P5 must actually remove it.

**3. Appium's proxy avoid-list.** XCUITest maintains 48 native regexes and 11 web ones, hand-written as `['POST', /element$/]` pairs, swapped on every context switch [HIGH] (`appium-xcuitest-driver/lib/driver.ts:182-241`). A single wrong entry hid every extra webview from clients for years ([appium/appium#3105](https://github.com/appium/appium/issues/3105), 2014-07-09), and the documented opt-out for plugins did not exist in code at all ([appium/appium#20683](https://github.com/appium/appium/issues/20683), jlipps 2024-10-28: *"this is a docs issue... This reference to `shouldAvoidProxy` is old and erroneous"*). `PLAYWRIGHT_HANDLE_ALLOWLIST` is the same artefact. Keep it path-shaped and short, and never let it grow per-command entries.

**4. Selenium's `Augmenter`.** A ByteBuddy runtime subclass that bolts vendor interfaces onto a `RemoteWebDriver` based on capability predicates, its own javadoc calling providers *"a simulacrum of mixins"* and the class *"still experimental. Use at your own risk"* [HIGH]. `AddHasCdp.isApplicable()` string-matches the browser name. The user-visible failure is a `ClassCastException` at the cast site, and the canonical report ([SeleniumHQ/selenium#11892](https://github.com/SeleniumHQ/selenium/issues/11892)) sat from 2023-04-13 to 2024-01-18. `playwright?(): PlaywrightSessionHandle` is the honest TypeScript version of the same idea. It stays honest only if presence stays statically visible and never becomes a sniff.

### 0.3 Where RFC 0009 is probably wrong

Six items, ordered by how much they would cost if left.

**A. `caps.subInterfaces` has zero production readers, and RFC 0009 promotes it to load-bearing.** Verified at `550abe7`: every reference to `subInterfaces` in `src/` outside the type declaration (`src/engine/types.ts:78`) and the five capability tables (`src/engine/capabilities.ts`) is inside a `.test.ts` file. No runtime code branches on it. Safari declares 7 of 10 sub-interfaces, omitting `network`, `emulation` and `page`, and none of those omissions gates anything. §1.1 has the numbers. RFC 0009's §"A correction to the framing" argues that page-availability is *"already declared as `caps.subInterfaces.has("page")`"* and that a second spelling is the L2 violation. The declaration exists; the spelling that does the work today is the `"safari"` literal and the throw. Moving control flow onto a set that has never been exercised is the LSP and DAP drift failure (§10), and DAP's own spec text calls its declared capabilities a hint with *"no guarantees"* [HIGH]. **P1 must land a reader and its enforcer in the same commit as the declaration's promotion.**

**B. `ElementToken` is a step backwards from browxai's current ref design.** Today `[ref=eN]` is a content hash of role, name, path, testId and frameId, plus a stored re-resolution recipe re-run at action time (`src/page/refs.ts:25-35`, `src/page/locator.ts:131`). It holds no live object. RFC 0009 replaces it at the port with *"an opaque, substrate-minted token"* whose *"web implementation holds a `Locator`"*, and §"Honest limits" offers a fallback where *"the Playwright implementation returns a token that is the `Locator`, cached in a per-call map."* That converts a stateless re-resolving ref into a cached handle. It contradicts RFC 0008 §3, which requires every native action to *"re-resolve its ref to a live element before dispatch, never by replaying cached coordinates."* §9.4 compares the five designs; browxai's current one is closer to the good end than the proposed one.

**C. "`evaluate` has no native equivalent" overstates the case for the actual targets.** RFC 0009 §"What this does not solve" states it flatly. RFC 0008 targets bare React Native 0.81.4. Hermes implements the CDP `Runtime` domain including `Runtime.evaluate`, `Runtime.callFunctionOn` and `Runtime.getProperties`, documented on React Native's own status site [HIGH] (https://cdpstatus.reactnative.dev/devtools-protocol/hermes/Runtime). `metro-mcp` (MIT, RN 0.70+, Hermes required) already reaches it through Metro's inspector proxy with *"no app code changes ... for most features"* and ships a JS-evaluation tool alongside tap, swipe and type [HIGH] (github.com/steve228uk/metro-mcp). RFC 0008 §2's narrower wording, *"no scriptable context in a release-configuration RN app"*, is correct and should be the one RFC 0009 inherits. §9.3 has the honest general answer, which is still that nobody abstracts eval across a genuinely script-less backend.

**D. `ElementSubstrate.resolve`'s "never a guess" is an undeclared web behaviour change.** The doc comment reads *"Zero or many matches is a refusal, never a guess."* `resolveTargetChecked` today ships two guess paths, one of which says so in the warning text: *"acting on .first()"* (`src/page/locator.ts:100-108`). Adopting the rule uniformly changes what web flows do, not only native ones. §1.3.

**E. The `ActionSubstrate` member-budget question has a third answer the RFC does not list.** RFC 0009's open question offers a split along the action/gesture line or a documented ceiling exception. BiDi's `input` module has three commands total: `performActions`, `releaseActions`, `setFiles` [HIGH]. Swipe, pinch and multi-touch are expressed as a source-and-action-sequence structure passed to one command, and Appium reaches native gestures through the same W3C Actions shape. A generic action-sequence method is the option that makes the ceiling question disappear. §11 has the full comparison.

**F. `EventSubstrate.subscribe`'s open question is answered by the standard.** BiDi's `session.subscribe` takes event names *and* a scope: `SubscribeParameters` carries top-level traversable ids and user-context ids, and a subscription with both empty is defined as global [HIGH]. Take the filter, and take a context scope with it.

**G. The `ports-name-no-vendor-type` rule as drafted cannot catch either leak P1 found, and the enforcement section relies on prose where it needs a rule.** dependency-cruiser rules are direct-dependency by default, so the drafted rule catches a one-hop import of `playwright-core` from a port module. It catches neither a transitive reach through a sibling nor a port importing `*-substrate-playwright.ts`. Both fixes are one line each and §2.7 has them. Separately, §Enforcement's line *"An inline disable is never the relaxation mechanism; a change to this array is an RFC amendment with a written reason"* is a policy with no machine behind it, which is the repo's own L-rule about prose. n8n wrote a second lint rule that bans inline disables of the first (§2.8). Add that, and make `PLAYWRIGHT_HANDLE_ALLOWLIST` a shrink-only ratchet with a test asserting its length never grows.

---

## 1. What the research found inside browxai

Three defects, measured at `550abe7` on 2026-09-16, in the worktree the research ran against. Each is the same class as something a studied project got wrong.

### 1.1 The engine declaration is unread

`EngineCapabilities.subInterfaces` is a `ReadonlySet<EngineSubInterface>` of ten names. Chromium, Firefox, WebKit and Android declare all ten. Safari declares seven, omitting `network`, `emulation` and `page`.

Readers in non-test `src/`: none. The five writers are the capability tables. Consumers: `engine.test.ts`, four adapter tests, `port-conformance.test.ts`, `ocp-engine-contract.test.ts` and `server-isolation.test.ts`.

The single engine-dimension gate is `assertEngineSupports(tool, engine)` in `src/engine/tool-gate.ts`, and it keys on `caps.deep` alone. It is reached through `engineGate(...)` from **25 distinct tools**: `clock`, `coverage_start`, `coverage_stop`, `cpu_emulate`, the five `extensions_*`, `gesture_pinch`, `gesture_swipe`, `heap_snapshot`, `layout_thrash_trace`, `mouse_wheel`, `network_emulate`, `pdf_save`, `perf_audit`, `perf_start`, `perf_stop`, `set_locale`, `set_timezone`, `set_user_agent`, `shadow_trees`, `sw_intercept_fetch`, `sw_unintercept_fetch`. Against a surface of roughly 196 tools, the engine dimension gates 25 and the other ten sub-interface declarations gate zero.

This is the LSP failure from §10.3 with the parties reversed. LSP servers declare a capability and then return `null`; browxai declares a capability and nothing asks.

### 1.2 `network_read` on Safari returns an empty successful result

`SafariNoopNetworkSubstrate` (`src/page/network-substrate.ts:209`) returns `{ summary: { total: 0, byType: {}, failed: 0 }, requests: [] }` from `http.recent()`. Its own header comment says *"the gate refuses the tools first."* It does not. `network_read` registers with `capability: "read"` and no `deep: true` (`src/tools/read-observe-buffer-tools.ts:61`), so it takes the `gateCheck` capability path and never the `engineGate` engine path.

An agent asking a Safari session what network traffic it saw is told zero requests. That is the same defect class RFC 0009 documents for `verify_visible`, which reports a false assertion failure, and it is not in the RFC. Only `network_body` refuses honestly, because its refusal is hand-written into the no-op substrate.

Note what makes the two cases different from Puppeteer's. Puppeteer's `UnsupportedOperation` is loud and uninformative. browxai's is quiet and wrong, which is worse for a product whose output is QA evidence.

### 1.3 Ambiguity resolves by guessing, with a warning

`resolveTargetChecked` (`src/page/locator.ts:66-108`) counts matches on the primary locator. Above one match it re-resolves to the CSS path captured at discovery, warning that it did. When that path no longer resolves, it acts on the primary locator anyway and warns *"acting on `.first()`, verify the result, the element may have moved or re-rendered."*

The comment above the function is right about the stakes: *"the action silently lands at the wrong visual location."* The mitigation was a loud warning. RFC 0008 §3 chose refusal for native, and RFC 0009's `ElementSubstrate.resolve` chose refusal for everything. Nothing in either RFC notes that this is a change for web.

---

## 2. Keeping a port free of its adapter

This is the P1 question, and the survey answers it with an uncomfortable finding: **the only boundary in this set that cannot be re-absorbed is one where the port is a generated artifact and the adapter sits on the other side of a serializer.** Every in-process TypeScript mechanism studied here leaks through `import type`, including the best one.

### 2.1 Puppeteer's port re-absorbed its adapter, and it was born that way

`packages/puppeteer-core/src/api/` holds the abstract classes. `src/cdp/` and `src/bidi/` hold the implementations. At HEAD (`101c7d50`, 2026-09-15) [HIGH]:

- **`api/` imports from `cdp/` eight times, all type-only.** `api/CDPSession.ts:8` takes `Connection`; `api/Frame.ts:17-18` takes `Accessibility` and `PuppeteerLifeCycleEvent`; `api/Page.ts:33-37` takes `Accessibility`, `Coverage`, `NetworkConditions`, `Tracing` and `WebMCP`.
- **`api/` imports `devtools-protocol` in 12 of its 22 files**, including `Page`, `Browser`, `ElementHandle`, `Frame`, `Input`, `Dialog`, `JSHandle`, `HTTPRequest`, `HTTPResponse` and `CDPSession`. That package is the Chromium DevTools Protocol type definitions.

It is not cosmetic. The vendor types are in the abstract signatures [HIGH]:

```ts
// api/HTTPRequest.ts
export type ResourceType = Lowercase<Protocol.Network.ResourceType>;
abstract initiator(): Protocol.Network.Initiator | undefined;

// api/Input.ts
abstract drag(start: Point, target: Point): Promise<Protocol.Input.DragData>;
abstract drop(target: Point, data: Protocol.Input.DragData): Promise<void>;
```

And in the published docs: `puppeteer.httprequest.initiator.md`, `puppeteer.mouse.drag.md`, `puppeteer.resourcetype.md` and others. **Chromium's protocol vocabulary is inside Puppeteer's semver contract.**

**What it costs the second adapter, which is the datum RFC 0009 needs.** `src/bidi/` imports `src/cdp/` ten times, five of them value imports. `bidi/Page.ts:404-407` implements `emulateVisionDeficiency(type?: Protocol.Emulation.SetEmulatedVisionDeficiencyRequest['type'])` by delegating to `this.#cdpEmulationManager` [HIGH]. **The BiDi adapter runs CDP code to satisfy a CDP-shaped port.** That is where a leaked port sends you: the second engine inherits the first engine's protocol as its own vocabulary and then has to emulate it.

**It did not drift over years. It was born leaking.** `api/HTTPRequest.ts` was created on 2023-03-15 by [PR #9840](https://github.com/puppeteer/puppeteer/pull/9840), titled "chore: extract HTTP prep for BiDi network module". Line 16 of the newly extracted port file, in the commit that extracted it, is `import {Protocol} from 'devtools-protocol';` [HIGH].

**The one boundary rule Puppeteer has is defeated by its own style rule.** `eslint.config.mjs` sets `'import/no-cycle': ['error', {maxDepth: Infinity}]`. `api/Page.ts` importing `cdp/Coverage.js` while `cdp/Page.ts` extends `api/Page.ts` is a cycle, and it is not reported, because `eslint-plugin-import` hard-skips type-only edges with no option to disable the skip [HIGH]:

```js
if (importer.type === 'ImportDeclaration' && (
      importer.importKind === 'type'
   || importer.specifiers.every(({importKind}) => importKind === 'type')
)) { return; // ignore type imports }
```

Two lines later in the same config, `'@typescript-eslint/consistent-type-imports': 'error'`, with the comment *"This optimizes the dependency tracking for type-only files"*. That rule mechanically converts every `api`→`cdp` coupling into the exact form `no-cycle` cannot see. The style rule launders the violation past the boundary rule.

No maintainer issue or PR discusses CDP types in `api/` as a problem [MED, issue-body search is lossy].

### 2.2 Playwright's mechanism is the best in the survey and it is leaking today

**The shape is right.** `packages/playwright-core/src/server/DEPS.list` is a per-directory, **default-deny** import allowlist. `[*]` lists what any file in the directory may import; `[filename.ts]` sections add per-file exceptions. The whole per-browser grant is one stanza [HIGH]:

```
[playwright.ts]
./android/
./bidi/
./chromium/
./electron/
./firefox/
./webkit/
```

51 `DEPS.list` files across `packages/`. The checker is `utils/check_deps.js`, run by `npm run check-deps` inside `npm run lint`, which CI runs followed by a `git status -s` clean-tree gate. Escape-hatch discipline is unusually good: `@no-check-deps` appears in zero files under `packages/`, `***` appears nine times (test files, UI directories, and `bidi/DEPS.list [bidiOverCdp.ts]`), `"strict"` in four files [HIGH].

`server/page.ts`, where `PageDelegate` lives, has 40 imports and none reach an adapter directory. `PageDelegate` is stated entirely in Playwright's own vocabulary: `RawMouse`, `InitScript`, `frames.Frame`, `frames.GotoResult`. No CDP type, no WebKit type, no BiDi type [HIGH].

**And the checker exempts type-only imports, explicitly** (`check_deps.js` ~131-139) [HIGH]:

```js
if (node.importClause) {
  if (node.importClause.isTypeOnly)
    return;
  if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
    if (node.importClause.namedBindings.elements.every(e => e.isTypeOnly))
      return;
  }
}
```

**Three live violations at HEAD, verified by reproduction** [HIGH, own measurement]:

- `server/launchApp.ts:29` does `import type { CRPage } from './chromium/crPage';` and at line 95 casts `page.delegate as CRPage`. `server/DEPS.list` grants `./chromium/` to `playwright.ts` alone. There is no `[launchApp.ts]` group.
- `client/cdpSession.ts:21` does `import type { Protocol } from '../server/chromium/protocol';`. `client/DEPS.list` grants no path into `server/` in any form.
- `server/socksInterceptor.ts:25` imports `../client/channels`, with a comment excusing it.

Changing the first two from `import type` to `import` and rerunning the unmodified checker produces:

```
Disallowed import src/server/chromium/crPage.ts in src/server/launchApp.ts
Disallowed import src/server/chromium/protocol.d.ts in src/client/cdpSession.ts
```

Same files, same targets, same symbols. **The keyword `type` is the entire difference between a red build and a green one.** With the exemption block disabled across the monorepo: **265 imports pass today that `DEPS.list` does not authorize**, 135 excluding the deliberate public `types/*.d.ts` surface.

The exemption is intentional. [PR #40157](https://github.com/microsoft/playwright/pull/40157) (pavelfeldman, merged 2026-04-10) removed *"~110 stale entries across 38 DEPS.list files"*, and lists among the categories *"type-only imports that don't need DEPS entries"* [HIGH]. Two things land there at once: the maintainer framing the hole as designed, and **110 stale allowlist entries across 38 files**, which is allowlist creep measured on the best-disciplined codebase in this survey.

The same contradiction Puppeteer has: `eslint.config.mjs:258` sets `"import/consistent-type-specifier-style": [2, "prefer-top-level"]`, normalising imports into the form `check_deps` skips [HIGH].

### 2.3 Playwright's client/server seam is the mechanism that actually holds

The schema is `packages/protocol/spec/*.yml`, ten files, moved there by [PR #41612](https://github.com/microsoft/playwright/pull/41612), merged 2026-07-03. `utils/generate_channels.js` emits **two** declaration files from one schema, `src/client/channels.d.ts` and `src/server/channels.d.ts`, 5226 and 5227 lines, with shared object and enum types factored into `@protocol/structs` and re-exported by both [HIGH].

Drift fails the build twice: the generator ends `process.exit(hasChanges ? 1 : 0)` and sets `hasChanges` on any content difference, `npm run lint` runs it, and CI then checks the tree is clean.

So a client `PageChannel` and a server `PageChannel` are two separately generated declarations of one schema, and neither is reachable from the other. `client/DEPS.list` grants `@protocol/**` and no path into `server/`, so a value import across the seam fails. That is the boundary that cannot be re-absorbed, and it is not the one browxai has.

Playwright also quarantines vendor types properly where it bothers to: BiDi protocol types live in `src/server/bidi/third_party/`, granted only by `server/bidi/DEPS.list [*]`, and nothing outside `src/server/bidi/` references them in any import form [HIGH].

### 2.4 Appium's boundary is a build side effect, and it does not see vendor types

`packages/types/package.json` at HEAD depends on `@appium/schema` and `type-fest`. No `@appium/base-driver`, no concrete driver. The arrow points the right way: `base-driver` depends on `@appium/types`. `@appium/types` re-exports nothing from another package [HIGH].

**There is no lint rule.** No dependency-cruiser, no madge, no `no-restricted-paths`, no boundaries plugin. A repo-wide grep returns prose in docs and one code comment, zero config hits [HIGH].

What enforces it is `tsc -b` on a fresh CI checkout: root tsconfig references all 19 packages, every package is `composite: true`, so a back-reference gives `TS6202: Project references may not form a circular graph` and an undeclared import gives `TS2307` because `types` builds first. **With a stale populated `build/` directory the same import compiles clean** [HIGH, reproduced]. Only the fresh build catches it.

And the origin was build topology, not architecture. [PR #16594](https://github.com/appium/appium/pull/16594) (2022-03-25): *"This changes the TS configuration to a) emit declarations for supported packages, and b) build declarations incrementally by package."* The boundary is a side effect.

**It does not stop vendor types.** `packages/types/lib/server.ts:3-4` [HIGH]:

```ts
import type {Express, Router} from 'express';
import type {Server as WSServer} from 'ws';
```

`AppiumServerExtension.addWebSocketHandler(handlerPathname: string, handlerServer: WSServer)` puts the `ws` library's server class directly in the driver contract. Neither package is declared in `packages/types/package.json` on `master`; they resolve through root devDependency hoisting, so a standalone consumer of the published declarations gets an unresolvable module. [PR #22720](https://github.com/appium/appium/pull/22720) (merged 2026-09-04, into branch `appium4`) declares them as direct dependencies. The fix declares the coupling. It does not remove it.

### 2.5 BiDi's schema is generated from spec prose and never committed

`w3c/webdriver-bidi` has no `package.json` and no Makefile. `scripts/cddl/generate.js` walks `index.bs` with parse5, selects `<pre>` nodes classed `cddl`, and routes by `data-cddl-module`. 247 CDDL blocks, 115 local, 87 remote, 45 both. **`.gitignore` line 4 is `*.cddl`**, so there is no checked-in schema and a spec-versus-schema mismatch cannot exist. CI extracts and then runs `cddl compile-cddl` against all three outputs [HIGH].

The schema is normative: `index.bs:1234` gates every message on matching the remote end definition before dispatch, citing RFC 8610 Appendix C.

jgraham on why CDDL, 2020-07-22, [webdriver-bidi#21](https://github.com/w3c/webdriver-bidi/issues/21) [HIGH]:

> "WebIDL doesn't really match the use case of defining a wire protocol. JSON schema is pretty verbose to write ... CDDL gives us a fairly compact representation that's already seen usage in W3C specs defining protocols, and some degree of future compatibility if we ever add a CBOR transport."

Three independent codebases run that same 60-line extractor: `chromium-bidi` and `webdriver-bidi-protocol` both clone the spec repo to borrow it, then run `cddlconv` pinned to `0.1.10` with a version check that exits 1 on mismatch [HIGH].

**The qualification matters more than the thesis.** Serialization alone did not prevent Puppeteer's BiDi leak. Until [PR #14179](https://github.com/puppeteer/puppeteer/pull/14179) (OrKoN, merged 2025-09-09), `common/ConnectOptions.ts` imported `Session` from `chromium-bidi/lib/cjs/protocol/protocol.js`, the Chromium *implementation* package, and re-exported it publicly. Two years, with the wire protocol already in place. What fixed it was a second artifact: a spec-derived types package with no implementation in it, giving the neutral layer something non-vendor to depend on [HIGH].

So the precise claim is: **a port is safe when its types are generated from a normative source that no implementation can substitute for.** A wire format is neither necessary nor sufficient on its own.

And WebDriver classic has none of this: `w3c/webdriver` is a 443 KB ReSpec `index.html` with no schema and no generator. [w3c/webdriver#1510](https://github.com/w3c/webdriver/issues/1510), "Machine readable endpoint definitions", opened in 2020, is still open. Same working group, same wire, no schema [HIGH].

### 2.6 Which rules see `import type`, tool by tool

Each of these was tested [HIGH, own reproductions unless noted]:

| Mechanism | Sees `import type` by default? | Evidence |
|---|---|---|
| Playwright `check_deps.js` | **No.** Explicit early return, no opt-out | source plus the flip experiment in §2.2 |
| `import/no-cycle` | **No.** Hard-coded skip, no option | `return; // ignore type imports` |
| **dependency-cruiser** | **No** at default `tsPreCompilationDeps: false`. **Yes** when `true` | A/B below |
| `import/no-restricted-paths` | **Yes**, if the resolver resolves `.ts` | A/B below |
| `@typescript-eslint/no-restricted-imports` | **Yes.** `allowTypeImports` defaults to `false` | rule docs |
| `eslint-plugin-boundaries` | **Yes.** Unset `importKind` matches all kinds | source |
| Nx `@nx/enforce-module-boundaries` | **Yes.** Bare `ImportDeclaration` visitor, zero `importKind` references | source |
| ArchUnit | **No such hole.** Bytecode analysis, generic signatures resolved by default | user guide |

The dependency-cruiser A/B, on one rule and two modules:

```
tsPreCompilationDeps: false   →  ✔ no dependency violations found (2 modules, 0 dependencies cruised)   exit 0
tsPreCompilationDeps: true    →  error no-domain-to-infra: src/domain/port.ts → src/infra/pg.ts         exit 1
```

Docs, verbatim: *"By default, dependency-cruiser does not take dependencies between typescript modules into account that don't exist after compilation to JavaScript."* With the flag on, the edge is labelled `['local', 'type-only', 'import']`.

**Three fail-open paths in dependency-cruiser that all exit 0**, worth auditing in any inherited config [HIGH]:

1. `severity` omitted defaults to `warn`, and only `error` sets a non-zero exit.
2. No supported transpiler present yields `0 modules, 0 dependencies cruised` with an advisory and exit 0.
3. `tsPreCompilationDeps` defaults to false.

A passing build and an unenforced boundary look identical. Probe each rule red once with a value import, a type import and a bare barrel import, and check the cruise reported a non-zero module count.

The ESLint A/B produced a fourth failure mode worth more than the type question: with a Node resolver that cannot map `../infra/pg.js` to `pg.ts`, `import/no-restricted-paths` reported **nothing at all**, for the type import and the value import alike. Swap in `eslint-import-resolver-typescript` and both are flagged. A misconfigured resolver silently disables the rule with no warning and no artifact [HIGH].

### 2.7 Why browxai's rule did not catch it, and the fix

RFC 0009's `ports-name-no-vendor-type` is:

```js
from: { path: "^src/page/[a-z-]+-substrate(-types)?\\.ts$" },
to: { path: "node_modules/playwright-core|^playwright-core$" },
```

dependency-cruiser rules are direct-dependency by default. This catches a port module importing `playwright-core` in one hop, which is neither reported leak. It does not catch a port reaching `playwright-core` transitively through a sibling, and it does not catch a port importing `*-substrate-playwright.ts`, which is a port-to-adapter edge with no `playwright-core` specifier in it.

Two changes close both, in tooling already in the repo [HIGH]:

- Add `reachable: true` to the `to` clause. The docs define it as *"reachable (either directly or via other modules)"*, which makes the rule transitive. Expect a measurable cruise-time cost.
- Add a second rule, port glob to `-playwright\.ts$`, with no `reachable`. Cheap, and it catches the argument-vocabulary case directly.

`tsPreCompilationDeps: true` is already set at `.dependency-cruiser.cjs:93`. **On this one axis browxai's tooling is stricter than Playwright's**, whose 265 unauthorized imports all pass because of the type exemption. Do not let that line get removed for cruise speed.

### 2.8 The allowlist is the next thing to rot, and somebody has solved it

Three documented ways these rules get defeated [HIGH]:

**Allowlist creep.** Playwright's 110 stale entries across 38 files (§2.2), on the tightest discipline in the survey.

**Inline disables.** Nx maintainer meeroslav, closing [nrwl/nx#16877](https://github.com/nrwl/nx/issues/16877), 2023-05-09: *"whenever you feel that your approach is 'right' but `enforce-module-boundaries` is working against you, feel free to toggle it off with `// eslint-disable-next-line @nx/enforce-module-boundaries`."*

**Baseline rot.** [dependency-cruiser#1080](https://github.com/sverweij/dependency-cruiser/issues/1080), 2026-09-04: *"if they fix a violation (🎉) they are not forced to remove the reference ... This leads to dead known-violations."* Answered in 18.3.0 with `--baseline-mode shrink-only`. ArchUnit has the same shape, and worse: `FreezingArchRule`'s `allowStoreUpdate` **defaults to true**, so a frozen rule absorbs new violations silently.

**The model to copy is n8n [PR #35914](https://github.com/n8n-io/n8n/pull/35914)** (CharlieKolb, 2026-08-10), "ci: Enforce backend-module import boundaries in cli" [HIGH]. Its policy line is the one RFC 0009 should adopt verbatim: *"Type-only imports count: compile-time coupling is still coupling."* It declares 31 module-to-module edges explicitly, carries a 55-file grandfather list described as *"a shrink-only ratchet with the usual 'NEVER add to this list' contract"* with eight decoupling PRs in flight to burn it down, and ships **a second rule, `no-cross-module-import-disable`, that bans inline `eslint-disable` of the first rule**, so the config allowlist stays the only escape hatch.

RFC 0009's §Enforcement says *"An inline disable is never the relaxation mechanism; a change to this array is an RFC amendment with a written reason."* That is the right policy stated in prose, and prose is not a guard. n8n wrote the rule that protects the rule. browxai should too, and `PLAYWRIGHT_HANDLE_ALLOWLIST` should be a shrink-only ratchet with a test asserting its length never grows.

### 2.9 The thing nobody has

There is no published retrospective narrating "we split the port from the adapter and within N months the port had re-absorbed adapter types" [HIGH on the absence, searched across all six projects and general architecture writeups].

The closest is `orime-org/breatic` PR #551, merged 2026-09-12, which reports *"eight imports pointing the wrong way through its own layer order"* and, on guard configuration, *"`tsPreCompilationDeps: true`, because `import type` edges are off dependency-cruiser's graph by default. Three of the seven edges were type-only ... With the intuitive spelling (trailing slash, default options) the guard catches four of eight"* [MED, small repo, no elapsed-time measurement].

What exists instead is the artefact, sitting in the open: Puppeteer's `api/Page.ts`, and Playwright's own 265.

## 3. The sync-throw class at a port boundary

A method typed `Promise<T>` that is not `async` can throw synchronously. The throw escapes the caller's `.catch()` because no promise was created, so every structured-refusal path built on rejection is bypassed. browxai found 69 adapter methods in that shape.

### 3.1 There is a standards-body rule for this, and it is absolute

W3C TAG, *Writing Promise-Using Specifications* §4.1.1 [HIGH] (https://www.w3.org/2001/tag/doc/promises-guide):

> "Promise-returning functions must always return a promise, under all circumstances. Even if the result is available synchronously, or the inputs can be detected as invalid synchronously, this information needs to be communicated through a uniform channel..."

> "Promise-returning functions should never synchronously throw errors, since that would force duplicate error-handling logic on the consumer: once in a `catch (e) { ... }` block, and once in a `p.catch(e => { ... })` block. **Even argument validation errors are not OK.**"

The last sentence is the one to put in the port contract, because argument validation is exactly where an adapter is tempted to throw early. The absolute form was argued and upheld: Tab Atkins wanted argument-parsing errors to throw synchronously as a feature-detection signal ([domenic/promises-unwrapping#24](https://github.com/domenic/promises-unwrapping/issues/24), 2013-09-07) and the guide kept the ban [HIGH].

**The web platform enforces it at the binding layer, not the type layer.** Any Web IDL operation declared to return a promise has its exceptions, including type-conversion and overload-resolution failures, automatically converted to rejections [MED].

Node's own design philosophy says the same thing for callbacks [HIGH] (https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick): *"an API should always be asynchronous even where it doesn't have to be"*, with the worked example routing a bad-argument `TypeError` through `process.nextTick`. Node core has been bitten by its own violation ([nodejs/node#31275](https://github.com/nodejs/node/issues/31275), 2020-01-09) and, more relevantly, `assert.rejects` once passed when the function under test threw synchronously, because no promise existed to reject ([nodejs/node#19646](https://github.com/nodejs/node/issues/19646), 2018-03-28) [HIGH]. That second one is the test-harness version of the bug and it is worth a keystone assertion.

Isaac Schlueter's "don't release Zalgo" rule is the callback-era framing of the same hazard [HIGH]: *"If you have an API which takes a callback, and sometimes that callback is called immediately, and other times that callback is called at some point in the future, then you will render any code using this API impossible to reason about."*

### 3.2 The type system cannot catch it, and that is settled

`async` is an implementation detail of a function body, not part of its type. `() => Promise<T>` and `async () => T` produce the identical type. Catching the sync throw needs the compiler to model which exceptions a function can throw, which is an effect system. That was [microsoft/TypeScript#13219](https://github.com/microsoft/TypeScript/issues/13219), "Suggestion: `throws` clause and typed catch clause", opened 2016-12-29 and **closed 2023-04-19 as declined** [HIGH]. There is no compiler flag and no type-level trick. The check lives in lint or in an architecture test.

### 3.3 The lint rule exists and almost nobody has it on

`@typescript-eslint/promise-function-async`, *"Require any function or method that returns a Promise to be marked async"*. Its motivation, verbatim [HIGH]:

> Ensures that each function is only capable of:
> - returning a rejected promise, or
> - throwing an Error object.
>
> In contrast, non-`async`, `Promise`-returning functions are technically capable of either. Code that handles the results of those functions will often need to handle both cases, which can get complex.

`requiresTypeChecking: true`, and `fixable: 'code'`, so it auto-fixes.

**It is in `all` and in no other shared config.** Verified against the plugin's config sources at HEAD: zero references in `recommended`, `recommended-type-checked`, `strict`, `strict-type-checked`, `stylistic` or `stylistic-type-checked` [HIGH].

| Rule | Config | Catches |
|---|---|---|
| `await-thenable` | recommended-type-checked | awaiting a non-thenable |
| `no-floating-promises` | recommended-type-checked | a promise-valued statement with no `await` or `.catch` |
| `no-misused-promises` | recommended-type-checked | promises in conditionals and void-return positions |
| `require-await` | recommended-type-checked | `async` with no `await` |
| `return-await` | strict-type-checked | `return promise` inside a `try`, which lets the rejection skip the local `catch` |
| `promise-function-async` | **`all` only** | **this bug class** |

A project on `strict-type-checked` gets the whole promise-hygiene family except the one rule that catches a promise that was never created. browxai's `eslint.config.js` at `550abe7` matches that shape: `no-floating-promises`, `no-misused-promises` and `require-await` are all `"error"` (lines 658, 660, 678); `promise-function-async` appears nowhere. Type-aware linting is already configured, so it is a one-line addition.

Two interactions worth knowing before turning it on.

`require-await` is the direct antagonist for one spelling. It permits `async` with no `await` when the body returns a thenable, so `async foo() { return this.delegate.bar(); }` is fine. It does **not** permit `async` on a body that returns a plain refusal literal, which is exactly the constant-refusal shape a no-op substrate wants. browxai already carries a `require-await: "off"` exemption for `src/server.ts` and `src/tools/*.ts`; the port modules need the same pairing.

`return-await` catches the adjacent failure one layer in: a `return promise` inside a `try` lets the rejection land on the caller instead of the local `catch` [HIGH]. Playwright enables it (`['error', 'always']`, with a performance note citing v8.dev); browxai should check whether it does.

Neither Playwright nor Puppeteer enables `promise-function-async` [HIGH, both `eslint.config.mjs` read at HEAD]. Both have type-aware linting available and chose not to.

### 3.4 The structural answers, including one in browxai's own dependency

**Playwright prevents it by construction.** Every client-side protocol method is produced by a proxy returning `async (params, options = {}) => { return await this._wrapApiCall(async apiZone => { ... }) }`, and `_wrapApiCall` is itself `async` [HIGH] (`client/channelOwner.ts`). Two `async` keywords between user code and the wire. Nothing on that path can throw synchronously. That is per-method discipline implemented once, as a generated wrapper.

**The MCP TypeScript SDK does not trust handlers to be `async`, and says why in a comment.** In `packages/core-internal/src/shared/protocol.ts`, both notification and request dispatch read [HIGH]:

```js
// Starting with Promise.resolve() puts any synchronous errors into the monad as well.
Promise.resolve()
    .then(() => handler(request, ctx))
    .then(async result => { ... }, error => { /* maps to a JSON-RPC error response */ });
```

browxai's transport already sits behind that hoist. The 69 methods are below it, inside the substrate layer, where nothing hoists.

**`Promise.try` is the modern spelling.** TC39 stage 4, ES2025, Baseline since January 2025 [HIGH]. The proposal explains why `Promise.resolve().then(f)` is the wrong tool: *"`f` is needlessly run asynchronously, on a future tick."* MDN names the failure it fixes: *"if `func()` synchronously throws an error, this error would not be caught and turned into a rejected promise."* browxai is on Node 26, so `Promise.try(() => delegate.foo())` is available for defence in depth at the substrate call sites.

### 3.5 The refusal envelope makes it worse, and someone wrote that down

An `{ok: false, error}` design moves expected failures out of the throw channel, so callers stop wrapping adapter calls in `try/catch`. The sync throw then has nothing between it and the top of the stack. The envelope removes the accidental safety net.

The written case is [supermacro/neverthrow#488](https://github.com/supermacro/neverthrow/issues/488), 2023-07-24 [HIGH]. `ResultAsync.fromPromise(f())` evaluates `f()` before `fromPromise` runs, so a synchronous throw in `f` escapes the `Result` envelope entirely. The reporter: you would have to handle the error in the `Result` *and* still wrap the call in `try/catch`, which *"defeats the entire purpose of using a library like this, because the whole point is that the errors are moved from thrown, untyped values into the return type of the function."* The accepted fix, shipped February 2024, is the same hoist the MCP SDK uses.

That is browxai's `EngineRefusal` and the substrate refusal shapes, in one paragraph, from a library that hit it two years ago.

**Negative result worth recording.** I searched Playwright, Puppeteer, Selenium and Appium for this bug class by five phrasings and found no confirmed instance filed against any of them [MED]. The closest is [puppeteer#10734](https://github.com/puppeteer/puppeteer/issues/10734) (2023-08-14), the event-emitter variant: Puppeteer emits browser events with a synchronous `emit`, so an async listener's rejection has no owner and escapes the caller's outer `try/catch`. My reading is under-reporting rather than absence. The symptom surfaces as an unhandled rejection or as a test that silently passes, and it gets filed under the symptom.

---

## 4. Selenium and W3C WebDriver

### 4.1 The spec's shape was inherited, not designed

WebDriver §1.1 says so [HIGH]:

> "This specification is derived from the popular Selenium WebDriver browser automation framework. Selenium is a long-lived project, and due to its age and breadth of use it has a wide range of expected functionality. This specification uses these expectations to inform its design."

The 2012 first Working Draft was a WebIDL API with HTTP as an appendix. The endpoint-table-first rewrite arrives by the 2015 draft. REC landed 2018-06-05.

### 4.2 Capabilities are session routing, never feature negotiation

`alwaysMatch` / `firstMatch` came from [w3c/webdriver#327](https://github.com/w3c/webdriver/pull/327) (opened 2016-09-06, landed 2016-10-21), whose stated goals are match-or-fail plus ordered preference [HIGH]. andreastt, 2018-02-01 [HIGH]:

> "Capabilities are meant for defining a failsafe matrix selection of a browser configuration in a distributed WebDriver environment ... in cases where you talk to an intermediary node multiplexer ... capabilities are used for selecting a node in this network that matches the capability requirements."

A per-command discovery mechanism was proposed and declined. jugglinmike asked for a `supportedCommands` capability ([#765](https://github.com/w3c/webdriver/issues/765), 2017-02-15); shs96c, 2017-02-16 [HIGH]:

> "any command that MAY be implemented (as opposed to MUST) needs a capability."

and, in the same thread:

> "command names are a convenient fiction. The spec is defined in terms of URLs and HTTP verbs."

The spec is honest about what matching cannot do [HIGH]: *"The algorithm outlined in matching capabilities blithely ignores real-world problems that make implementation less than perfectly straightforward, particularly since capabilities can interact in unforeseen ways."*

### 4.3 The one boolean that exists to pre-announce optional support does not interoperate

`setWindowRect` is the standard capability for "can this remote end position windows." [w3c/webdriver#1793](https://github.com/w3c/webdriver/issues/1793), open since 2024-02-14 [HIGH]:

- whimboo (Mozilla): *"In Firefox we match that capability and fail if the value is not appropriate."*
- OrKoN (Chrome): *"Chrome does not do matching for this capability and it is a return-only value ... (it will reject the property as invalid argument if it is in the capabilities request)."*
- gsnedders: *"It likewise is return-only in safaridriver."*
- jimevans (Selenium): *"Generally speaking, Selenium expects that capability to be return-only."*
- titusfortner, 2024-04-12: *"I've never understood why it was there in the first place. 😂"*

One capability, four behaviours, and an `invalid argument` if you send it to the wrong driver. That is the strongest available evidence that a declaration nobody enforces drifts, and it is a single boolean in a W3C Recommendation.

### 4.4 Where `RemoteWebDriver` still leaks

`ChromiumDriver` implements `HasCdp`, `HasDevTools` and others locally. Over Grid you get a bare `RemoteWebDriver` and the cast fails, which is [#9803](https://github.com/SeleniumHQ/selenium/issues/9803) (2021-09-08). The vendor-interface set was created wholesale in commit `12a14a2`, *"Create interfaces for RemoteWebDriver to use with Augmenter (#9856)"*, **2021-09-28, two weeks before 4.0 GA**, across 42 files [HIGH].

`AddHasCdp.isApplicable()` string-matches the browser name. `ChromiumDriver` injects the CDP websocket into the returned capabilities as `se:cdp` and `se:cdpVersion`, which is Selenium's own vendor prefix carrying a non-W3C channel inside W3C capabilities. `AddHasAuthentication` and `AddHasLogEvents` check `instanceof HasDevTools` at call time **with no else branch**, so on a non-CDP backend `onLogEvent` silently does nothing [HIGH].

.NET leaks statically instead: `RemoteWebDriver : WebDriver, IDevTools, IHasDownloads`, so every remote driver claims DevTools at compile time and throws at runtime when `se:cdp` is absent [HIGH].

The ongoing tax is visible in every release: `java/CHANGELOG` for 4.49.0 opens with *"Support CDP versions: v151, v152, v153."* And the replacement is being pushed back under the surface: `bidi/HasBiDi.java` now carries `@Deprecated(since = "4.46", forRemoval = true)` with *"BiDi is an internal implementation detail. Direct access to the BiDi object from drivers will be removed in a future release"* [HIGH]. Selenium is walking back the public protocol handle, five years after adding the public vendor handles.

### 4.5 What Selenium 4 cost

Measured [HIGH]:

| Span | Duration |
|---|---|
| 3.141.59 → 4.0.0 GA (Java) | 1,064 days (35.0 months), 4,403 commits |
| alpha-1 (2019-04-18) → GA (2021-10-13) | 909 days, alpha phase 74% of it |
| npm 3.6.0 → 4.0.0 | 1,468 days. JS users had no stable Selenium for four years |
| W3C REC (2018-06-05) → GA | 40.3 months |
| Ruby drops JSON Wire (2019-01-08) → Java drops it (2023-04-05) | 1,548 days of carrying both dialects after the first binding cut it |
| GA → last JWP code deleted | 539 days (17.7 months) |
| Ruby cut → last `ErrorCodes` annotation fix (2026-06-05) | 7.4 years of residue |

What regressed at GA:

- **Grid session creation, 32 to 40 times slower.** [#10242](https://github.com/SeleniumHQ/selenium/issues/10242), 2022-01-11, Andrew Nicols of Moodle, 50-run harness: Docker CI Chrome 121 ms → 4,825 ms; Ubuntu 20.04 Chrome 152 ms → 4,817 ms. Molina's fix six days later was a default-value change, closed 98 days after GA [HIGH].
- **A parallel-execution regression shipped in GA and stayed open 724 days.** [#9359](https://github.com/SeleniumHQ/selenium/issues/9359). Four HTTP client implementations were swapped in 13 months [HIGH].
- **W3C Actions cost 250 ms per pointer move for 929 days.** [#7281](https://github.com/SeleniumHQ/selenium/issues/7281), 2019-06-11 to 2021-12-26. `DEFAULT_MOVE_DURATION = 250` comes from the spec's action model, so a 50-step chain costs 12.5 seconds. A direct cost of the standard itself [HIGH].

Two readings matter for browxai.

**The de-vendoring was the cheap part.** Ruby's OSS-dialect removal landed 2019-01-08, .NET's 2019-02-27, both before the cross-language alpha-1. What consumed 2019 to 2021 was the Grid rewrite, CDP, GraphQL, OpenTelemetry and the HTTP client churn [MED, inferred from the CHANGELOG]. The protocol swap itself was months. RFC 0009's five phases are protocol-swap-shaped work, and the Selenium evidence says that part is tractable.

**The compatibility tail bought nothing.** Searching for issues created between 4.9.0 and 2023-09-30 mentioning `3.141`, `json wire` or `older client` returns two issues, neither related [HIGH on the count, MED on the reading]. Four years of dual-dialect maintenance produced no post-GA bug reports. RFC 0009's P1 `page?()` is the analogous compatibility device, and it is time-boxed to one phase. Keep it that way.

Fortner, 2022-05-20, on why they stopped [HIGH]:

> "By far the biggest challenge in the past seven years of Selenium development has been transitioning the underlying implementation from the legacy JSON Wire Protocol to the new standardized W3C WebDriver Protocol ... Because the code must make some assumptions and guesses for this to work, there are a lot of frustrating edge cases."

Stewart, 2020-11-10, on who the protocol swap was for [HIGH]:

> "So what does this adoption of the W3C protocol mean for you? I'll be honest: it probably doesn't mean much to you at all."

Fourteen days after GA he stepped down as project lead.

### 4.6 Element references

A web element reference is an opaque string under the constant `element-6066-11e4-a52e-4f735466cecf`, minted by the remote end [HIGH]. It is explicitly not required to be a UUID; shs96c, 2017-01-27: *"The original IEDriver used a serialisation of the COM object's address, and that would meet the constraints required here too."*

Lifetime is modelled with weak maps: a per-session, per-browsing-context-group node id map, plus a per-navigable seen-nodes set. A reference the current navigable never saw is `no such element`; one it saw whose node is detached or whose document was replaced is `stale element reference`.

jgraham's argument for that design, [#1594](https://github.com/w3c/webdriver/issues/1594), 2021 [HIGH]:

> "Particularly with heavily multiprocess architectures in modern browsers, the stale element reference distinction alone requires an implementation to keep at least a list of all known element references in the main process."

> "we don't want to extend the lifetime of the object ids past the lifetime of the global"

christian-bromann, on the client view: WebdriverIO keeps the original selector on its element wrapper and silently re-finds on staleness, so *"the biggest advantage to have a stale element error was to give the devil a name."*

That last sentence is browxai's situation precisely. browxai keeps the selector recipe and re-finds. What it lacks is the name for the case where re-finding produced something different.

---

## 5. The BiDi module carve, and its missing handshake

### 5.1 The modules

Ten modules at the current Working Draft [HIGH] (https://www.w3.org/TR/webdriver-bidi/): `session` (5 commands), `browser` (7), `browsingContext` (15 commands, 14 events), `script` (6 commands, 3 events), `network` (13 commands, 5 events), `storage` (3 commands), `log` (0 commands, 1 event), `input` (3 commands, 1 event), `emulation` (13 commands), `webExtension` (2 commands). New modules arrive by addition: `io` for streams ([#1061](https://github.com/w3c/webdriver-bidi/issues/1061), 2026-01-15; [#1135](https://github.com/w3c/webdriver-bidi/issues/1135), 2026-07-14), `autofill` ([#706](https://github.com/w3c/webdriver-bidi/issues/706), 2024-05-06).

The full comparison against browxai's substrates is §11.

### 5.2 BiDi has no feature detection, and the working group declined to build one

The current standards answer to browxai's exact question is that there is no answer. [w3c/webdriver-bidi#826](https://github.com/w3c/webdriver-bidi/issues/826) ("Feature detection", Elchi3, 2024-12-04, still open). Working group minutes, 2024-12-11 [HIGH]:

> **jgraham**: I think is a very difficult problem to solve and I am not sure how we can solve this. I kinda feel that keeping this manually updated in a spreadsheet is better. I think one way or another there will be manual process
>
> **jgraham**: We've never been able to do this on any other platform in the past. It seems easy to start but then it gets very difficult very quickly

Earlier, [#619](https://github.com/w3c/webdriver-bidi/issues/619) minutes, 2023-12-13, where the protocol mechanism was proposed and deflected [HIGH]:

> **cb**: From the client perspective this would be very helpful either as a file or as an endpoint in the driver.
>
> **jrandolf**: The problem to solve is building a browser compat table? Isn't the point of these meetings to standardise and implement everything in BiDi?

#619 closed 2025-09-03. The answer shipped was a Google Sheet feeding `mdn/browser-compat-data/webdriver/bidi`, whose last commits are 2026-09-09 and 2026-09-03 [HIGH]. Probe-and-catch in the protocol, hand-maintained table out of band.

BiDi's own capability surface is exactly one boolean, `webSocketUrl`, *"Defines the current session's support for bidirectional connection"* [HIGH]. That is a yes/no on whether BiDi exists at all.

### 5.3 The probe does not even have a defined error

[w3c/webdriver-bidi#801](https://github.com/w3c/webdriver-bidi/issues/801), "What error should unimplemented commands return?", gsnedders, 2024-10-24. One comment, 23 months of silence since. OrKoN [HIGH]:

> "I think it is preferred if implementations handle all commands defined in a specification returning the 'unsupported operation' errors only for commands/scenarios that explicitly allow that ... As for commands that are not yet implemented, I think returning either the unknown or unsupported error is fine as a temporary implementation."

So BiDi chose probe-and-catch and did not specify what the catch catches. That is not an endorsement of probing over declaring. It is a working group that found both hard and shipped neither.

`unsupported operation` appears about 25 times normatively, always for per-feature refusal *inside* an implemented command. Even a complete remote end refuses sub-features at call time.

### 5.4 Node references

BiDi separates two reference kinds [HIGH]. A `SharedReference` (`sharedId`) names a DOM node, is valid across realms within a browsing context, and needs no ownership. A `RemoteObjectReference` (`handle`) is a strong reference that keeps the object alive and is released by `script.disown`. Deserialising an unknown handle is `no such handle`; an unknown shared reference is `no such node`.

`browsingContext.locateNodes` takes a locator (css, innerText, xpath, accessibility, context) and returns shared references. The node-cache machinery that makes this work landed in [w3c/webdriver#1705](https://github.com/w3c/webdriver/pull/1705), merged 2022-12-16, jgraham [HIGH]:

> "For WebDriver BiDi we want to be able to return any Node object, and to support all reachable Nodes, not just those in the same browsing context. Therefore the approach of having per-Window Element and ShadowRoot caches won't work."

The lesson for `ElementToken`: the standard's answer to "what does a resolved element look like across a port" is two distinct reference kinds with different lifetimes, plus an explicit disown command. A single opaque token with no lifetime story is a simplification the standard considered and rejected.

---

## 6. Appium

### 6.1 Support is declared as routing data and discovered by calling

Every WebDriver, MJSONWP and Appium route exists in base-driver regardless of which driver is loaded. `protocol.ts` [HIGH]:

```ts
// if a command is not in our method map, it's because we
// have no plans to ever implement it
if (!spec.command) {
  throw new errors.NotImplementedError();
}
```

The driver-authoring guide states it plainly: *"if your driver doesn't implement a command, users can still try to access the command, and will get a 501 Not Yet Implemented response error"* [HIGH]. `newMethodMap` and `executeMethodMap` are real declarative data, and neither tells a client whether the command works.

**Introspection arrived 18 months after Appium 2.0 GA.** `GET /session/:id/appium/commands` shipped in January 2025 ([appium/appium#20881](https://github.com/appium/appium/issues/20881), opened 2025-01-05, closed 2025-01-26) [HIGH]. jlipps in that thread, 2025-01-08:

> "Do we think this info could already be automatically generated based on the code in the drivers? If not, we might want to consider an approach that would make that possible."

KazuCocoa, next day: *"I think not really..."*

An extensible driver ecosystem shipped in 2023 and could not answer "what do you support" until 2025, and the answer it now gives covers routes rather than semantics. Locator strategies, context-dependent behaviour and coordinate systems are still not on the wire.

### 6.2 Locator strategies change meaning by context and are never advertised

XCUITest declares two arrays [HIGH]:

```ts
this.locatorStrategies = ['xpath','id','name','class name','-ios predicate string','-ios class chain','accessibility id','css selector'];
this.webLocatorStrategies = ['link text','css selector','tag name','link text','partial link text'];
```

(`'link text'` appears twice, which is a live bug and a fair indicator of how much attention the list gets.)

UIA2 declares one array and no `webLocatorStrategies` at all, because it proxies the whole web context to chromedriver. Two first-party drivers solve the same problem with opposite architectures. Enforcement is `validateLocatorStrategy(strategy, webContext)`, which throws `InvalidSelectorError`. None of it is in `desiredCapConstraints`, the session response, or `listCommands`. A client learns by sending and getting a 400 [HIGH].

The official guide's entire contract for this is one sentence: *"Depending on the type of context you're in, the operation of the driver might change."*

### 6.3 The coordinate-system mismatch has no fix and the maintainers say so

[appium/appium#21423](https://github.com/appium/appium/issues/21423), opened 2025-07-15, closed 2025-08-25. `element.rect` returns `{x: 19.6, y: 19.6}` in webview context where the Inspector shows `(29, 65)` [HIGH]:

- mykola-mokhnach, 2025-07-15: *"Mobile commands operate with native coordinates, while above element.location, .rect, etc. attributes fetch coordinates specific to the webview where the element is located. Consider doing transformation between webview and native coordinates manually."*
- mykola-mokhnach on `mobile: calibrateWebToRealCoordinatesTranslation`, 2025-07-18: *"Although, it still does not guarantee 100% accuracy."*
- mykola-mokhnach on closing, 2025-08-26: *"Because this is not an issue. It's a question, that none has an answer for."*

[appium/appium#9979](https://github.com/appium/appium/issues/9979), "Coordinate conversion off for iOS using nativeWebTap", opened **2018-01-13**, closed **2025-03-13** as a duplicate. Seven years [HIGH]. The current capability doc is an admission: *"Web-to-native coordinate translation is calibrated automatically: the driver fits an empirical offset/pixel-ratio transform against the current page and refits it whenever the orientation, viewport size, or scroll position changes."*

Commands whose meaning changes with context: `findElement`, `getPageSource` (XML hierarchy or HTML DOM), `takeScreenshot` (two different subsystems, toggled by `nativeWebScreenshot`), `getElementRect` (device points or CSS pixels), `click` (atom JS click or `nativeWebTap` coordinate synthesis), `performActions` (XCUITest supports W3C actions in native context only; Android supports them in both, because chromedriver handles it), `getAlertText`, `getCurrentUrl`.

**This is the warning for RFC 0008 and 0009 together.** One port surface over two worlds, where the same method means different things per engine, is how Appium got here. browxai's substrates are typed per-capability, which is better. The trap to avoid is a `TargetSubstrate.url()` whose native meaning (`app://com.acme.app/CheckoutScreen`) is silently a different kind of string from its web meaning, consumed by `SecretRegistry.materialize` as a scope. RFC 0009 proposes exactly that. Name the two kinds in the type, or a scoped secret will match a screen id by substring accident.

### 6.4 Appium 1 to 2 cost

`appium@2.0.0-beta.0` published 2020-06-29. `appium@2.0.0` GA 2023-07-05. **Three years and one week, 71 prerelease versions** [HIGH]. What broke: drivers no longer bundled, base path `/wd/hub` → `/`, JSONWP dropped, `appium:` prefix mandatory on every non-standard cap, image comparison and find-by-image moved out to a plugin, Execute Driver Script moved to a plugin.

Appium 3 (2025-08-18) is a second round of the same bill: roughly 80 deprecated endpoints removed, driver-scoped `--allow-insecure` prefixes, `GET /sessions` moved behind a feature flag [HIGH].

No maintainer post-mortem exists [HIGH on the absence]. The public record is announcement-shaped.

---

## 7. Playwright: the counter-argument

### 7.1 The answer to "give me a driver port" is "fork the repo"

yury-s, 2021-12-09, to Netflix asking to register a custom `BrowserType` [HIGH]:

> "registering a new browser type for it would entail supporting another remote debugging protocol in Playwright. Public API for that would likely be bigger than current Playwright API (look at browser-specific bits for e.g. WebKit) which would be a huge maintenance burden for the project."

pavelfeldman, same thread [HIGH]:

> "If you'd like to reuse the logic that we use in our internal browser/context/page/expect, you'd need to clone the repo ... all of that is the implementation detail, there is no contract there."

> "I'd start with cloning playwright, implementing a new browser, and then figuring out what internal extension points you would benefit from. They are unlikely to become a public API."

pavelfeldman on the protocol, 2024-04-04 [HIGH]: *"We consider the communication protocol that Playwright uses to be its implementation detail."*

The most current statement, yury-s, 2025-09-16, declining Mozilla's request for a public `protocol` launch option [HIGH]:

> "Playwright doesn't distinguish between different 'protocols' for driving the same browser today, those are internal details. We'd rather not put that choice on users."

And the ownership argument, which is the sharpest one:

> "Since most of the Bidi code lives in the Mozilla repo, and we can't patch it as quickly as Playwright-owned code ... it makes sense for the Firefox team to own those channels. This would avoid Playwright being blocked by other teams'/committees reaction time, staffing, or approval processes when quick turnaround is needed."

pavelfeldman on why patched builds, 2021-03-30 [HIGH]: *"We are a bit different with Selenium in that we add features, so we need new browsers to be able to use those new features."*

### 7.2 The internal seam is hybrid, and thicker than browxai's

Playwright does not subclass `Page`. There is one concrete `Page` holding `readonly delegate: PageDelegate`. `CRPage`, `FFPage`, `WKPage` and `BidiPage` implement the delegate. At the browser level it *does* subclass: `abstract class Browser`, `abstract class BrowserContext`, `abstract class BrowserType` each have four per-browser subclasses [HIGH].

`PageDelegate` has **39 members**: three readonly input primitives, one readonly boolean quirk flag, 35 methods, five of them optional [HIGH]. Four members exist only to name a specific browser's bug, with the browser named in a comment in the shared header file: `rafCountForStablePosition` ("Work around WebKit's raf issues on Windows"), `inputActionEpilogue` ("Work around Chrome's non-associated input and protocol"), `cspErrorsAsynchronousForInlineScripts?` ("Work around for asynchronously dispatched CSP errors in Firefox"), `shouldToggleStyleSheetToSyncAnimations` ("WebKit hack"). `getFFmpegVideoFilterArgs?` is commented *"Allow Bidi to set different ffmpeg video filter args."*

So the industry's best-regarded browser abstraction has a 39-member port whose contract names four engines by name. browxai's L4 member budget is a browxai constraint, not a shared one.

Chromium-only features are **separate classes, not throwing methods**: `CRCoverage` is a standalone 286-line class in `chromium/crCoverage.ts`, on no shared interface, with no Firefox or WebKit stub [HIGH]. That is the right pattern and it is what `playwright?(): PlaywrightSessionHandle` achieves.

### 7.3 Where it leaks to users

`browserContext.newCDPSession` sits on the plain `BrowserContext` interface in `types.d.ts` with a doc note. Enforcement is four runtime string comparisons in dispatchers (`browserType !== 'chromium'`), zero type-level gating [HIGH].

`page.coverage` is worse. The client constructs it unconditionally; the server declares `readonly coverage: any` and sets it from `delegate.coverage ? delegate.coverage() : null`; the dispatcher then does `this._page.coverage as CRCoverage` with no browser guard [HIGH]. On Firefox that is a cast on `null`. Playwright dodges it in its own suite by putting the coverage specs in `tests/library/chromium/`, gated by test-project config rather than by any in-code check [MED on the exact user-visible symptom, which I did not execute].

Chromium-only APIs are documented by prose note at seven sites in `docs/src/api/`. There is no tag, no generated type split, and no capability query [HIGH].

**The lesson browxai should take.** Playwright avoided the port tax by refusing to have a port. browxai cannot make that choice, because Safari already ships and native is committed. What browxai can take is the shape: keep engine-specific power in separate classes reached through a named handle, and never as an optional member on the shared type.

---

## 8. Puppeteer: the cost of publishing the seam

### 8.1 Why Firefox moved to BiDi

Mozilla's reasoning, 2024-08-07 [HIGH] (hacks.mozilla.org): Firefox's CDP implementation was partial, unmaintained, and incompatible with site isolation. Chrome's framing the same day: CDP is unstandardised and *"changes with DevTools requirements"*, so Puppeteer could never guarantee API compatibility.

Timeline [HIGH]: first real BiDi work 2022-05-17 (PR #8358). GA in v23.0.0, 2024-08-07, listed as a breaking change. Firefox-over-CDP removed 2024-12-19 (PR #13427), shipped in v24.0.0, 2025-01-09. **27 months to GA, 32 to removal.**

### 8.2 The gap is a permanent tax, not a closing one

59 `throw new UnsupportedOperation` sites at HEAD, 57 in `bidi/` [HIGH]. The distribution: `bidi/Page.ts` 17, `bidi/Target.ts` 9, `bidi/Browser.ts` 8, `bidi/Input.ts` 5, `bidi/BrowserContext.ts` 3, the rest scattered.

Two years after GA the list is still growing. Every new CDP-backed feature lands with a matching throw: `page.openDevTools()` (#14396, 2025-11), `browser.screens()` (#14445, 2025-11), the PWA APIs (#15235, 2026-07), extension realms (#14824, 2026-04) [HIGH].

**Some throws are on option values, not methods.** `page.screenshot({omitBackground: true})` throws; `page.screenshot({})` works. Same for `setPermission` with `panTiltZoom` or a `*` origin. No type can express that [HIGH].

### 8.3 The prose list is the only capability channel and it is already wrong

[puppeteer#13668](https://github.com/puppeteer/puppeteer/issues/13668), "mark functions that don't work with WebDriver BiDi in the docs of the function itself", filed 2025-03-11 by a Babel maintainer, still open. OrKoN the same day [HIGH]:

> "It is difficult to keep in sync since our website is generated from code comments and the tooling does not support custom tags requiring to duplicate notes in comments. For now, we opted into maintaining a list in a standalone doc."

Verified against source at HEAD, `docs/webdriver-bidi.md` [HIGH]:

- Lists `Page.emulateCPUThrottling()`, `Page.emulateIdleState()` and `Page.setOfflineMode()` as unsupported. All three are implemented in `bidi/Page.ts`.
- Omits `HTTPRequest.postData()`, which throws at `bidi/HTTPRequest.ts:164`.
- Lists `PageEvent.popup` under unsupported at line 89 and `Page 'popup' event` under fully supported at line 101. One file contradicting itself.

Users hitting runtime throws TypeScript did not warn about, four confirmed cases [HIGH]: [#12293](https://github.com/puppeteer/puppeteer/issues/12293) (2024-04-18, `dragAndDrop`), [#14259](https://github.com/puppeteer/puppeteer/issues/14259) (2025-09-29, `postData`, reporter: *"The following documentation page does not mention that `postData` was not supported"*), [#13937](https://github.com/puppeteer/puppeteer/issues/13937) (2025-06-13, `resourceType`), [#13344](https://github.com/puppeteer/puppeteer/issues/13344) (2024-11-29, `emulateTimezone`).

### 8.4 There is a capability query and users cannot reach it

`bidi/Browser.ts:204` has `get cdpSupported(): boolean`, consulted at 16 internal sites to decide throw-or-delegate. It is declared on `BidiBrowser`, and `puppeteer.launch()` returns the abstract `Browser`, so no user holds it [HIGH]. Verified absent from `src/api/` and from `docs/`.

So the only capability signal reaching user code is an `UnsupportedOperation` instance that mostly carries no message.

**The design was never argued.** The error class arrived in [PR #11322](https://github.com/puppeteer/puppeteer/pull/11322), 2023-11-08, with an empty PR body and no discussion [HIGH]. I found no maintainer statement defending inherit-and-throw on its merits [MED on the absence].

---

## 9. The native lane

### 9.1 mobile-mcp: the trial's finding is a design property, and it is unreported

Until 2026-09-08 the only targeting path was raw pixels. On that date commit `7feb092` (PR #429, released 1.0.3) added an optional `ref` to the click tool [HIGH]. The tool description now reads: *"Refs and coordinates stay valid as long as the screen does not change; re-list only after navigation or a layout change."*

The resolution happens in the Go backend, `mobile-next/mobilecli`, and its own source comments are unambiguous [HIGH]:

```go
// resolveRefTapPoint re-dumps the UI tree, numbers it exactly like "dump ui"
// does, and returns the center of the element matching ref ("@e5").
// Refs are positional against a fresh dump; there is no staleness tracking.
```

```go
// AttachRefs assigns each element a ref ("@e1".."@eN") in depth-first pre-order,
// so a ref is the element's position in the tree as printed. Refs are only
// valid against the dump that produced them.
```

`@e5` is an ordinal. The tap path re-dumps and takes whatever is now fifth in depth-first order. Anything that scrolled, expanded or inserted a node between listing and tapping moves the target, and the tool returns `Clicked on element @e5` with no error. There is no generation counter, no bounds check, no evidence comparison.

**Is it a known reported flaw? No.** All 152 non-PR issues in mobile-next/mobile-mcp and all 26 in mobilecli were pulled and searched for wrong element, stale, coordinates changed, layout shift, false success and tapped wrong. Nothing reports positional-ref drift [HIGH]. The ref path is eight days old, which explains the silence.

The adjacent evidence exists. [#190](https://github.com/mobile-next/mobile-mcp/issues/190) (open, 2025-09-11) is a confident wrong tap on a freshly-appeared iOS action sheet: *"The MCP tool can get these buttons and knows to click the third one 'Choose File', but it finally clicked 'Camera or Record'."* [#163](https://github.com/mobile-next/mobile-mcp/issues/163) and [#29](https://github.com/mobile-next/mobile-mcp/issues/29), both closed 2026-09-13, report *"about 90% of the coordinates the LLM tries is invalid"*; the fix was a screenshot-scaling note, which addresses a different cause [HIGH].

**The owner's trial result is reproducible from the source and is not a bug report anyone has filed.** Cite the source comments, not the trial, when this needs to be defended.

### 9.2 Maestro re-resolves and says why, in ticket numbers

`Maestro.tap(element, initialHierarchy, ...)` (`Maestro.kt:216-277`) [HIGH]: wait for the app to settle; if the settle returned null and a recent scroll is recorded, call `refreshElementUntilStable`, which polls fresh hierarchies until the element's bounds are identical across two consecutive fetches; otherwise refresh against the settled tree; tap the centre of the refreshed element.

`ViewHierarchy.refreshElement` matches by **attribute identity minus bounds** and returns null when the match count is not exactly one [HIGH]. Position is re-derived, identity is by attributes, and refresh ambiguity fails closed.

The code carries the ticket IDs for the bugs that motivated it: MA-4124 (an iOS screen-static check passes while a scroll view is still decelerating, so a tap aimed with a mid-deceleration hierarchy lands where the element used to be) and MA-4135 [HIGH].

**Ambiguity never fails, it picks.** Without an `index`, `Filters.clickableFirst()` sorts clickable nodes ahead of non-clickable and the engine takes `.firstOrNull()`. With an `index`, sorting is top-to-bottom then left-to-right. The docs state none of this [HIGH]. Maestro made the same choice browxai's `resolveTargetChecked` made, and documented it less.

The coordinate escape hatch carries a warning: *"Prefer using element selectors like `id` or `text` over coordinates. Tapping by coordinate can make tests brittle and device-dependent."*

Maestro's MCP server has no element refs at all. The LLM writes selectors; the engine resolves and retries them [HIGH].

### 9.3 agent-device refuses instead of re-resolving

ADR 0014 is the corrective design, summarised in §0.1. The mechanism worth transcribing [HIGH]:

- Frame state is separate from `session.snapshot`, the latest operational observation.
- A complete `snapshot` activates an `all` frame. `find`, settled diffs and replay divergence screens activate a bounded partial frame. Internal read-only captures activate nothing.
- Every mutating leaf expires the frame at the device side-effect seam, synchronously, before the device op, with no success-only rollback. A post-dispatch timeout still leaves it expired.
- Four ordered typed rejection reasons: `ref_frame_expired`, `ref_generation_mismatch`, `plain_ref_requires_complete_frame` (which hands back the pinned form `@e5~s42`), `ref_not_issued`.
- Every daemon command declares a `RefFrameEffect` of `preserve`, `may-invalidate` or `delegated`.
- On retention: *"The tree that minted the frame's refs, retained so a ref resolves to the node the caller was authorized against rather than to whatever now sits at that index in a newer observation."*

agent-device and mobilecli mint syntactically identical `@e5` refs from the same depth-first accessibility walk and reach opposite conclusions about what happens when the tree moves.

### 9.4 Five element-reference designs, and what browxai's most resembles

| Tool | Ref | What happens at action time | Failure mode |
|---|---|---|---|
| W3C WebDriver / Appium | opaque `element-6066-…` | server holds the node in a weak map; Appium additionally re-runs the locator and compares the accessibility UUID | typed error, two of them |
| Playwright MCP | `[ref=eN]` | `aria-ref` engine looks the string up in `_lastAriaSnapshotForQuery.info`, a `Map<Element,string>` held page-side, and returns the element only if `isConnected` | zero matches, then a loud error naming the recovery |
| Callstack agent-device | `@e5` or pinned `@e5~s42` | resolved against the retained minting tree, admitted only if the frame is active and its epoch and scope authorise the ref | typed refusal with a hint |
| **browxai** | `[ref=eN]`, a sha256 of role + name + path + testId + frameId | `RefLocatorInputs` rebuilds a `Locator` from role/name/testId/cssPath/frameId and runs it | above one match, re-resolve to the discovery-time CSS path, else act on `.first()` with a warning |
| mobile-mcp / mobilecli | `@e5` | re-dump the tree, take the fifth node in depth-first order | reports success on the wrong element |

**browxai's ref is a deferred query, not a handle.** It is closest in mechanism to Maestro's `refreshElement` (re-run identity matching against a fresh tree) and closest in surface syntax to Playwright MCP's. It is not like WebDriver's opaque handle and not like BiDi's `sharedId`, both of which are server-held identities. RFC 0009's `ElementToken` moves browxai *toward* the handle model and offers a `Locator`-caching fallback that lands it between agent-device and mobilecli. That is the wrong direction for the same reason RFC 0008 §3 gives.

The gap browxai has that Maestro and Appium closed: **identity verification on re-resolution.** Appium compares the accessibility UUID; Maestro requires exactly one attribute match. browxai re-runs the recipe and, on ambiguity, picks. The recipe is already stored. The check is a comparison, not a new port.

### 9.5 What is actually winning in agent-facing tooling

A short numeric token the model can say back, backed by a server-side resolution step that can refuse. All five tools converged on that surface syntax because `@e5` costs three tokens where an XPath costs sixty. They diverged entirely on what sits behind it.

The clearest evidence that the coordinate answer is the cheap one, and that its authors know it: `appium-mcp`'s AI mode returns *"a special elementUUID format containing coordinates"*, literally `ai-element:x,y:bbox`, a coordinate pair wearing the costume of an element handle. Appium gated it behind `AI_VISION_ENABLED`, off by default, because the gate *"prevents the model from defaulting to a slow, paid vision call when a stable locator (accessibility id, resource-id, etc.) would do the job"* [HIGH].

---

## 10. LSP, DAP and MCP

### 10.1 The shapes, measured

| | LSP 3.17 | DAP | MCP 2026-07-28 | browxai |
|---|---|---|---|---|
| Server/engine capability fields | 36 top-level, 34 of them `*Provider` structs | 42 properties, 37 booleans | per-module structs with sub-flags | 10-name flat set + 1 boolean |
| Client capability fields | 6 top-level, hundreds of nested leaves | 17 fields, 10 client booleans | declared on every request | n/a |
| Granularity | per-feature struct with options and a `documentSelector` | per-method boolean | per-module struct | per-sub-interface boolean |
| Changes after handshake | yes, `client/registerCapability`, opt-in per feature | yes, `capabilities` event | no handshake exists | no |
| Calling something undeclared | undefined | undefined | `MissingRequiredClientCapability` `-32021` | undefined |

Counts verified from `metaModel.json` (LSP 3.17) and `debugAdapterProtocol.json` [HIGH].

**browxai's shape is DAP's.** A flat set of booleans, one per capability area. DAP is the protocol that went furthest with that design.

### 10.2 DAP's own spec calls its declarations hints

The `capabilities` event exists because initial declaration is not enough. weinand (DAP's author), opening the request, 2018-02-22 [HIGH]:

> "Sometimes it is difficult for a DA to know and return all capabilities from the Initialise request because some might not be known until the runtime/debugger has been started."

> "Since the capabilities are dependent on the frontend and its UI, it might not be possible to change that at random times (or too late). Consequently the 'capabilities' event has a 'hint' characteristic: a frontend can only be expected to make a 'best effort' in honouring individual capabilities but there are no guarantees."

That wording survives verbatim into the current schema's `CapabilitiesEvent` description [HIGH, verified by parsing the schema].

DAP chose per-feature flags **instead of** version numbers, deliberately (`overview.md`) [HIGH]:

> "the protocol is still at its first version because it was an explicit design goal to support new feature in a completely backward compatible way. Making this possible without version numbers requires that every new feature gets a corresponding flag ... The absence of the flag always means that the feature is not supported."

The changelog is at 1.71.x while the overview says "still at its first version." 71 minor revisions of flag accumulation is the price, and the bag has grown past internal consistency: [debug-adapter-protocol#611](https://github.com/microsoft/debug-adapter-protocol/issues/611) (2026-04-22, open, zero comments) documents two spec sections giving contradictory instructions for an adapter that reports no capabilities [HIGH].

**How a DAP adapter refuses.** There is no error code space. `Response.success: false` plus a `Message` with an implementation-defined numeric `id` and a human-readable `format` string. The two predefined `message` values are `"cancelled"` and `"notStopped"`; neither means unsupported [HIGH]. A client cannot programmatically tell "I don't support this" from "the debuggee blew up."

I searched the DAP tracker for flat-bag complaints, capability-explosion complaints and maintainer regret. There is essentially none [HIGH on the absence]. The community accepted the design.

### 10.3 LSP's maintainer prescribes declare-then-return-null

**38 of 56 LSP request results legally admit `null`** [HIGH, counted across `language/*.md` and `workspace/*.md`]. `hoverProvider: true` followed by `null` is spec-legal on every request.

[language-server-protocol#1205](https://github.com/microsoft/language-server-protocol/issues/1205), 2021-02-18. sumneko wants completion off when a user setting says off, and cannot read settings before `initialize` returns. dbaeumer [HIGH]:

> "Two options: on the client side you can restart the server if that setting changes. or you return an empty array or undefined from the request. Closing."

sumneko reopened with two GIFs showing declared-then-empty and never-declared produce visibly different VS Code UI. dbaeumer, 2021-03-01 [HIGH]:

> "I am actually out of ideas. The best would be to convince clients to implement dynamic registration. It got invented exactly for that purpose."

The sanctioned answer to "I support this only sometimes" is dynamic registration with a `documentSelector`, which most clients do not implement, and the fallback is declare-then-null.

**Servers violate declarations and there is no enforcement.** [vscode-languageserver-node#713](https://github.com/microsoft/vscode-languageserver-node/issues/713), 2020-12-21: Pyright sends `client/registerCapability` to neovim, which declared `dynamicRegistration: false` everywhere; on Node 15 the unhandled rejection killed the process. dbaeumer [HIGH]: *"there is little I can do in the VS Code LSP libraries to avoid this. I recommend that you open an issue against the corresponding LSP server that should respect that setting."* The bug traced back to Microsoft's own reference server library.

**And there is no normative rule for "declared then errored."** `MethodNotFound` (-32601) exists, and its only normative use in the entire spec is for the `$/` namespace. Client behaviour on a hard error from a declared provider is undefined [HIGH, after a full-tree grep].

### 10.4 MCP deleted the handshake and kept declaration

The most interesting data point in the set, and it is three months old. [SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575), merged 2026-05-11, shipping in protocol revision 2026-07-28 [HIGH]:

> "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake. Every request now carries its protocol version and client capabilities in `_meta`."

And the sentence LSP and DAP never wrote [HIGH]:

> "A server MUST NOT rely on capabilities the client has not declared. If processing a request requires a capability the client did not include in `io.modelcontextprotocol/clientCapabilities`, the server MUST return a `MissingRequiredClientCapabilityError` (`-32021`) whose `data.requiredCapabilities` lists the missing capabilities."

Probing is now normatively sanctioned for *discovery*: a client *"is free to invoke any RPC inline and handle `UnsupportedProtocolVersionError`"*, and the stdio fallback guidance is literally *"probe with `server/discover` and fall back on any error that is not a recognized modern error"* [HIGH].

The architecture: **declaration is mandatory and enforced by a typed error; discovery is optional and answered by probing.**

Caveat on motive, and it matters: SEP-2575's stated reasons are load balancing, resilience and implementation complexity, not capability design. Capability negotiation got redesigned because it was bundled into the handshake they wanted gone [HIGH on the quotes, MED on the reading of intent].

**The declaration channel is only as good as the SDK.** [PR #3364](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3364), 2026-09-15, audits `capabilities.extensions` across ten official SDKs [HIGH]: Java has no native support, Swift has no native support, and Python *"server response serialization drops the map."* Three of ten first-party SDKs cannot carry an extension declaration.

### 10.5 The request everyone makes and nobody ships

LSP [#642](https://github.com/microsoft/language-server-protocol/issues/642) (2018, 43 comments) asked clients to declare which commands they implement so a server could ship a new code action safely. dbaeumer refused twice. DanTup's unanswered counter, still open eight years later [HIGH]:

> "But then how do I add a new code action that requires a command from the client extension that wasn't in the first shipping version? Isn't the purpose of client capabilities to communicate this sort of thing?"

MCP [SEP-979](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/979) (2025-07-16) asked the same thing: let clients tell servers which server features they can render. kentcdodds' use case [HIGH]: *"I cannot return embedded resources from my MCP server because some of my users may be using Cursor, which doesn't support embedded resources."* Closed 2026-01-26 for want of a core-maintainer sponsor.

Same request, same outcome, eight years apart.

### 10.6 Everybody ends up with a spreadsheet

BiDi has no capability declaration and ended up feeding MDN BCD from a Google Sheet (§5.2). MCP has capability declaration and is being asked for a caniuse table ([SEP-1814](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1814), 2025-11-14, open) [HIGH]. Puppeteer has 59 typed throws and a hand-maintained markdown file that contradicts itself (§8.3). Appium had a spreadsheet-equivalent for 18 months after GA (§6.1).

Declaration alone did not prevent the compatibility-matrix problem for anyone.

---

## 11. BiDi's modules against browxai's substrates

Both land on ten units. The lines are drawn differently in six places.

| BiDi module | Size | browxai substrate | Verdict |
|---|---|---|---|
| `session` (new, end, status, subscribe, unsubscribe) | 5 cmds | none | browxai has no in-band session port; `EngineEntry` and `open_session` do this out of band. Fine, and it means `EventSubstrate` has no standard counterpart to copy from (see `log`). |
| `browser` (user contexts, client windows, download behaviour) | 7 cmds | none; `EngineEntry.postWire` + the session registry | browxai has no browser-level port. RFC 0005's target pool is the nearest thing and it stays behind `playwright?()`. |
| `browsingContext` (navigate, create, close, activate, getTree, locateNodes, captureScreenshot, print, setViewport, startScreencast, traverseHistory, reload, handleUserPrompt, setBypassCSP) | 15 cmds, 14 events | **split five ways**: proposed `TargetSubstrate`, `ActionSubstrate` (navigation), `CaptureSubstrate`, `EmulationSubstrate` (viewport), proposed `ElementSubstrate` (locateNodes) | **The biggest divergence in the table.** The standard keeps one module; browxai cuts it into five ports. Each cut is defensible on its own. Together they have no standards precedent, and `TargetSubstrate` at four members is a small subset of a module the spec kept whole. |
| `script` (evaluate, callFunction, addPreloadScript, removePreloadScript, disown, getRealms) | 6 cmds, 3 events | `ScriptSubstrate` | Closest one-to-one match. browxai has no realm model and no `disown`. §5.4 on why that matters for element identity. |
| `network` (13 commands including the data-collector family) | 13 cmds, 5 events | `NetworkSubstrate` + proposed `route`/`unroute` | One-to-one in intent. BiDi's data collectors are a lifetime model browxai does not have. |
| `storage` (getCookies, setCookie, deleteCookies) | 3 cmds | `StorageSubstrate`, **22 members** | browxai is seven times wider. BiDi scoped storage to cookies and left localStorage, IndexedDB and the Cache API out of the protocol. RFC 0009 notes `StorageSubstrate` is fat and declines to fix it; the standard's answer is that most of it is not protocol surface at all. |
| `log` (entryAdded) | 0 cmds, 1 event | proposed `EventSubstrate`, `console` kind | BiDi makes log a module with an event and no commands, and subscription lives in `session`. browxai folds log, error, navigation, dialog and close into one generic `subscribe`. |
| `input` (performActions, releaseActions, setFiles) | **3 cmds**, 1 event | `ActionSubstrate`, **12 members going to 15** | **The sharpest divergence.** One generic action-sequence command against fifteen named verbs. §0.3 item E. |
| `emulation` (13 commands: geolocation, locale, timezone, UA, viewport meta, screen, orientation, touch, media features, network conditions, scripting enabled, scrollbar, forced colors) | 13 cmds | `EmulationSubstrate` + proposed `setMedia` | One-to-one in intent; BiDi is fatter and nobody is complaining about its member count. |
| `webExtension` (install, uninstall) | 2 cmds | none; `src/tools/extensions-*` reaches `context()` | RFC 0009 sends the 16-call rebuild path to `postWire` and flags it as close to speculative generality. The standard disagrees: extensions are a module. |
| (none) | (none) | `CaptureSubstrate` | BiDi has **no capture module**. Screenshot, print and screencast live on `browsingContext`. |
| (none) | (none) | proposed `TargetSubstrate` | No BiDi counterpart. The closest is `browsingContext`, at 15 commands. |
| (none) | (none) | proposed `EventSubstrate` | No BiDi counterpart. `session.subscribe` with per-module event names is the standard's shape. |

**What the comparison says.**

1. **BiDi carves by protocol domain. browxai carves by tool family.** Neither is wrong; they answer different questions. BiDi's question is "which part of the browser does this touch." browxai's is "which set of tools shares an implementation." The second produces `CaptureSubstrate`, which the standard did not need.

2. **Where BiDi is coarser, browxai's split costs nothing.** Capture and event are extra ports over one standard module, and they each have a second implementation already (Safari refuses capture partially, Safari bridges console over BiDi). That is the proven-seam test passing.

3. **Where BiDi is coarser and browxai's split costs something: `input`.** `ActionSubstrate` at fifteen members is the only port in the set with an open member-budget question, and it is the one place the standard chose one generic command. RFC 0009's P3 should evaluate a `perform(sequence)` method before it writes `swipe`, `pinch` and `touch` as three more verbs.

4. **Where browxai is coarser than BiDi and should stay that way: `session` and `browser`.** Neither maps onto a capability port. Session lifecycle is not a per-engine capability, it is what the engine registry already owns.

5. **`storage` is the one place browxai is wider than the standard by an order of magnitude**, and RFC 0009 correctly declines to fix it in this RFC. Worth recording that the standard's scoping (cookies only) is available as a target shape if the split ever happens.

6. **The `browsingContext` five-way cut is the decision to defend.** If it needs defending in review, the argument is that `TargetSubstrate`'s four members are the only ones a native engine can answer, and that `captureScreenshot` on a native engine is a screen grab with no browsing context behind it. That argument is good. It should be in the RFC, because the standard's carve is the obvious counter-proposal.

---

## 12. The five questions, answered

### 12.1 Is capability declaration better or worse than probe-and-catch?

**Declaration wins on data shape. Probing wins on method availability. browxai's current split has them backwards.**

The evidence for declaration-on-shape is dbaeumer's framing, [#1144](https://github.com/microsoft/language-server-protocol/issues/1144), 2020-11-19 [HIGH]: *"You can interpret the capabilities as a schema of the data that flows."* If you are about to put a field on the wire the peer will try to parse, you must know before you send it, because no error handling recovers a peer that already choked. MCP kept exactly that and hardened it with `-32021`.

The evidence against declaration-on-availability is four-fold and consistent: DAP's own spec calls its capabilities hints with *"no guarantees"*; LSP's maintainer prescribes declare-then-return-null and 38 of 56 request results permit it; WebDriver's one optional-support boolean is matched by Firefox, return-only in Chrome and Safari, and rejected as `invalid argument` by ChromeDriver; BiDi's working group declined to build feature detection and shipped a spreadsheet instead.

**The synthesis, which is MCP's 2026-07-28 architecture:** declaration is mandatory and enforced by a typed error; discovery is optional and answered by probing.

**What that means for browxai.** `subInterfaces` is a declaration with no enforcer and no reader (§1.1), which is the worst of both. Either give it a reader and an error, or delete it and let `caps.deep` plus the substrate refusals carry the whole load. RFC 0009 chooses the first, correctly, and must land the reader in P1.

**And the two can disagree, which the RFC treats as hypothetical.** It is not. Safari declares no `network` sub-interface and `network_read` runs anyway, returning zero requests (§1.2). The disagreement is live, in production, today.

### 12.2 How should a port handle a method the backend cannot support?

Four designs are in evidence. Ranked by what the sources show.

**Best: omit the method from the type, and reach the backend-specific power through a named handle.** Playwright's `CRCoverage` is a separate class on no shared interface [HIGH]. This is what `playwright?(): PlaywrightSessionHandle` does and it is the right call.

**Good: a structured refusal envelope, when the tool exists on every engine but cannot run on this one.** browxai's `EngineRefusal { error, hint }` with a per-tool reason map is better than anything in the survey, because it names the engine, the reason and the alternative. Selenium, BiDi and DAP all refuse with a code and a free-text string. Keep this and extend its coverage past the 25 tools it currently gates.

**Poor: present on the type and throwing.** Puppeteer, 59 sites, invisible to TypeScript, documented in a file that contradicts its own source (§8). Also `page(): Page` today.

**Worst: present, not throwing, and returning a plausible empty answer.** `network_read` on Safari (§1.2). Nobody in the survey does this deliberately. It is the failure mode a QA-evidence product can least afford, because the agent has no way to tell it apart from a true negative.

One correctness note the sources are unanimous on: **the refusal must be reachable.** browxai's refusal envelope rests on rejection, and 69 adapter methods can throw synchronously past it (§3). Fix the envelope's foundation before extending its coverage.

### 12.3 Does anyone abstract "evaluate arbitrary script" across a backend with no script engine?

**No, and the honest answer has two halves.**

**Half one: nobody does it, and the projects that tried say so.** BiDi's `script` module has no non-browser implementation. Appium's `execute` in native context is `mobile:` extension commands dispatched through `executeMethodMap`, which is a named-command registry and not script evaluation; plain JavaScript goes to chromedriver, which means it goes to a browser [HIGH]. Maestro has `evalScript` that runs in Maestro's own JS interpreter against the test's variables, never inside the app. Playwright's `ScriptSubstrate` equivalent has no delegate that can refuse it, because every Playwright backend has a JS engine.

**Half two: the specific backend RFC 0008 targets is not script-less.** React Native runs Hermes, Hermes implements the CDP `Runtime` domain, and `metro-mcp` reaches `Runtime.evaluate` through Metro's inspector proxy with no app code changes, RN 0.70+ [HIGH] (§0.3 item C).

So the correct statement for the RFC is: **`ScriptSubstrate` refuses on a release-configuration native build, and a development build over Metro is a real second implementation that nobody has costed.** That is a narrower claim than "no native equivalent" and it changes what the refusal means. A refusal that says "not available in this build configuration" is different from one that says "not possible on this platform", and the agent can act on the first.

Whether browxai should build it is a separate question and the answer is probably not now. Note the trust posture: a Metro inspector connection is an arbitrary-code channel into a dev build, which is the `eval_js` capability's threat model with a new transport.

### 12.4 The live-handle problem

Answered at length in §9.4. The short form:

**WebDriver and BiDi model an element as a server-minted opaque string over a weak map**, with two distinct error names for the two ways it can fail, and BiDi splits it further into node references (no ownership) and handles (ownership, explicit `disown`).

**Appium adds the thing the spec does not require: identity verification on re-resolution.** Re-run the locator, compare the accessibility UUID, throw when they differ, and refuse outright for any element that came from a multi-match query.

**browxai's `[ref=eN]` most resembles none of those.** It is a content-addressed re-resolution recipe, closest in mechanism to Maestro's `refreshElement` and closest in surface to Playwright MCP's aria-ref. It is a deferred query. Nothing is held.

**Which is a strength RFC 0009 is about to spend.** A deferred query has no lifetime, no disown, no staleness, and no cross-realm problem. The three things it lacks are an identity check on re-resolution, a name for the ambiguous case, and a generation on the snapshot that minted it. All three are cheap. `ElementToken` as specified buys none of them and adds a handle lifetime the current design does not have.

**Concrete alternative worth costing in P2:** keep the ref as the port's element vocabulary, give `ElementSubstrate.resolve` the `RefRegistry` it already takes, and let it return a **result** carrying the resolved bounds plus a match count and a matched-by field, never a token the caller holds across calls. That keeps every substrate stateless, keeps `find`'s disambiguation on the substrate side where the round trips can be batched, and makes the "never a guess" rule enforceable at one place. The `probe(el, want)` batching argument survives intact; batch on the ref, not on a token.

### 12.5 What does this refactor cost?

Four measured datapoints, all [HIGH] unless noted.

| Project | Span | What it bought |
|---|---|---|
| Selenium 3 → 4 | 1,064 days to GA, 4,403 commits; JWP deleted 539 days after GA; residue to 2026 | Two post-GA bug reports mentioning old clients in five months of searching [MED on the reading] |
| Appium 1 → 2 | 2020-06-29 beta.0 → 2023-07-05 GA. 3 years, 71 prereleases | A driver ecosystem; introspection took 18 more months |
| Puppeteer CDP → BiDi (Firefox) | 2022-05-17 first work → 2024-08-07 GA (27 months) → 2024-12-19 removal (32 months) | A standards-based backend and a permanent 59-site refusal tax that is still growing |
| Playwright BiDi adoption | [#32577](https://github.com/microsoft/playwright/issues/32577) opened 2024-09-12, still open. Pass rate 2368/3877 at filing, 3246/3852 on CI 2025-09-15 | Not yet shipped as default, two years in |

**Three readings that bear on RFC 0009's five phases.**

**The de-vendoring is the cheap part.** Selenium's dialect removal was months of work in 2019; the three years went to a Grid rewrite, four HTTP client swaps, CDP, GraphQL and OpenTelemetry. RFC 0009's P1 through P5 are dialect-removal-shaped: mechanical, enumerable by the compiler, with the sizing device already designed. The phase estimates are plausible.

**The compatibility tail is where the money goes and it buys the least.** Selenium carried both dialects for 4.24 years after the first binding cut it, spent 539 days past GA finishing the deletion, and got approximately nothing for it. RFC 0009's `page?()` is the analogous device and it is scoped to one phase. Defend that scope in review.

**The refusal surface does not close.** Puppeteer's unsupported list grew for two years after GA because every new Chromium feature arrives with a matching BiDi throw. RFC 0009's P5 promotes every enforcer to `error` on the assumption the gap closes. The enforcers are about `Page` reaching `src/tools`, which is a closed set, so the assumption holds for them. It does not hold for the refusal surface: `TargetSubstrate` and `ElementSubstrate` will each accumulate native refusals as tools grow. Budget for that separately.

**The one number nobody publishes** is a per-call-site cost for a mechanical de-vendoring refactor. I looked for it in all six projects and in general TypeScript-architecture writeups and found nothing [HIGH on the absence]. RFC 0009's own P1 measurement, the compile-error set from the optional `page?()`, will be the best number anyone has. Record it.

---

## Appendix: primary sources

| Topic | URL | Date |
|---|---|---|
| W3C WebDriver (classic) | https://www.w3.org/TR/webdriver2/ | current, REC 2018-06-05 |
| WebDriver capability-matching PR | https://github.com/w3c/webdriver/pull/327 | landed 2016-10-21 |
| `supportedCommands` declined | https://github.com/w3c/webdriver/issues/765 | 2017-02-15 |
| `setWindowRect` interop divergence | https://github.com/w3c/webdriver/issues/1793 | open 2024-02-14 |
| Element-reference opacity | https://github.com/w3c/webdriver/pull/682 | 2017-01-27 |
| Stale-element design debate | https://github.com/w3c/webdriver/issues/1594 | 2021-05-27 |
| Node cache (the BiDi-driven refactor) | https://github.com/w3c/webdriver/pull/1705 | merged 2022-12-16 |
| Selenium Augmenter source | https://github.com/SeleniumHQ/selenium/blob/trunk/java/src/org/openqa/selenium/remote/Augmenter.java | current |
| Vendor interfaces created | https://github.com/SeleniumHQ/selenium/commit/12a14a204a14ce2a100f5106e8bfb797cadf4660 | 2021-09-28 |
| `HasDevTools` cast failure | https://github.com/SeleniumHQ/selenium/issues/9803 | 2021-09-08 |
| Augmenter ClassCastException | https://github.com/SeleniumHQ/selenium/issues/11892 | 2023-04-13 → 2024-01-18 |
| Grid protocol converter insufficient | https://github.com/SeleniumHQ/selenium/issues/10374 | 2022-02-18 |
| Removing legacy protocol support | https://www.selenium.dev/blog/2022/legacy-protocol-support/ | 2022-05-20 |
| Grid 4 session-creation regression | https://github.com/SeleniumHQ/selenium/issues/10242 | 2022-01-11 |
| Parallel-execution regression | https://github.com/SeleniumHQ/selenium/issues/9359 | open 724 days |
| W3C Actions 250 ms move cost | https://github.com/SeleniumHQ/selenium/issues/7281 | 2019-06-11 → 2021-12-26 |
| Stewart steps down | https://www.selenium.dev/blog/2021/stepping-down-stepping-up/ | 2021-10-27 |
| WebDriver BiDi spec | https://www.w3.org/TR/webdriver-bidi/ | Working Draft |
| BiDi feature detection declined | https://github.com/w3c/webdriver-bidi/issues/826 | open 2024-12-04 |
| BiDi unimplemented-command error undefined | https://github.com/w3c/webdriver-bidi/issues/801 | open 2024-10-24 |
| BiDi compat-table thread | https://github.com/w3c/webdriver-bidi/issues/619 | closed 2025-09-03 |
| Appium 501 / driver-authoring contract | https://appium.io/docs/en/latest/developing/build-drivers/ | current |
| Appium introspection endpoints | https://github.com/appium/appium/issues/20881 | 2025-01-05 → 2025-01-26 |
| Appium context guide | https://appium.io/docs/en/latest/guides/context/ | current |
| Coordinate mismatch, closed unanswered | https://github.com/appium/appium/issues/21423 | 2025-07-15 → 2025-08-25 |
| nativeWebTap, seven years open | https://github.com/appium/appium/issues/9979 | 2018-01-13 → 2025-03-13 |
| Proxy avoid-list hides webviews | https://github.com/appium/appium/issues/3105 | 2014-07-09 |
| Documented proxy opt-out did not exist | https://github.com/appium/appium/issues/20683 | 2024-10-21 |
| Appium 1→2 migration guide | https://appium.io/docs/en/2.0/guides/migrating-1-to-2/ | current |
| `ElementsCache.restore()` | https://github.com/appium/appium-uiautomator2-server/blob/master/app/src/main/java/io/appium/uiautomator2/model/ElementsCache.java | current |
| Playwright: no custom BrowserType | https://github.com/microsoft/playwright/issues/10838 | 2021-12-09 |
| Playwright: protocol is an implementation detail | https://github.com/microsoft/playwright/issues/30237 | 2024-04-04 |
| Playwright: declining a public protocol option | https://github.com/microsoft/playwright/issues/37277 | 2025-09-16 |
| Playwright BiDi blockers | https://github.com/microsoft/playwright/issues/32577 | open 2024-09-12 |
| Playwright DEPS checker (type-blind) | https://github.com/microsoft/playwright/blob/main/utils/check_deps.js | current |
| Playwright `server/DEPS.list` | https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/DEPS.list | current |
| Playwright aria-ref engine | https://github.com/microsoft/playwright/blob/main/packages/injected/src/injectedScript.ts | current |
| Puppeteer `api/Page.ts` (the re-absorbed port) | https://github.com/puppeteer/puppeteer/blob/main/packages/puppeteer-core/src/api/Page.ts | current |
| Puppeteer BiDi support list | https://pptr.dev/webdriver-bidi | current |
| Puppeteer: mark unsupported in the docs | https://github.com/puppeteer/puppeteer/issues/13668 | open 2025-03-11 |
| Puppeteer: `UnsupportedOperation` added | https://github.com/puppeteer/puppeteer/pull/11322 | 2023-11-08 |
| Puppeteer removes Firefox-over-CDP | https://github.com/puppeteer/puppeteer/pull/13427 | merged 2024-12-19 |
| Firefox in Puppeteer (Mozilla) | https://hacks.mozilla.org/2024/08/puppeteer-support-for-firefox/ | 2024-08-07 |
| mobile-mcp | https://github.com/mobile-next/mobile-mcp | ref added 2026-09-08 |
| mobilecli (the positional-ref source) | https://github.com/mobile-next/mobilecli | current |
| mobile-mcp wrong-tap report | https://github.com/mobile-next/mobile-mcp/issues/190 | open 2025-09-11 |
| Maestro tap/refresh source | https://github.com/mobile-dev-inc/maestro | `378af0c`, 2026-09-15 |
| Maestro selectors | https://docs.maestro.dev/reference/selectors/core-selectors.md | current |
| agent-device ADR 0014 | https://github.com/callstack/agent-device/blob/main/docs/adr/0014-session-ref-frame-lifetime.md | v0.21.4, 2026-09-15 |
| appium-mcp AI element design | https://github.com/appium/appium-mcp/blob/main/docs/AI_ELEMENT_FINDING_DESIGN.md | current |
| Hermes CDP Runtime support | https://cdpstatus.reactnative.dev/devtools-protocol/hermes/Runtime | current |
| metro-mcp | https://github.com/steve228uk/metro-mcp | current |
| LSP 3.17 specification | https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/ | current |
| LSP declare-then-null prescription | https://github.com/microsoft/language-server-protocol/issues/1205 | 2021-02-18 |
| LSP static registration not expressive enough | https://github.com/microsoft/language-server-protocol/issues/751 | 2019-05-16 |
| LSP client command declaration refused | https://github.com/microsoft/language-server-protocol/issues/642 | 2018, open |
| Server violates `dynamicRegistration: false` | https://github.com/microsoft/vscode-languageserver-node/issues/713 | 2020-12-21 |
| DAP specification + schema | https://github.com/microsoft/debug-adapter-protocol/blob/main/debugAdapterProtocol.json | current |
| DAP `capabilities` event rationale | https://github.com/microsoft/vscode-debugadapter-node/issues/160 | 2018-02-22 |
| DAP internal capability contradiction | https://github.com/microsoft/debug-adapter-protocol/issues/611 | open 2026-04-22 |
| MCP stateless (SEP-2575) | https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575 | merged 2026-05-11 |
| MCP client-advertisement SEP, closed | https://github.com/modelcontextprotocol/modelcontextprotocol/issues/979 | 2025-07-16 → 2026-01-26 |
| MCP SDK extension-capability audit | https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3364 | 2026-09-15 |
| `@typescript-eslint/promise-function-async` | https://typescript-eslint.io/rules/promise-function-async/ | current |
| dependency-cruiser rules reference | https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md | current |
| dependency-cruiser `tsPreCompilationDeps` | https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md#tsprecompilationdeps | current |
| dependency-cruiser baseline rot | https://github.com/sverweij/dependency-cruiser/issues/1080 | 2026-09-04 |
| Playwright DEPS.list stale-entry cleanup | https://github.com/microsoft/playwright/pull/40157 | merged 2026-04-10 |
| Playwright protocol spec relocation | https://github.com/microsoft/playwright/pull/41612 | merged 2026-07-03 |
| Puppeteer: `api/HTTPRequest.ts` created with `devtools-protocol` | https://github.com/puppeteer/puppeteer/pull/9840 | 2023-03-15 |
| Puppeteer drops `chromium-bidi` types from `common/` | https://github.com/puppeteer/puppeteer/pull/14179 | merged 2025-09-09 |
| `import/no-cycle` skips type imports | https://github.com/import-js/eslint-plugin-import/blob/main/src/rules/no-cycle.js | current |
| Appium TS project references (origin) | https://github.com/appium/appium/pull/16594 | 2022-03-25 |
| Appium declares express/ws in `@appium/types` | https://github.com/appium/appium/pull/22720 | merged 2026-09-04 |
| BiDi: why CDDL | https://github.com/w3c/webdriver-bidi/issues/21 | 2020-07-22 |
| WebDriver classic: machine-readable endpoints, still open | https://github.com/w3c/webdriver/issues/1510 | opened 2020 |
| Nx maintainer sanctioning inline disables | https://github.com/nrwl/nx/issues/16877 | 2023-05-09 |
| n8n module-boundary ratchet | https://github.com/n8n-io/n8n/pull/35914 | 2026-08-10 |
| W3C TAG promise-using specifications | https://www.w3.org/2001/tag/doc/promises-guide | current |
| TypeScript `throws` clause, declined | https://github.com/microsoft/TypeScript/issues/13219 | 2016-12-29 → 2023-04-19 |
| `assert.rejects` passes on a sync throw | https://github.com/nodejs/node/issues/19646 | 2018-03-28 |
| neverthrow: envelope bypassed by sync throw | https://github.com/supermacro/neverthrow/issues/488 | 2023-07-24 |
| `Promise.try` (TC39 stage 4, ES2025) | https://github.com/tc39/proposal-promise-try | Baseline 2025-01 |
