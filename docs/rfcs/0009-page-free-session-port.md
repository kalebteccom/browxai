# RFC 0009: A Page-free session port

**Date:** 2026-09-16
**Status:** Draft. Design only, nothing built.
**Trigger:** Owner directive, 2026-09-16, on the native-engine port: "restructure how we work so we don't rely on a `Page`, but rather a better interface that doesn't care about the concrete implementation and is extensible."

## What this is for

The interface the directive asks for is already here. [RFC 0003](0003-capability-ports-decoupling.md) built seven capability substrates and landed them; [RFC 0004](0004-architecture-hardening.md) put an enforcer behind each seam. `CaptureSubstrate` is `{ engine, screenshot(req) }` and names no Playwright type in its method signature. `ActionSubstrate` names twelve verbs and `ActionResult`. `SafariActionSubstrate` implements the whole port over WebDriver Classic with no Playwright import. The abstraction exists, it has two real implementations, and it works.

What has not happened is the removal of the road around it. `BrowserSession.page(): Page` is a mandatory member at [`src/session/types.ts:120`](../../src/session/types.ts), so any handler holding a session entry can take a Playwright `Page` and skip the port entirely. 115 call sites do. This RFC closes the bypass and finishes the lineage 0003 and 0004 started.

## The defect, measured

Counts are non-test source at `7f1298c`, verified 2026-09-16.

**The port promises a `Page` that one shipped engine cannot supply.** `page()` is mandatory on `BrowserSession`. Safari implements it by throwing `safari-no-playwright-page`. [RFC 0004](0004-architecture-hardening.md) named this the L5 violation (a present-but-unconditionally-throwing port method) and shipped `test/architecture/port-conformance.test.ts` to assert it never happens again. That test passes because it checks the _declaration_, `caps.subInterfaces.has("page")`, and the declaration is honest. The method is still there and still throws.

**The throw is load-bearing control flow in two places.** `src/replay/session.ts:329` calls `page()` inside a `try` and returns early from the `catch`, which is how a Safari session ends up with an action-only archive. `src/tools/read-observe-verify-tools.ts:94` calls `verifyVisible(e.session.page(), …)` inside a `try` whose `catch` renders the caught message as a _failed assertion_. On a Safari session `verify_visible` therefore reports `{ok: false, failure: {source: "browxai", actual: "safari-no-playwright-page"}}`. A tool that cannot run on an engine is emitting an assertion failure into the QA-evidence surface. It is not gated, because the engine gate (`src/engine/tool-gate.ts`) covers only tools declaring `deep: true`, and `verify_visible` declares `capability: "read"`.

**The bypass is 115 call sites and it is invisible to the type system.** There are 149 `.page()` calls in non-test source. 34 are inside Playwright substrate adapters, where a `Page` is the correct thing to hold. The other 115 are the defect: 112 in `src/tools`, spread across 35 of the ~40 tool-registration modules, plus one each in `src/replay/session.ts`, `src/page/snapshot-substrate-select.ts` and `src/page/network-substrate-select.ts`. `src/tools` imports the `Page` type **zero** times. Every one of those 112 sites obtains a `Page` by inference off `e.session.page()` and consumes it in the same expression. A guard written against the type import passes today and catches nothing.

**Six of the seven ports share a module with their Playwright adapter.** `snapshot-substrate.ts`, `script-substrate.ts`, `network-substrate.ts`, `capture-substrate.ts` and `emulation-substrate.ts` each declare the interface and the `Playwright*Substrate` class in one file, so each imports `Page` (and `Locator`, and `BrowserContext`) at the top. `ActionSubstrate` avoids the import by taking an `ActionContext`, which carries `page: Page` at `src/page/actionresult-types.ts:279`. Only storage follows the split that makes a port module vendor-free: `storage-substrate-types.ts` declares, `storage-substrate-playwright.ts` implements. No import-graph rule can state "a port names no vendor type" until the other six follow storage.

**The flagship enforcer routes around the defect.** `test/architecture/ocp-engine-contract.test.ts` is the L1 machine: a synthetic sixth engine registers through `registerEngine` with no core edit and drives `navigate` / `snapshot` / `find` / `click`. It passes because `InMemoryBrowserSession.page()` returns `fakePage()`, a three-method object cast `as unknown as Page`. The test's own comment says why it is there: "the snapshot/find path reads `url()` / `title()` … and probes `locator(…)`". A synthetic engine that honestly declared no Page would fail `snapshot` and `find` today. The open-closed claim holds for four tools, and it holds on a fake.

**Two engines will need this, not one.** [RFC 0008](0008-native-app-control.md) adds `ios-app` and `android-app`. Neither has a Playwright `Page`, a DOM, a URL, or a `Locator`. Adding a second engine that throws from `page()` turns an accident into a pattern, which is 0008's own wording and is correct.

### A correction to the framing

`session.engine === "safari"` at `src/page/snapshot-substrate-select.ts:44` is not an unsanctioned dodge. `ENGINE_SELECT_ALLOWLIST` in `eslint.config.js:124` names that file explicitly, and the select layer is the one place an engine literal is allowed. The problem with the line is narrower and worse: the literal stands in for "this engine has no Playwright Page", and that fact is **already declared** as `caps.subInterfaces.has("page")` ([`src/engine/types.ts:67`](../../src/engine/types.ts), RFC 0004 D5). Two spellings of one fact is the L2 violation, and the second spelling is the one that needs a new branch per engine.

## What already exists

| Need                                            | Where                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Seven capability ports, implementation-agnostic | `src/page/{action,snapshot,script,capture,emulation,network}-substrate.ts`, `storage-substrate-types.ts`    |
| A second implementation of five of them         | `src/page/*-safari.ts`, `src/page/substrate-bundle-safari.ts`                                               |
| Engine-owned substrate selection                | `EngineEntry.makeSubstrates` (`src/engine/registry.ts:117`)                                                 |
| Page-availability as declared data              | `EngineSubInterface` `"page"` (`src/engine/types.ts:67`)                                                    |
| Engine-owned post-creation wiring               | `EngineEntry.postWire` (`src/engine/registry.ts:124`)                                                       |
| An engine-specific session handle, precedent    | `BrowserSession.safari?()` (`src/session/types.ts:136`)                                                     |
| Segregated per-family host ports                | `ActionHost` / `CaptureHost` / `StorageHost` / `ScriptHost` / `EmulationHost` (`src/tools/host.ts:175-222`) |
| A ratcheted allowlist pattern with rationale    | `ENGINE_SELECT_ALLOWLIST`, the `no-inlined-capability-checks` override block                                |
| A port/adapter module split, one instance       | `storage-substrate-types.ts` + `storage-substrate-playwright.ts`                                            |

Nothing in the list needs replacing. The work is finishing it.

## The end condition

The `Page` type from `playwright-core`, and the `.page()` accessor, appear in exactly three kinds of module:

1. **Engine adapters** (`src/engine/adapters/**`), which launch and own the browser.
2. **Playwright substrate adapters**, the `Playwright*Substrate` classes and the page-side function modules they call. These are named `*-playwright.ts` after the split in §"The file split", or live under `src/page/` and are reached only from a substrate.
3. **One handle module**, `src/session/playwright-handle.ts`, which declares the type the adapters receive.

They appear in no port interface, no `src/tools/**` module, no `src/replay/**` module, and not on `BrowserSession`.

Two things follow that are worth stating as acceptance criteria, because they are testable and the prose is not.

- The `ocp-engine-contract` synthetic engine declares no `"page"` sub-interface, implements no `page()` method, and still drives every tool the phase in question has moved.
- `pnpm depcruise` fails on an import of `playwright-core` from any module matching the port-file pattern.

## `page()` is deleted from the port, and optional for exactly one phase

**Deleted.** It moves to `playwright?(): PlaywrightSessionHandle`, carrying `{ page: Page; context: BrowserContext }`, mirroring `safari?(): SafariSessionHandle` and 0008's proposed `native?(): NativeSessionHandle`. Every engine then reaches its own concrete world through an optional, engine-named handle, and no engine promises a handle it lacks.

The argument against the alternative, `page?(): Page` as a permanent optional capability probe, is L2. Page-availability is already declared once, at `caps.subInterfaces.has("page")`. A permanent `page?:` member makes the compiler a second oracle for the same fact, and the two can disagree: an engine could declare `"page"` and omit the method, or the reverse, and nothing would catch it. The `port-conformance` assertion that declaration equals reality exists precisely because that gap is real. One probe, and it is the declared one.

There is a second argument. `page?(): Page` reads as "some sessions have a Page", which invites `if (session.page)` guards at the 115 call sites. That is the `engine === "safari"` literal chain again with different syntax. `playwright?()` reads as "this is the Playwright escape hatch", which is what it is, and it is greppable, allowlistable and countable.

**Optional for one phase.** The migration needs the compiler to enumerate the call sites, and 0008 is right that the compile-error set is the real cost and is unmeasured. So P1 ships `page?(): Page` with a deprecation comment, purely as an enumeration device. The count it produces sizes P2 through P5. P5 removes the member. Nothing is designed around the optional form, and no new code may call it.

## The clusters, mapped

Ranked `page.*` and `.page().*` method usage across non-test `src`, with the verdict for each. "Bypass" means an existing port already covers the operation and the call skips it. "Widen" means the port exists and the operation belongs on it. "New port" means no port means this.

| Cluster                                                    |   n | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------- | --: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluate`                                                 | 113 | **Not a port problem.** Zero of these are in `src/tools`. They sit in `src/page/*` page-side function modules, `src/session/{storage,idb-storage,cache-storage}.ts` and `src/helper/bridge.ts`, all of which are Playwright adapter code below a substrate. The agent-facing evaluation path already has `ScriptSubstrate`. These stay, and they move into `*-playwright.ts` modules at the file split.                                                                                                                 |
| `context()`                                                |  47 | **Split.** Cookies and storage-state → `StorageSubstrate` (exists, widen). HAR, video and downloads → `CaptureSubstrate` (exists, widen). Dialog, permission, notification, fs-picker, stealth, device-emulation and extension-context rebuild → `EngineEntry.postWire`, which already owns exactly this wiring; the 16 calls in `src/tools/extensions-rebuild.ts` are the largest single file and belong in the Playwright adapter's rebuild path. `context().pages()` (multi-tab) stays behind the Playwright handle. |
| `url`                                                      |  30 | **New port: `TargetSubstrate`.** Safari implements it today (`webdriver-client.ts:132 currentUrl`). Native maps it to the deep-link scheme or the current screen id. Also the scope argument to `SecretRegistry.materialize`, which is 0008 §1.5.                                                                                                                                                                                                                                                                       |
| `on` / `off`                                               |  34 | **New port: `EventSubstrate`.** No port covers this at all. Seven event names in use: `framenavigated` (9), `console` (6), `pageerror` (5), `dialog` (3), `response` (2), `websocket` (1), `close` (1), plus six context-level names. Safari already bridges console over BiDi in `safari-post-wire.ts`, so the second implementation exists. Native maps console to logcat and the simulator syslog, which 0008 §2 commits to.                                                                                         |
| `mouse` / `keyboard`                                       |  25 | **Below the seam, no change.** All 25 are inside `src/page/{actions,gestures,actions-scroll,canvas-gesture,shortcut}.ts`, which are the `PlaywrightActionSubstrate` internals. Separately, 0008's move of `swipe` / `pinch` / `touch` onto `ActionSubstrate` and the retirement of `deep: true` on those five registrations is absorbed here as P3.                                                                                                                                                                     |
| `locator` / `getByRole` / `getByTestId` / `getByText`      |  39 | **New port: `ElementSubstrate`.** `locatorFor(page, refs, target)` (`src/page/locator.ts:131`) is the resolution chokepoint for `verify_*`, gesture geometry (`gestures.ts:18` `boundingBox`), element-scoped capture (`capture-substrate.ts:110`) and `find`'s disambiguation probes. Safari has WebDriver element ids; native has a hierarchy query keyed on testID. This is the hardest of the three new ports and §"Honest limits" says why.                                                                        |
| `pdf`                                                      |  16 | **Bypass. Widen `CaptureSubstrate`.** `pdf_save` reaches `e.session.page()` in `capture-report-export-tools.ts` while the capture port sits unused beside it. Firefox already refuses through the engine gate; the refusal moves into the adapter.                                                                                                                                                                                                                                                                      |
| `video`                                                    |  11 | **Bypass. Widen `CaptureSubstrate`.** Native needs the segmented writer 0008 §5 designs, which is a second implementation with genuinely different shape.                                                                                                                                                                                                                                                                                                                                                               |
| `screenshot`                                               |  11 | **Bypass.** `CaptureSubstrate.screenshot` already exists. `capture-report-marks-tools.ts` and `read-observe-capture-tools.ts` call `page.screenshot` directly around it.                                                                                                                                                                                                                                                                                                                                                |
| `mainFrame` / `isClosed`                                   |  11 | **New port: `TargetSubstrate`.** Structural identity. `isClosed` becomes `alive()`; native answers from the app lifecycle state 0008 §4 already logs. `mainFrame` becomes `rootFrameId()`, which `refs.elementKey` already consumes as a plain string.                                                                                                                                                                                                                                                                  |
| `emulateMedia` / `setViewportSize`                         |   8 | **Widen `EmulationSubstrate`** with `setMedia`. `setViewport` is already on `ActionSubstrate`; the three direct calls are bypass.                                                                                                                                                                                                                                                                                                                                                                                       |
| `route` / `unroute`                                        |   3 | **Widen `NetworkSubstrate`.** Safari and native both refuse through the existing no-op network substrate, so the refusal is already modelled.                                                                                                                                                                                                                                                                                                                                                                           |
| `goto` / `goBack` / `goForward` / `bringToFront` / `title` | ~10 | **Below the seam, no change.** Inside `actions.ts` and `export-playwright-script.ts`, which are `PlaywrightActionSubstrate` internals. `title()` joins `TargetSubstrate`.                                                                                                                                                                                                                                                                                                                                               |

Three new ports, four widenings. Every other cluster is either bypass of a port that already exists or adapter internals that are correct where they are.

## The new ports

Each is justified against a second implementation that exists today (Safari) or is committed (`ios-app` / `android-app`, RFC 0008). Each stays under the L4 member budget.

### `TargetSubstrate`

The structural identity of whatever the session is pointed at. Named for the target, because a native session has no page and no document.

```ts
export interface TargetSubstrate {
  readonly engine: string;
  /** Web: the document URL. Native: the deep-link scheme plus screen id,
   *  e.g. `app://com.acme.app/CheckoutScreen`. Feeds the secret-scope check. */
  url(): Promise<string>;
  /** Web: document title. Native: the current screen's accessibility label. */
  title(): Promise<string>;
  /** Web: `!page.isClosed()`. Native: the app process is running and frontmost. */
  alive(): Promise<boolean>;
  /** Opaque identity for the root context. Consumed only as a string, by
   *  `elementKey` (`src/page/refs.ts:25`) and the frame tools. */
  rootFrameId(): Promise<string>;
}
```

Four members. Safari's implementation is `webDriver.currentUrl` plus `getTitle` plus a session-liveness probe. The Playwright implementation wraps `page.url()`, `page.title()`, `!page.isClosed()` and `page.mainFrame()`, and is the verbatim body of the calls it replaces.

`url()` becoming async is the one behaviour-visible change in this RFC. `page.url()` is synchronous, and 30 call sites treat it that way. WebDriver's `currentUrl` is a round trip, which is why Safari's snapshot substrate already caches it. The cost is measured in P1 and the mitigation, if it is needed, is a per-action cached value refreshed on `framenavigated` through `EventSubstrate`.

### `EventSubstrate`

The subscription seam. No port covers it today, and `src/replay/session.ts` is the consumer that most needs one.

```ts
export type TargetEvent =
  | { kind: "console"; level: string; text: string }
  | { kind: "error"; message: string; stack?: string }
  | { kind: "navigated"; url: string; frameId: string }
  | { kind: "dialog"; dialogType: string; message: string }
  | { kind: "closed" };

export interface EventSubstrate {
  readonly engine: string;
  /** Returns the unsubscribe thunk. Bounded by the caller: the replay
   *  orchestrator already owns its own ring caps (L7). */
  subscribe(handler: (e: TargetEvent) => void): () => void;
}
```

Two members, one closed event union. The union is deliberately narrower than Playwright's event set: `response` and `websocket` belong to `NetworkSubstrate`, which already has the rings and the tap. Safari's BiDi console bridge becomes the Safari implementation with its existing body. Native maps logcat and the simulator syslog to `console`, and the `app/lifecycle` events 0008 §4 defines to `closed`.

Dialogs are in the union because `src/session/dialog.ts` subscribes to `page.on("dialog")` and the dialog policy is a documented session behaviour on every engine that has modal prompts.

### `ElementSubstrate`

Resolution and probing of one element, for the tools that need a handle rather than a snapshot node.

```ts
/** An opaque, substrate-minted token for one resolved element. The web
 *  implementation holds a `Locator`; Safari holds a WebDriver element id;
 *  native holds a testID plus the hierarchy path it matched. Never inspected
 *  above the port. */
export type ElementToken = { readonly __brand: "element"; readonly id: string };

export interface ElementSubstrate {
  readonly engine: string;
  /** Resolve a target to a token, or refuse structurally naming the ref and
   *  the match count. Zero or many matches is a refusal, never a guess. */
  resolve(target: ResolvedTarget, refs: RefRegistry): Promise<ElementToken | ElementRefusal>;
  /** Viewport-space bounds, for gesture geometry and element-scoped capture. */
  bounds(el: ElementToken): Promise<Rect | null>;
  /** The four `verify_*` reads plus visibility, one call, one round trip. */
  probe(el: ElementToken, want: ElementProbe): Promise<ElementProbeResult>;
  /** `verify_count` and `find`'s disambiguation. */
  count(target: ResolvedTarget, refs: RefRegistry): Promise<number>;
}
```

Four members. `probe` is one call taking a discriminated request so a fifth verb does not add a fifth member. The refusal shape is the same structured refusal the substrates already return, so a native engine reports "ref e7 matched 0 elements" and a web engine reports the same sentence.

0008 §3 requires that every native action re-resolve its ref to a live element before dispatch and never replay cached coordinates. `resolve` returning a fresh token per call is that contract, expressed once at the port.

## The widenings

| Port                 | Added                                        | Second implementation                                                                                                                                                           |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CaptureSubstrate`   | `pdf(req)`, `startVideo(req)`, `stopVideo()` | Safari refuses pdf and video. Native writes the segmented capture of 0008 §5.                                                                                                   |
| `ActionSubstrate`    | `swipe`, `pinch`, `touch`                    | 0008 §1, absorbed. The Playwright implementation keeps today's CDP path and returns `directDispatchUnsupported` without CDP; the five `deep: true` registrations lose the flag. |
| `EmulationSubstrate` | `setMedia(args)`                             | Safari declares no `emulation` sub-interface, so the gate refuses upstream.                                                                                                     |
| `NetworkSubstrate`   | `route(req)`, `unroute(req)`                 | `SafariNoopNetworkSubstrate` already models the refusal.                                                                                                                        |

`CaptureSubstrate` reaches four members, `ActionSubstrate` fifteen. Fifteen is past the twelve-member ceiling `interface-member-budget.test.ts` applies to the `ToolHost` sub-ports. `ActionSubstrate` is not in that test's `SUB_PORTS` list today. P3 either adds it and splits the port along the action/gesture line, or extends the ceiling with a written rationale. The decision belongs in P3 against the real shape, and §"Open questions" carries it.

`StorageSubstrate` is already at 22 members and this RFC does not fix it. Noting it so the next reader does not assume it was missed.

## The file split the enforcers need

Every rule in §"Enforcement" is expressible only if a port module and its Playwright adapter are different files. Storage already does this. The other six follow the same naming:

| Today                    | Becomes                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `action-substrate.ts`    | `action-substrate.ts` (port) + `action-substrate-playwright.ts`                                            |
| `capture-substrate.ts`   | `capture-substrate.ts` + `capture-substrate-playwright.ts`                                                 |
| `script-substrate.ts`    | `script-substrate.ts` + `script-substrate-playwright.ts`                                                   |
| `emulation-substrate.ts` | `emulation-substrate.ts` + `emulation-substrate-playwright.ts`                                             |
| `snapshot-substrate.ts`  | `snapshot-substrate.ts` + `snapshot-substrate-playwright.ts` (the CDP implementation keeps its own module) |
| `network-substrate.ts`   | `network-substrate.ts` + `network-substrate-playwright.ts`                                                 |

The Safari implementations already live in `*-safari.ts` modules, so the convention is half-applied and this completes it. The move is mechanical and byte-identical, which is the RFC 0003 discipline: the home moves, the body does not.

## Phasing

Each phase is independently shippable and leaves the gate green. Each ends by adding its tools to the `ocp-engine-contract` drive list and tightening the allowlist by the count it removed.

| Phase  | Scope                                                                                                                                                                                                                                                                                                                                                                     | Sites moved | Size   |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------: | ------ |
| **P1** | The file split (all six). `page?(): Page` with a deprecation comment, purely to enumerate. `TargetSubstrate` plus its Playwright and Safari implementations. `snapshot-substrate-select.ts` and `network-substrate-select.ts` key on `caps.subInterfaces.has("page")`, and the `"safari"` literal leaves both. Measure the `url()` async cost.                            |         ~44 | medium |
| **P2** | `ElementSubstrate`. `verify-element.ts`, `gestures.targetPoint`, `capture-substrate`'s target resolution and `find`'s disambiguation probes route through it. `verify_*` stops throwing on Safari and starts refusing structurally.                                                                                                                                       |         ~39 | large  |
| **P3** | The four widenings. `pdf` / `video` / `screenshot` move onto `CaptureSubstrate`; `swipe` / `pinch` / `touch` onto `ActionSubstrate` and the five `deep: true` flags retire; `setMedia` onto `EmulationSubstrate`; `route` / `unroute` onto `NetworkSubstrate`.                                                                                                            |         ~38 | medium |
| **P4** | `EventSubstrate`. `src/replay/session.ts` subscribes through it and its `try { page() } catch` disappears, so a Safari archive gains a console stream. `src/session/dialog.ts` and `src/page/console.ts` follow.                                                                                                                                                          |         ~34 | medium |
| **P5** | The residue and the promotion. `src/tools/extensions-rebuild.ts` (16 sites) moves into the Playwright adapter's `postWire` rebuild path. `context()`-level cookies and HAR route through their widened ports. `page()` leaves `BrowserSession` for `playwright?(): PlaywrightSessionHandle`. The synthetic engine drops `fakePage()`. Every enforcer promotes to `error`. |         ~50 | large  |

**P1 through P3 unblock RFC 0008 P2**, the Android emulator engine. That engine needs `snapshot`, `find`, `click`, `verify_*` and `screenshot` to work without a `Page`, which is exactly `TargetSubstrate` plus `ElementSubstrate` plus the capture widening. **P4 unblocks 0008 P3**, the native capture path, which needs an event seam for the device log and the lifecycle events. P5 is not a prerequisite for either; it is what stops the bypass growing back.

Site counts are the clusters from §"The clusters, mapped" and are approximate at the margins, because one expression can belong to two clusters. The compile-error set from P1's optional `page?()` is the number that sizes P2 through P5, and it is unmeasured until P1 flips the type. Do not commit P2 to a sprint before P1 reports it.

## Enforcement

Three machines, because prose is not a guard (architecture-principles.md §4a) and this bypass grew back once already under a green suite.

### 1. `ports-name-no-vendor-type` (dependency-cruiser, the primary rule)

The rule that fails a build reintroducing `Page` in a port:

```js
{
  name: "ports-name-no-vendor-type",
  comment:
    "A capability port declares an interface over plain data. It must not import " +
    "playwright-core: a port that names a vendor type is not a port. The Playwright " +
    "implementation lives in the sibling *-substrate-playwright.ts module, which is " +
    "free to import whatever it drives. (RFC 0009; L1, L5.)",
  severity: "error",
  from: { path: "^src/page/[a-z-]+-substrate(-types)?\\.ts$" },
  to: { path: "node_modules/playwright-core|^playwright-core$" },
}
```

It fails today on five of the six unsplit port modules, which is the point: it is written first, lands as `warn` in P1 alongside the split, and promotes to `error` in the same phase that removes the last violation. That promotion discipline is the repo's own, stated in `.dependency-cruiser.cjs` and applied to every layering rule at P4 of RFC 0004.

A second rule covers the consumer side:

```js
{
  name: "no-tools-or-replay-to-playwright-core",
  severity: "error",
  from: { path: "^src/(tools|replay)/" },
  to: { path: "node_modules/playwright-core|^playwright-core$" },
}
```

This one passes today and would still pass with all 112 bypass sites in place, because `src/tools` never imports the type. It is worth adding as a floor, and it is not sufficient.

### 2. `no-session-page-outside-adapters` (ESLint custom rule)

The rule that catches what the import graph cannot. It keys on the **call**, `MemberExpression` with property `page` invoked on an expression whose member chain root is `session`, `sess`, `e`, `entry` or `s`. Every one of the 112 `src/tools` sites matches that shape. It also flags any `Page` type annotation outside the allowlist, so the two forms are covered by one rule.

The allowlist is a named array with a per-entry rationale, the shape `ENGINE_SELECT_ALLOWLIST` already has, and it shrinks by phase:

```js
const PLAYWRIGHT_HANDLE_ALLOWLIST = [
  /src\/engine\/adapters\//,
  /src\/session\/playwright-(handle|post-wire)\.ts$/,
  /src\/page\/[a-z-]+-playwright\.ts$/,
  // P1..P5: shrinking. Each phase deletes the entries it emptied.
];
```

`warn` from P1, `error` from P5. An inline disable is never the relaxation mechanism; a change to this array is an RFC amendment with a written reason, per the §7 meta-rule.

### 3. A Page-free `ocp-engine-contract` (the behavioural gate, and the one that matters)

The two lint rules are textual and a determined caller can satisfy both while still holding a `Page`. The gate that cannot be talked around is the synthetic engine.

`InMemoryBrowserSession` deletes `fakePage()`, declares no `"page"` sub-interface, and implements no `page()`. The test then drives, per phase:

| Phase | The synthetic engine additionally drives                              |
| ----- | --------------------------------------------------------------------- |
| P1    | `snapshot` / `find` with no `page.url()` / `page.title()` behind them |
| P2    | `verify_visible` / `verify_text` / `verify_count`                     |
| P3    | `screenshot` / `scroll` / `gesture_swipe`                             |
| P4    | `console_read`, and a replay archive that carries a console stream    |
| P5    | The full non-`deep` tool surface                                      |

A regression that reintroduces a `Page` read on any of those paths fails with a `TypeError` naming the method, on a test that already exists and already runs in `pnpm test`. `port-conformance.test.ts` gains the matching assertion: no engine declares `"page"` and omits the handle, and none omits `"page"` and supplies one.

## Relationship to RFC 0008

0008 §1 proposes five type changes as a tactical unblock. This RFC supersedes two of them and leaves three standing.

| 0008 §1 item                                                                                            | Verdict                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `EngineKind` gains `"ios-app"` / `"android-app"`                                                     | **Stands.** Untouched by this RFC.                                                                                                                                                                               |
| 2. `BrowserSession.page()` becomes optional                                                             | **Superseded.** Optional is P1's enumeration device and P5 deletes the member for `playwright?(): PlaywrightSessionHandle`. A permanent `page?:` duplicates the `subInterfaces.has("page")` probe, which is L2.  |
| 3. `SubstrateCapableSession.page` optional, selector keys on handle presence                            | **Superseded.** The selector keys on `caps.subInterfaces.has("page")`, the declaration that already exists, and the whole selector folds into `EngineEntry.makeSubstrates` where the engine owns its own choice. |
| 4. `native?(): NativeSessionHandle`                                                                     | **Stands, and generalises.** `playwright?()` is the same pattern applied to the majority engine, so all three handles read alike.                                                                                |
| 5. `SecretRegistry.materialize` second parameter renamed to a scope                                     | **Stands.** Orthogonal, and `TargetSubstrate.url()` is what supplies the native scope string.                                                                                                                    |
| §1 closing: touch and gesture move behind `ActionSubstrate`, `deep: true` retires on five registrations | **Absorbed** as this RFC's P3. Same design, same five registrations, scheduled here because the widening is web-side work that native then inherits.                                                             |

0008's P1 row ("Port widening: optional `page()`, the native handle, the gesture and touch substrate, the deep-flag retirement", sized "medium, with an unmeasured tail") is this RFC's P1 and P3. **0008 should be edited**: replace §1 items 2 and 3 with a pointer here, and replace the P1 row with "RFC 0009 P1 through P3" as a dependency. The rest of 0008 is unaffected, including the archive spine, the selector model, the capture path and the `native-device` capability, none of which this RFC touches.

The sequencing consequence is the useful part. 0008's P1 tail was unmeasured because nobody had flipped the type. This RFC measures it in its own P1 and spends it across four phases of web-side refactor that ship on their own merits, so 0008 P2 starts against a port that already works Page-free on a real engine.

## Honest limits

**The cost.** 115 call sites, 35 tool modules, six port-module splits, five phases. P5 alone is ~50 sites and it is the phase with the least product value, which is how bypasses survive. The mitigation is that the enforcers promote to `error` in P5, so the phase has a hard completion criterion rather than a judgement call.

**What is most likely to break.** `ElementSubstrate` is the risk. `locatorFor` currently returns a live Playwright `Locator` and callers chain on it: `.first()`, `.count()`, `.isVisible()`, `.boundingBox()`, `.evaluate()`. Replacing the `Locator` with an opaque token means each chained probe becomes a port call, and `find`'s disambiguation runs probes per candidate. On a 40-candidate query that is 40 extra awaits where there were none. Performance is a design input here, not an afterthought (architecture-principles.md §3), so P2 measures the `find` p95 before and after on the capability-testbed, and the batched `probe(el, want)` signature exists specifically so one round trip answers several questions. If the measurement is bad, the fallback is that the Playwright implementation returns a token that _is_ the `Locator`, cached in a per-call map, which keeps the chaining cheap and the port honest.

**The second risk is `url()` going async.** 30 call sites and two of them are on the action hot path (`actions-secrets.ts:29` scopes every secret materialisation by URL; `actionresult.ts` stamps every action envelope). A round trip per action on Safari would be a real regression. P1 measures it and the cache-on-`framenavigated` mitigation is designed only if the numbers demand it.

**What this does not solve.** `evaluate` has no native equivalent. `ScriptSubstrate` exists, and on `ios-app` / `android-app` it refuses, which 0008 §2 already commits to. Every tool that reads the DOM through a server-owned page-side function stays Playwright-only and honestly gated: `dom_export`, `element_export`, `extract`, `archive`, `coverage`, `set_of_marks`, `shadow_trees`, the worker and service-worker tools, the whole `deep` family. That is roughly 60 of the ~196 tools. A Page-free port makes those tools _refusable_ on a native engine; it does not make them _runnable_. Web and native are not symmetric and this design does not claim they will be.

**`StorageSubstrate` stays fat.** 22 members, past any reasonable ISP ceiling. Splitting it along the cookies / web-storage / IndexedDB / Cache-API lines is a real piece of work and it is not this RFC.

**Multi-tab has no native analogue.** `context().pages()`, `bringToFront` and the target-pool machinery of [RFC 0005](0005-attached-target-pool.md) stay behind `playwright?()`. A native session drives one app, and 0008's open question about multi-app flows is where that gets resolved.

## Open questions

- Does `ActionSubstrate` at fifteen members split along the action/gesture line, or does the member ceiling take a documented exception? The shape is clearer once P3 has written the three gesture methods.
- Should `EventSubstrate.subscribe` take an event-kind filter? The replay orchestrator wants everything; `console_read` wants one kind. A filter argument avoids a fan-out that the handler then discards, and it adds a parameter to the only method on the port.
- Does `TargetSubstrate` absorb the frame tools (`frames_list`, `resolveFrameById`), or do frames get their own port? Native has windows and webviews, which are frame-like without being frames.
- Where does the extension-context rebuild live? `EngineEntry.postWire` is the natural home by responsibility, and the rebuild is a 16-call, `chromium`-only path that no other engine will ever want. A `postWire` that only one engine implements is close to the speculative generality the doctrine forbids.
- `PlaywrightSessionHandle` carries `{page, context}`. Does it also carry `cdp`, which is `BrowserSession.cdp?()` today and is read through `requireCdp` at 32 sites? Folding it in makes one handle per engine; leaving it out keeps `requireCdp`'s structured refusal untouched.

## References

- [RFC 0003](0003-capability-ports-decoupling.md): the seven capability ports this RFC finishes.
- [RFC 0004](0004-architecture-hardening.md): the ten laws, the enforcer-per-invariant rule, and D5, which declared page-availability as data.
- [RFC 0008](0008-native-app-control.md): the two engines that need this, and the five type changes two of which are superseded above.
- [`docs/ai-context/architecture/architecture-principles.md`](../ai-context/architecture/architecture-principles.md): §1 dependency direction, the proven-seam test, §3 performance as a design input, §4a the ten laws.
- [`docs/ai-context/architecture/fitness-functions.md`](../ai-context/architecture/fitness-functions.md): the index every rule in §Enforcement joins.
