# RFC 0008: Native app control (iOS simulator and Android emulator as engines)

**Date:** 2026-09-15
**Status:** Draft. The `ios-app` and `android-app` engines are built, and the tool reference says what ships. Section 10 (2026-11-23) adds the real-device lane plan, which is a manual runbook and a follow-up code change.
**Trigger:** Owner directive relayed by the Control+ team, 2026-09-15. Their QA workflow has a stage where an agent exercises the product and a person signs off on the recording. On web that stage is browxai. On native they plan to adopt Callstack's `agent-device`, chosen after a two-platform trial. This RFC also closes [`references/04-decision-matrix.md`](references/04-decision-matrix.md) **D8**, which has sat blocked on exactly this product input since June 2026.

## What this is for

An agent drives a native mobile app the way a user would, and the session becomes evidence a human validates. That is the same sentence RFC 0007 opens with, minus the browser. The Control+ team's trial produced a shopping list: one MCP surface over iOS simulators and Android emulators, find by accessibility id or testID, tap, type, scroll, swipe, read the screen, a diff of what changed after each action, a whole-session video with touches drawn in, a timestamped step log, screenshots that match the screen, and CI on a macOS runner with the first-run build cached. Targets are two bare React Native apps, RN 0.81.4, JavaScript, no Expo.

Every item on that list is a feature `agent-device` already has. None of them is the reason to build this.

## The spine: one archive, one clock, one verifier

A native session writes the **same `.browx` archive** as a web session: the same append-only event log on one clock ([`src/replay/schema.ts`](../../src/replay/schema.ts)), the same `record_annotate` spans carrying `label` and `phase`, the same content-addressed container. One player opens a web session and a native one. One CI verifier reads spans from both and answers "did the agent exercise the acceptance criteria I care about" without knowing which platform produced the session.

That is what a separate native tool cannot give. Two tools means two evidence formats, two players, two verifiers, and a sign-off process that splits down the middle of one product. The capture format is the asset here, and it already exists and already shipped.

Everything else in this RFC is subordinate to that. Where a native capability and archive compatibility pull in different directions, archive compatibility wins.

## D8, closed

From [`references/04-decision-matrix.md`](references/04-decision-matrix.md) D8:

> **Evidence lean:** Option 1 for Android is near-free and high-fidelity per the ecosystem report; option 3 is explicitly anti-recommended ('do not route browsers through Appium': thin wrappers over the same drivers plus a server hop). iOS real Safari rides the Classic/safaridriver decision above, with Appium XCUITest only if console/network log streams or hybrid contexts are required; avoid GPL-3.0 pymobiledevice3 in favor of Apache-2.0 appium-ios-remotexpc or MIT go-ios.
>
> The whole decision is partially blocked on the missing product input: are native-app contexts actually in scope, or did 'Appium lane' just mean 'mobile browsers'?

The product input has arrived: native app contexts are in scope, as a first-class QA-evidence surface. D8's option 2 is the ruling. Three constraints carry forward unchanged.

- **Browsers never route through Appium.** Mobile Chrome stays on the shipped `android` engine (adb plus CDP socket discovery, `deep: true`, every tool works). Native app control is a different engine kind that sits beside it.
- **Licence floor.** browxai is MIT. iOS plumbing may use Apache-2.0 `appium-ios-remotexpc` or MIT `go-ios`. GPL-3.0 `pymobiledevice3` is excluded, directly and transitively, and the dependency audit at add time checks for it by name.
- **Appium's BiDi is telemetry, not control.** Its three session-level commands are an event-subscription channel. Nothing in this design assumes a BiDi command path on a native driver.

Real devices are out of scope for v1. Simulators and emulators only. §Honest limits says why. Section 10 plans a manual evidence lane on one real iPhone, which does not change that for the engine's supported surface.

## What already exists

Most of the capture half is built. RFC 0007 phases 1 through 3 landed in v0.10.1 on 2026-09-14, so this RFC inherits a working archive and a working player.

| Need                                     | Already in the repo                                                  |
| ---------------------------------------- | -------------------------------------------------------------------- |
| Append-only event log on one clock       | `src/replay/log.ts`, `src/replay/sources.ts:24-52`                   |
| `.browx` container, content-addressed    | `src/replay/artifact.ts`                                             |
| Offline player, opens from `file://`     | `src/replay/player/`                                                 |
| Coverage view grouped by span label      | `src/replay/player/panels/coverage-panel.ts`                         |
| A pluggable engine port                  | `src/engine/registry.ts:101-161`                                     |
| A non-Playwright engine that uses it     | `src/engine/adapters/safari.engine.ts` (58 lines, no `Page`, no CDP) |
| Engine-agnostic action verbs             | `src/page/action-substrate.ts:36-50`                                 |
| Snapshot as data, not as a DOM           | `src/page/snapshot-substrate.ts:46-62`                               |
| Protocol-neutral ref identity            | `src/page/refs.ts:25-35`                                             |
| Secret masking at one chokepoint         | `src/util/secrets.ts`                                                |
| Per-tool and per-engine gating           | `src/util/capabilities.ts`, `src/engine/tool-gate.ts`                |
| An attach-only engine with device leases | `src/engine/adapters/android.engine.ts`, RFC 0005's lease table      |

The missing pieces are a driver for each native platform, a view-hierarchy walker feeding the existing snapshot contract, segmented video capture, and a player stage that renders a native session.

## What generalises and what assumes a Chromium page

This is the audit the engine layer needs before any of the above is worth planning. Line references are against the tree at 7f1298c.

### Already generalises to a non-browser target

| Surface                                        | Where                                         | Why it holds                                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine registration                            | `src/engine/registry.ts:143-161`              | Add-only. A sixth engine is one `registerEngine(...)` call in a new file plus one line in `register-engines.ts:13-17`. No session factory edit.                                                   |
| Per-engine capability declaration              | `src/engine/capabilities.ts:105-117`          | Safari already declares a seven-of-ten subset and omits `network` and `emulation`. A native engine declaring a different subset is the same move, not a new mechanism.                            |
| The `page` sub-interface                       | `src/engine/types.ts:61-67`                   | The port already models "this engine has no Playwright `Page`" as declared data. Native is the second engine to use it.                                                                           |
| Action verbs                                   | `src/page/action-substrate.ts:36-50`          | The interface names verbs and `ActionResult`, never Playwright. `SafariActionSubstrate` implements it over WebDriver Classic with zero Playwright types.                                          |
| Snapshot contract                              | `src/page/snapshot-substrate.ts:46-62`        | `compose()` returns `ComposedSnapshot` and `a11yTree()` returns `A11yNode`. Both are plain data with a role, a name, a testId and a path. A view hierarchy fits without deformation.              |
| A third snapshot substrate over a tiny IO seam | `src/page/snapshot-substrate-safari.ts:27-35` | `SafariSnapshotIO` is two methods. Proof that a substrate needs a transport, not a browser.                                                                                                       |
| Ref identity                                   | `src/page/refs.ts:25-35`                      | `elementKey` hashes role, name, path, testId, frameId. Every input has a native counterpart. No protocol appears in the hash.                                                                     |
| Named refs                                     | `src/page/refs.ts:151-165`                    | `name_ref` is a string map over ref ids. Engine-blind already.                                                                                                                                    |
| Substrate ownership by the engine              | `src/page/substrate-bundle-safari.ts`         | A no-Page engine supplies all seven selectors from its own handle, including a deliberately no-op network substrate.                                                                              |
| The event envelope                             | `src/replay/schema.ts:20-45`                  | Open type union, per-event payload version, forward-compatibility rule. A new event type is additive by construction.                                                                             |
| The clock and the redaction chokepoint         | `src/replay/sources.ts:32-52`                 | `createClock` takes a wall-clock origin. `event()` stamps and redacts every event whatever wrote it.                                                                                              |
| The container                                  | `src/replay/artifact.ts`                      | A zip of a manifest, a gzipped JSONL, assets, screenshots. Nothing in it is web-shaped.                                                                                                           |
| Device leasing precedent                       | `src/engine/registry.ts:191-203`              | Android already keys its attach lane on a device serial and declares itself attach-only in the engine layer. The RFC 0005 lease table transfers to "one UiAutomation owner per device" unchanged. |

### Assumes a Chromium page, or a Playwright page

| Surface                          | Where                                                  | The assumption                                                                                                                                                                                                                     |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrowserSession.page()`          | `src/session/types.ts:120`                             | Mandatory, returns `Page`. Safari's implementation throws `safari-no-playwright-page`. A native engine would be the second engine lying about a method it cannot honour. This is the port's live LSP leak.                         |
| `SubstrateCapableSession.page()` | `src/page/snapshot-substrate-select.ts:29`             | Same mandatory `page(): Page`, and line 44 dispatches on `session.engine === "safari"` to avoid calling it. A second no-Page engine makes that a literal chain.                                                                    |
| `ActionContext.page`             | `src/page/actionresult-types.ts:279`, `:300`           | `page: Page` and `pages: () => Page[]` are required fields of the Playwright action window. Native never builds one, which is fine, and it means the native action envelope is assembled by a different path.                      |
| Secret scoping                   | `src/page/actions-secrets.ts:29`                       | `ctx.secrets.materialize(raw, ctx.page.url())`. Scope is an exact origin match (scheme, host, port). A native screen has no web URL, so its `app://` target url is the origin.                                                     |
| Locator resolution               | `src/page/locator.ts:131`                              | `locatorFor(page, refs, target): Locator`. Every element-scoped tool that has not moved behind a substrate goes through it.                                                                                                        |
| Element-scoped verification      | `src/page/verify-element.ts:13`                        | Imports `Locator` and `Page` directly. `verify_visible` / `verify_text` / `verify_value` / `verify_attribute` resolve through it.                                                                                                  |
| Element capture                  | `src/page/capture-substrate.ts:97-104`, `:110-129`     | The Playwright capture substrate takes `page: () => Page` and resolves targets to a `Locator`. Safari has its own; native needs a third.                                                                                           |
| Pointer geometry                 | `src/page/gestures.ts:6`, `:18-25`                     | `targetPoint` resolves a target to a viewport point via `locator.boundingBox()`. Native bounds come from the hierarchy dump instead.                                                                                               |
| The DOM walker                   | `src/page/dom-walk.ts:16`, `:20-37`                    | `CDPSession` and `Frame` imports, and a page-side script over `querySelectorAll` / `shadowRoot` returning `DomWalkEntry`. This is the most browser-welded module in the read path and it is not portable. Its **output shape** is. |
| The touch pipeline               | `src/tools/input-tools.ts:81-90`, `:121`               | `touch_start` / `touch_move` / `touch_end` declare `deep: true` and call `requireCdp(e.session)`. On any engine declaring `deep: false` the engine gate refuses them outright.                                                     |
| Coordinate gestures              | `src/tools/gesture-coord-tools.ts:147`, `:183`, `:111` | `gesture_swipe` and `gesture_pinch` are `deep: true` and CDP-dispatched. The two tools a native QA agent needs most are the two the current gate would refuse.                                                                     |
| Replay source attachment         | `src/replay/session.ts:329-353`                        | `attachSources` calls `session.page()`, catches the throw, and returns early. A no-Page engine records actions and annotations only, with an empty DOM stream, no console, no network.                                             |
| The DOM stream                   | `src/replay/dom-capture.ts`                            | rrweb injected via `addInitScript` with results crossing back through an `exposeBinding`. There is no native analogue and there should not be one.                                                                                 |
| Video capture                    | `src/replay/artifact.ts:22`, `:135`                    | A single `video.webm` entry. Segmented native capture produces many.                                                                                                                                                               |

### The honest answer

A native engine **does not fit the current `BrowserSession` port without changing it**. The port claims every session has a Playwright `Page`, and one shipped engine already breaks that claim by throwing. Adding a second engine that throws would make an accident into a pattern. The changes are small and they are listed next.

## 1. The capability-port boundary

> **Superseded in part by [RFC 0009](0009-page-free-session-port.md), 2026-09-16.** Items 2 and 3
> below described a tactical patch: make `page()` optional and have one selector key on handle
> presence. Measurement for 0009 found the leak is 115 call sites across 35 of the roughly 40
> modules in `src/tools`, so an optional member would have left the bypass intact and the compile
> errors would have landed in tool handlers with no port to move them onto. 0009 does the work
> properly: three new ports, four widenings, `page()` deleted over five phases. Items 1, 4 and 5
> stand as written, and so does the touch and gesture paragraph at the end of this section, which
> 0009 adopts into its own P3. **Read 0009 first.** This RFC's P1 is now a dependency on 0009
> P1 through P3, not a phase of its own.

`registerEngine` works as-is. The `EngineEntry` record (`src/engine/registry.ts:101-135`) asks for a kind, a capability row, a launch function, a substrate bundle and a post-wire step. A native adapter supplies all five, and `src/engine/adapters/safari.engine.ts` is the 58-line template.

Five type changes, each one line or close to it.

1. **`EngineKind` gains `"ios-app"` and `"android-app"`** (`src/engine/types.ts:25`, plus `ENGINE_KINDS` at `:27-33` and the mirror list in `eslint.config.js`). The existing `android` kind keeps its meaning: real Chrome on a real phone over adb and CDP. Two names that both say "android" is a documentation cost, and renaming a shipped engine kind is a breaking config change, so the new kind takes the qualifier.

2. ~~**`BrowserSession.page()` becomes optional**~~ **(superseded by 0009: `page()` is removed, not made optional.)** The original text follows for the record. `BrowserSession.page()` becomes optional (`src/session/types.ts:120`): `page?(): Page`. The `page` sub-interface at `src/engine/types.ts:61-67` is already the declared discriminator; this makes the type agree with it. Safari stops throwing from a method it declares, and every call site that reads `session.page()` gets a compile error pointing at a real decision. That error set is the true cost of this RFC's first phase and it should be measured before P1 is sized as medium.

3. ~~**`SubstrateCapableSession.page` becomes optional**~~ **(superseded by 0009: the selector keys on the declared `subInterfaces`, and the port splits from its adapter.)** The original text follows for the record. `SubstrateCapableSession.page` becomes optional (`src/page/snapshot-substrate-select.ts:27-32`), and the selector keys on handle presence instead of the engine literal at `:44`. The engine-owned `makeSubstrates` path (`src/page/substrate-bundle-safari.ts`) already bypasses this file for Safari; native follows the same route and the legacy selector stops accumulating literals.

4. **A native session handle, mirroring `safari?()`**: `native?(): NativeSessionHandle` on `BrowserSession` (`src/session/types.ts:136`). The handle carries a driver client, a device id, an app id, and the platform. Its substrate bundle reads it, exactly as the Safari bundle reads `e.session.safari!()`.

5. **`SecretRegistry.materialize(value, pageUrl)` renames its second parameter to a scope context** (`src/util/secrets.ts:126`). The check is an exact origin match, so passing `app://com.acme.app/CheckoutScreen` matches a scope of `app://com.acme.app`: the path is dropped when the origin is read, and the host compares case-insensitively. §6 says why this matters.

`ActionContext` (`src/page/actionresult-types.ts:278`) does **not** change. It is the Playwright action window's own context, and a native substrate builds its envelope from native pre and post state, the way `SafariActionSubstrate` does.

One more boundary change, and it is the load-bearing one for the tool surface: **the touch and gesture pipeline moves behind a substrate**. Today `deep: true` stands in for "has a CDP touch pipeline" (`src/tools/input-tools.ts:83`, `src/tools/gesture-coord-tools.ts:147`). On native, touch is the primary input and CDP is absent, so `deep` would refuse the tools a native agent needs most. Add `swipe`, `pinch` and `touch` to `ActionSubstrate`, have the Playwright implementation delegate to today's CDP path when `cdp` is present and return the existing `directDispatchUnsupported` refusal when it is not, and drop `deep: true` from those five registrations. The engine gate then refuses them on Firefox and WebKit for the same measured reason it does today, through the substrate instead of through the CDP flag.

## 2. Tool surface

The bias is to generalise. A tool whose meaning survives the platform change keeps its name, its schema and its `ActionResult` shape, so an agent skill written for web transfers and a CI verifier reads one vocabulary.

| Tool                                                            | Native                                                                                                                                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`, `find`, `text_search`, `find_feedback`              | Generalise. The native snapshot substrate emits `A11yNode` from the view hierarchy; the ranking, ref minting and selector-hint code above it never learns the difference.                                        |
| `click`                                                         | Generalise as tap. Same target vocabulary, same envelope.                                                                                                                                                        |
| `fill`                                                          | Generalise. Element-scoped `setValue` on the driver, never a shell `input text`. §6.                                                                                                                             |
| `press`                                                         | Generalise, with a platform key vocabulary: Android hardware keys including `back` and `home`, iOS simulator hardware buttons and the software return key.                                                       |
| `scroll`, `gesture_swipe`, `gesture_pinch`, `touch_*`           | Generalise once they move behind the substrate (§1). Native gestures are W3C Actions or driver-native `mobile:` commands, both of which take the same from/to/duration/steps arguments.                          |
| `screenshot`, `screenshot_region`, `screenshot_marks`           | Generalise via a native `CaptureSubstrate`: `xcrun simctl io screenshot`, `adb exec-out screencap`. Region and marks crop from the full frame using hierarchy bounds.                                            |
| `wait_for`                                                      | Generalise. Polls the native snapshot for the predicate instead of a Playwright locator state.                                                                                                                   |
| `verify_visible` / `_text` / `_value` / `_attribute` / `_count` | Generalise over the snapshot tree. The element-scoped ones need a substrate route, because `src/page/verify-element.ts` resolves through a `Locator`. `verify_predicate` is pure and already portable.           |
| `act_and_diff`, `ActionResult.structure`                        | Generalise, and this is the trial's "diff of what changed after each action" arriving for free. The action window's appeared/removed sets are computed from pre and post trees, whatever produced them.          |
| `record_annotate`                                               | Unchanged. It writes a span into the log and never touches the target.                                                                                                                                           |
| `name_ref`, `list_named_refs`                                   | Unchanged.                                                                                                                                                                                                       |
| `grant_permissions`                                             | Generalise: `simctl privacy grant`, `adb shell pm grant`.                                                                                                                                                        |
| `navigate`                                                      | Generalise for deep links only. `navigate({url: "myapp://checkout/42"})` opens a URL scheme on both platforms. A native screen has no address bar, so `go_back` maps to the Android back key and refuses on iOS. |
| `console_read`                                                  | Generalise over the device log (logcat, simulator syslog) filtered to the app's process.                                                                                                                         |
| `eval_js`, `poll_eval`                                          | Refuse. There is no scriptable context in a release-configuration RN app, and reaching into a dev bridge would be a different trust posture.                                                                     |
| `network_read`, `network_body`, `route`, `route_queue`          | Refuse, through a no-op network substrate exactly like `SafariNoopNetworkSubstrate`. §Honest limits.                                                                                                             |

Genuinely new, because no existing tool means them:

- `app_launch`, `app_terminate`, `app_reset`. Process lifecycle has no browser analogue. Reset clears app data and permissions so a run starts from a known state.
- `device_list`. Enumerates booted simulators and running emulators so an agent can pick a target, and reports which device is already leased.

The app under test and the device are **session options**, not tools: `open_session({ browserType: "android-app", native: { deviceId, appId, appPath } })`. That reuses the session-creation path every engine goes through and keeps the tool count at five new registrations.

## 3. The selector model

The trial's sharpest finding: `mobile-mcp`'s positional refs broke under layout change and it misreported tapping the wrong element twice. A reported tap on the wrong element is worse than a failed tap, because it poisons the evidence the whole workflow exists to produce.

**Accessibility id and testID are the only tier-1 selectors.** On RN 0.81.4, `testID` surfaces as `accessibilityIdentifier` on iOS and as the view's resource id on Android, where `content-desc` can shadow it when `accessibilityLabel` is also set. The native walker reads both and records which one matched, so a selector hint says what it actually queried.

**Ref minting reuses `elementKey` with one native rule.** The hash inputs (`src/page/refs.ts:25-35`) map cleanly: `role` is the element type, `name` is the accessibility label, `testId` is the testID, `path` is the index path through the hierarchy, `frameId` is the window or webview id. The native rule is that **when a testID is present, `path` is passed empty**. Identity then rests on type, label and testID, and a ref survives a layout change that moves the node. Without a testID the full path key applies and the ref is snapshot-local, which is the honest status of an unlabelled element. `name_ref` pins the durable case for the length of a session.

**Every native action re-resolves its ref to a live element before dispatch**, by querying the testID or the accessibility id, never by replaying cached coordinates. Zero matches or more than one match is a structured refusal naming the ref and the count. Coordinates are computed from the element the query just returned, in the same call. That closes the class of bug the trial found, because a stale ref cannot silently resolve to whatever now occupies its old rectangle.

`[ref=eN]` stays the agent-facing vocabulary on both platforms, and `buildSelectorHint` (`src/page/find.ts:634`) gains a native tier table so an exported step reads `~checkout-submit` instead of a pixel pair.

## 4. The capture path

A native session opens a `ReplaySession` the same way a web session does, with a native source set in place of the DOM, network and console subscriptions at `src/replay/session.ts:329-353`.

**Reused event types, unchanged:** `action/call`, `action/result`, `assert/result`, `annotate/span`, `console/message`, `page/error`. The console adapter's payload is an index-signature superset by design (`src/replay/sources.ts:6-10`), so a logcat line rides through carrying an extra `source` field and an old player still renders its text.

**New event types:**

| Type               | Payload                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `native/hierarchy` | A view-hierarchy keyframe: the same node shape `snapshot` returns. Written once per action, not as a mutation stream. |
| `native/touch`     | Dispatched touch points with their timestamps, so a player can draw them over the video.                              |
| `app/lifecycle`    | launch, foreground, background, terminate, crash.                                                                     |
| `capture/segment`  | A video segment boundary: segment index, its own start offset on the session clock, and the gap in ms.                |

**No `REPLAY_SCHEMA_VERSION` bump.** The constant is documented to move only for a breaking envelope change (`src/replay/schema.ts:5-7`), and the type union is open by construction (`:31`). A player built before native ignores `native/*`, `app/lifecycle` and `capture/segment`, and still renders the timeline, the step list, the console panel and the coverage view from a native archive. That is the one-player claim, and it holds today with no player change at all. A native stage that draws the hierarchy keyframes and the video is an upgrade, not a precondition.

**The manifest** gains an optional `device: { platform, model, osVersion, appId, appVersion }`. Unknown manifest fields are ignored by the same rule, so this is additive.

**Screenshots** need nothing new: `screenshots/<n>.webp` and the `screenshot` index on `ActionResultPayload` already exist and already bind a frame to an action.

## 5. Video, and the 180-second limit

Android `screenrecord` stops at 180 seconds. A QA session runs longer.

Capture is **segmented**. A segment starts, stops at 170 seconds, and the next starts immediately. Each boundary writes a `capture/segment` event on the session clock carrying the real gap between stop and start, which is a few hundred milliseconds of lost footage. Recording the gap is the point: a reviewer seeing a jump needs to know whether the agent did something off-camera or the recorder blinked. The manifest carries the total gap in ms.

Segments land in one archive as `video/<n>.<ext>`, ordered by index, each with a start offset on the session clock. When there is exactly one segment the writer **also** emits it as `video.webm`, so a player built before this RFC still shows video for short sessions.

Two container consequences, stated plainly. The current writer has a single `video.webm` entry (`src/replay/artifact.ts:22`, `:135`), so this is a real container change. And the iOS simulator records `.mov` or `.mp4` via `simctl io recordVideo`, so the entry name carries the extension and the manifest names the codec. No transcode step, because that would mean bundling ffmpeg, and browxai bundles no media binaries.

**Touch indicators.** Android draws them when the system `show_touches` setting is on, so the session enables it at start and restores the prior value at teardown. The iOS simulator has no equivalent, so the player draws touches from `native/touch` events. That asymmetry is why the event type exists rather than relying on burned-in pixels.

**Rejected:** a frame-grab loop over `adb exec-out screencap`, which is low frame rate and heavy on CPU. **Noted as an escape hatch:** scrcpy (Apache-2.0) mirrors the display as a continuous H.264 stream with no time cap. If segmentation proves too lossy in practice, scrcpy removes the limit at the cost of shipping a second binary, and the licence is compatible.

## 6. Secrets

Typed secrets must not reach a saved script or the capture log. The `SecretRegistry` chokepoint (`src/util/secrets.ts`) is where that is enforced today, and native input routes through it unchanged: `fill` calls `materialiseValue(ctx, raw)` (`src/page/actions-secrets.ts:24-32`), the real string exists only inside the driver dispatch call, and the recorded step and the `ActionResult` descriptor carry the `<NAME>` alias.

Native adds leak sinks the web path does not have, and each one is closed at capture time.

A native text field reports its typed contents as an attribute of the view, so the hierarchy dump carries the secret. Every `native/hierarchy` event passes through `applyMaskDeep` before it reaches the log, the way `maskProbe` already handles web probes (`src/page/actions-secrets.ts:70-80`).

`adb shell input text <secret>` puts the value in the device's shell and in anything tailing it. The native `fill` path uses the driver's element-scoped set-value command and never composes a shell string from a materialised secret.

The video is the sink with no clean fix. A password field renders dots, but the iOS keyboard shows a character preview bubble above the pressed key, and a 30fps recording catches it. Setting the field value directly without synthesised key events avoids it where the driver supports that, and the driver does not support it everywhere. This is a residual risk on any recorded native session, the tool description says so, and the threat-model row names it.

Scope binding works through the renamed second parameter (§1.5): a secret registered with `scope: "app://com.acme.app"` refuses to materialise into a different app's session, using the same origin match the URL path uses. A bare `com.acme.app` would mean `https://com.acme.app`, which no app screen matches.

## 7. CI

The lane splits by platform, because only one half needs macOS. `android-app` runs on `ubuntu-latest` with KVM enabled: a Linux runner with hardware acceleration is roughly a tenth the cost of a macOS one, and nothing about the Android emulator needs Darwin. `ios-app` runs on `macos-15`, the only place `xcrun simctl` exists.

**Caching the first-run build.** The keys hash the lockfile plus the native project files, so a JS-only change never rebuilds native. Cached: `~/.gradle/caches` and the Gradle wrapper, the built `.apk`, the AVD system image and a booted snapshot, `~/Library/Developer/Xcode/DerivedData`, CocoaPods artifacts, and the built `.app`. A cold Xcode build of a bare RN app is minutes; a warm one is seconds, and that difference decides whether the lane runs per push or per release.

**Cost discipline.** GitHub bills macOS minutes at ten times Linux. The iOS lane runs on release branches and on demand.

**What stays manual.** Real devices, because they need code signing, a provisioning profile, a WebDriverAgent build and a physical machine with the device attached. Biometrics, push notifications and App Store flows. Anything requiring a paid Apple Developer identity. And the sign-off itself, which is a person watching the recording, and which is the whole point of the workflow.

## 8. Capability gating

A new capability, **`native-device`, off by default, loud-warn on first use**, in the same posture class as `replay` and `network-body`.

It broadens posture more than any browser capability does. It installs and launches applications, drives an OS-level input pipeline, reads the device log, records the screen continuously, and grants privacy permissions on the target's behalf. On a simulator that reaches a sandbox. The same code path against a real device, once real devices land, reaches the operator's phone.

The mechanics follow the shipped pattern with no new machinery: a row in `Capability` and `ALL_CAPABILITIES` (`src/util/capabilities.ts:25`, `:37`), a loud-warn entry alongside the `replay` one at `:323`, a `docs/threat-model.md` row, and per-tool keystone tests asserting refusal when the capability is unset. `open_session({browserType: "ios-app"})` refuses without it, so the gate sits at session creation and no native tool can be reached around it. Writing an archive additionally requires `replay`, so the two capabilities compose.

## 9. Phases

P1 no longer exists as work this RFC owns. The port change it described grew past a
tactical patch once measured, so it moved to RFC 0009 and this RFC waits on it. The
tail that was unmeasured there is measured there: 115 sites, five phases.

| Phase | Scope                                                                                                                                                                      | Rough size                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| P1    | **Delegated to [RFC 0009](0009-page-free-session-port.md) P1 through P3.** What stays here: the two new `EngineKind`s, the `native?()` handle, and the secret-scope rename | small, once 0009 P3 lands |
| P2    | Android emulator engine: adapter, hierarchy walker into the snapshot substrate, action substrate, selector model                                                           | large                     |
| P3    | Capture: native event types, segmented video, the manifest device row, secret masking on hierarchy dumps                                                                   | medium                    |
| P4    | iOS simulator engine over XCUITest                                                                                                                                         | large                     |
| P5    | Player: a native stage drawing hierarchy keyframes, video segments and touch overlays                                                                                      | medium                    |
| P6    | CI lanes, build caching, the capability and threat-model docs pass                                                                                                         | medium                    |
| P7    | Real-device evidence lane: a manual runbook now (section 10), the device launch path as a later code PR                                                                    | small, plus the code PR   |

P1's tail is the compile-error set from making `page()` optional. Every call site that reads it becomes a decision, and the count is unknown until someone flips the type. Measure it before committing P1 to a sprint.

P2 before P4 because Android's plumbing is adb and a device-side server, which is inspectable and cheap to iterate against, while iOS adds WebDriverAgent signing and simulator boot latency to every debug cycle. P3 after P2 so the capture path is designed against a real hierarchy. P5 last because §4 shows the existing player already opens a native archive with reduced fidelity, so the stage is an upgrade with no blocking dependents.

## 10. Real-device lane plan

**Date:** 2026-11-23. **Owner decisions, final:** the device lane is a manual runbook on the owner's Mac, with no self-hosted CI agent and no daemon. The device is one dedicated iPhone on the same network as the Mac, reached by wireless debugging and not by USB. The Apple Developer Program organization team is active. Evidence goes into the engine evidence table by hand, with a date.

This section plans the work. It writes no engine code. Two scripts support it: [`scripts/ios/wda-run.sh`](../../scripts/ios/wda-run.sh) builds, runs and probes WebDriverAgent, and the keystone and engine changes in 10.5 and 10.6 are a later code PR. The owner's own step-by-step checklist for the portal and Mac steps is kept outside this repository.

### 10.1 What runs on the Simulator, with no membership

Nothing here needs a paid team. Run it first, because it is the same WebDriverAgent code that runs on a device.

1. Install Xcode. Check `xcode-select -p`. Accept the license once (`sudo xcodebuild -license accept`) and run `xcodebuild -runFirstLaunch`.
2. Install an iOS Simulator runtime (Xcode, Settings, Components, or `xcodebuild -downloadPlatform iOS`). Check `xcrun simctl list runtimes`.
3. Pick a simulator from `xcrun simctl list devices available`. Keep its UDID out of the repository.
4. Boot it: `xcrun simctl boot <SIM_UDID>`, then `xcrun simctl bootstatus <SIM_UDID> -b`.
5. Check out WebDriverAgent at one pinned release tag, outside this repository: `git clone --branch <WDA_TAG> --depth 1 https://github.com/appium/WebDriverAgent <WDA_DIR>`. Use the newest tag that builds with the installed Xcode, and write the tag and commit down.
6. Build for the simulator, which needs no signing: `TARGET=simulator UDID=<SIM_UDID> WDA_DIR=<WDA_DIR> DERIVED_DATA=<DIR> scripts/ios/wda-run.sh build`. The script runs `xcodebuild build-for-testing -scheme WebDriverAgentRunner` with `CODE_SIGNING_ALLOWED=NO`.
7. Start it: the same variables with `scripts/ios/wda-run.sh run`. It runs `xcodebuild test-without-building` and blocks. A line with `ServerURLHere` names the address. Leave it running.
8. Probe it from a second terminal: `WDA_URL=http://127.0.0.1:8100 scripts/ios/wda-run.sh probe`. The probe prints HTTP codes and JSON shapes for every endpoint `wda-client.ts` calls, and checks which of two pinch paths the build knows (the answer for v16.15.3 is in 10.10). Compare the output with `src/engine/adapters/ios/wda-client.ts` and `xcui-driver.ts`. This is the first time those shapes meet a real WebDriverAgent.
9. Run the `simctl` half of the existing keystone: `pnpm test:keystone test/keystone/ios-app.keystone.test.ts`. It starts its own stand-in server, so it does not exercise the WebDriverAgent from step 7. It does prove the lifecycle against a real simulator.
10. Drive the engine against the real WebDriverAgent by hand, using the shell route. Start the daemon with `BROWX_CAPABILITIES=read,navigation,action,human,native-device BROWX_IOS_DEVICE=<SIM_UDID> BROWX_IOS_APP_ID=com.apple.Preferences BROWX_IOS_WDA_URL=http://127.0.0.1:8100 browxai serve --socket <SOCKET> --engine ios-app`. Then run `browxai call open_session`, `snapshot`, `find`, `click`, `gesture_swipe`, `gesture_pinch` and `screenshot --out <FILE>` with `--socket <SOCKET>`. Note each tool's result.
11. Record the run (10.7).

This is what roadmap item 7 asks for. It closes the "stand-in only" gap on the Simulator. It can start as soon as a Mac has Xcode.

### 10.2 What needs a device and the organization team

- A development signature on WebDriverAgent, which needs a team, a development certificate, a registered device and a provisioning profile.
- The phone: Developer Mode on, the Mac trusted, wireless debugging paired.
- The Mac reaching the phone's address, which on macOS 15 and later is a Local Network permission for the program that connects.
- Engine code that does not assume a simulator (10.5).
- The real-device keystone (10.6).

### 10.3 Building and signing WebDriverAgent for the phone

**Provisioning needs.**

- An Apple Development certificate for the team. Xcode creates one when a person signed in to the team opens a signing screen, and the portal can create it by hand.
- The iPhone registered by UDID. With automatic signing, Xcode registers a connected device itself. The portal's Devices page does it by hand.
- An App ID for the runner. WebDriverAgent ships with the bundle id `com.facebook.WebDriverAgentRunner`, which belongs to a namespace no other team can register, so the runner target needs an id in the team's namespace. Two ways: register a wildcard App ID `<BUNDLE_ID_PREFIX>.*` once, or register the explicit ids `<BUNDLE_ID_PREFIX>.WebDriverAgentRunner` and its test host form `<BUNDLE_ID_PREFIX>.WebDriverAgentRunner.xctrunner`. The wildcard covers both and takes one portal step. No capability needs enabling on it.
- A development provisioning profile that contains the certificate, the device and that App ID. Automatic signing makes and renews it when `-allowProvisioningUpdates` is passed.

**Steps.**

1. Open `WebDriverAgent.xcodeproj` in Xcode once. In Signing and Capabilities for `WebDriverAgentLib` and `WebDriverAgentRunner`, turn on Automatically manage signing and pick the team. For `WebDriverAgentRunner` only, change the bundle identifier to `<BUNDLE_ID_PREFIX>.WebDriverAgentRunner`. Do not set the bundle id from the command line: `PRODUCT_BUNDLE_IDENTIFIER=...` on the `xcodebuild` line would apply to every target. The embedded library keeps its own id and needs no profile. Verify on a Mac.
2. Connect the phone (10.4) and build: `TARGET=device UDID=<DEVICE_UDID> BROWXAI_APPLE_TEAM_ID=<TEAM_ID> WDA_DIR=<WDA_DIR> DERIVED_DATA=<DIR> scripts/ios/wda-run.sh build`. It runs `xcodebuild build-for-testing -destination 'id=<DEVICE_UDID>' -allowProvisioningUpdates DEVELOPMENT_TEAM=<TEAM_ID>`. To let `xcodebuild` manage profiles with an App Store Connect API key and no signed-in Xcode account, also set `ASC_KEY_PATH`, `ASC_KEY_ID` and `ASC_ISSUER_ID`. The script passes them as `-authenticationKeyPath`, `-authenticationKeyID` and `-authenticationKeyIssuerID`.
3. Run it: the same variables with `scripts/ios/wda-run.sh run`, which is `xcodebuild test-without-building`. The build is reusable until the profile or certificate expires or Xcode changes, so `build` runs rarely and `run` runs for each session.
4. The phone installs the runner app and starts it. A line with `ServerURLHere->http://<PHONE_IP>:8100<-ServerURLHere` appears in the output. If the phone says the developer is untrusted, trust it under Settings, General, VPN and Device Management.
5. From the Mac: `WDA_URL=http://<PHONE_IP>:8100 scripts/ios/wda-run.sh probe`.

### 10.4 Preparing the phone and pairing over the network

1. Developer Mode: Settings, Privacy and Security, Developer Mode. The switch appears after the phone has been connected to Xcode once. Turning it on restarts the phone and asks for a passcode after the restart. Verify on the phone whether the Developer settings page also has an automation toggle on this iOS release.
2. Connect once by cable, unlock the phone and tap Trust.
3. In Xcode, Window, Devices and Simulators, pick the phone and tick Connect via network. A network icon appears next to it. The Mac and the phone must be on the same subnet, and a guest network with client isolation will not work.
4. Unplug the cable. `xcrun devicectl list devices` should still list the phone as available. Verify on a Mac that this shows wireless devices.
5. Set Auto-Lock to Never while a session runs. A locked phone stops the runner.
6. Local Network on the Mac. macOS 15 and later asks when a program connects to an address on the local network, and the prompt names the program that started the connection. The first `curl` or `node` call to the phone's address from Terminal brings it up. Allow it for Terminal, or whichever program runs the session. It is listed under System Settings, Privacy and Security, Local Network. Verify on a Mac. If `curl` to the phone times out while `xcodebuild` shows the runner started, check this setting first, then the Local Network list on the phone for the runner app.
7. Give the phone a fixed address on the router, or note that its address changes and update `BROWX_IOS_WDA_URL`.

### 10.5 How browxai connects today, and the code change a device lane needs

I read `src/engine/adapters/ios-app.engine.ts`, `ios/simulator.ts`, `ios/simctl.ts`, `ios/xcui-driver.ts`, `ios/lifecycle.ts` and `ios/wda-client.ts`.

**The WebDriverAgent transport already reaches a remote host.** `WdaClient` takes a base URL from `BROWX_IOS_WDA_URL` (default `http://127.0.0.1:8100`) and calls it with `fetch`. A phone's WebDriverAgent at `http://<PHONE_IP>:8100` needs no transport change. There is no usbmuxd client and none is needed over the network, since the runner listens on the phone's own port.

**Everything else is simulator-only.** A launch does `resolveSimulator` (`simctl list devices --json`, iOS simulator rows only), then `IosSimulator.boot`, `install` and `launch`, all `xcrun simctl`. A phone's UDID is not a simctl device, so `selectDevice` throws `no-simulator`. Three more calls use `simctl` after launch: `IosXcuiDriver.screenshot` (`sim.screenshot`), `IosXcuiDriver.openUrl` (`sim.openUrl`) and every `IosLifecycle` verb.

**The follow-up code PR.** Not written here. It needs these changes, in this order:

1. **Choosing the target.** A way to say the device is a phone: either a new setting, for example `BROWX_IOS_TARGET` with `simulator` and `device`, or a lookup that finds the id in the device list. A `device` target never boots anything.
2. **Discovery.** List real devices with `xcrun devicectl list devices` (Xcode 15 and later, which covers USB and network devices, and needs no usbmuxd client and no tunnel daemon). `devicectl` writes JSON to a file, so the runner uses a temporary file the way `IosSimulator.screenshot` does. Verify the exact flags with `xcrun devicectl --help`. `device_list` then reports phones next to simulators.
3. **Lifecycle.** `install` is `xcrun devicectl device install app --device <UDID> <path>`. `launch` and `terminate` can go through WebDriverAgent (its `/session` call with a `bundleId` capability already launches the app, and WebDriverAgent has app launch, terminate and state endpoints), or through `devicectl device process launch`. `terminate` over `devicectl` needs a process id from `devicectl device info processes`. Choose WebDriverAgent first, because it adds no new subprocess call. `app_list` over `devicectl device info apps`. Which endpoints a given WebDriverAgent tag has is what the probe in 10.1 and 10.3 shows.
4. **Screenshot.** `IosXcuiDriver.screenshot` uses `simctl`. For a phone it must use WebDriverAgent's `GET /session/:id/screenshot`. `WdaClient.screenshot()` already exists and returns base64 PNG, and nothing calls it.
5. **Deep links.** `simctl openurl` has no phone equivalent in the client. Use a WebDriverAgent deep link call or `devicectl device process launch` with a payload URL. Verify which the pinned tag has.
6. **The error text.** `WdaUnreachableError` names a simulator destination in its fix. A device target needs its own text that mentions the phone's address, the lock state and the runner.
7. **Pinch. Resolved.** `WdaClient.pinch` posted to `/session/:id/element/:id/pinch`. The first real-device run (10.10) showed that WebDriverAgent v16.15.3 answers that path with "unknown command" and serves the pinch under `/wda/element/:id/pinch`. The client now posts there, with the same `scale` and `velocity` body, and the keystone's stand-in refuses the old path the way the real build does.
8. **Posture.** `native-device` already gates the engine, and its threat-model row says the same code path aimed at a real device reaches the operator's phone. A device target needs its own loud warning naming the phone, a threat-model row, and the tool reference and README lines that say real devices are out of scope updated to say what is and is not evidenced. The lane uses a dedicated test phone with no personal data on it.

None of this needs a new dependency. GPL-3.0 `pymobiledevice3` stays excluded. The unneeded options are `go-ios` and `appium-ios-remotexpc`, which matter only for a USB path with usbmux forwarding, and the owner chose a network phone.

### 10.6 Keystone adaptation

The current keystone, `test/keystone/ios-app.keystone.test.ts`, has three describes. Against a real WebDriverAgent each one changes like this.

| Current describe                             | Today (stand-in)                                                                                                                                                                               | Against a real WebDriverAgent                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `native-device` gate                     | Refuses without the capability. Needs no device.                                                                                                                                               | Unchanged, and runs everywhere.                                                                                                                                 |
| Real simulator lifecycle through `simctl`    | Lists, boots, launches Settings, takes a PNG, terminates, on a real simulator.                                                                                                                 | On a phone the same assertions go through the device lifecycle of 10.5 (list contains the device, launch reports a running app, a PNG of real size, terminate). |
| The tool surface over a faked WebDriverAgent | A fixed tree with a button named `checkout-submit` labelled "Pay now". Asserts `app://` url, snapshot text, `[ref=eN]`, a tap at a moved position, a PNG from `simctl`, a swipe, two refusals. | The fixture assertions go. The stand-in's tree, its coordinates and its recorded taps cannot exist on a real screen. The next table lists the replacements.     |

| Stand-in assertion                                            | Real replacement                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot contains `Pay now` and `checkout-submit`             | Snapshot of the Settings app contains a known visible label such as "General" (the phone's language must be English), a role mapped from a real `XCUIElementType`, and at least one `[ref=eN]`. Identifier assertions need an app with identifiers. System Settings does not promise any, so a later phase adds a small fixture app signed with the team. |
| Re-resolution: move the button, tap lands at the new position | Tap a row, then reuse the old ref and expect a `stale-element` refusal. Count of matches above one is a refusal. The stand-in answers every `/element` query with one id, so neither case was reachable.                                                                                                                                                  |
| The server records taps and the test checks coordinates       | Check the effect: the snapshot after a tap on "General" shows "About".                                                                                                                                                                                                                                                                                    |
| `/session` reply shape, `/status`, `/source` envelope         | Passes only if the real reply matches what `WdaClient` unwraps. This is the main thing a real run proves.                                                                                                                                                                                                                                                 |
| Screenshot is a real `simctl` frame                           | The frame comes from WebDriverAgent. Assert the PNG signature and that its pixel size is a whole multiple of the root element's rect.                                                                                                                                                                                                                     |
| `gesture_swipe` ok, two CDP-deep refusals                     | Same. Add a `gesture_pinch` call, which the stand-in never exercised.                                                                                                                                                                                                                                                                                     |
| Not covered                                                   | A find for a missing identifier returns no match. `app_foreground` reports the app's bundle id from `activeAppInfo`. The time of one `snapshot` over the network is recorded, since the dump cost is an open question in this RFC.                                                                                                                        |

The device describe is gated on an environment variable that names the WebDriverAgent address and the app, and skips when it is unset, the way the simulator describe skips without Xcode. It never runs in CI.

### 10.7 Recording evidence

After a run, copy a block like this into the PR or the release notes, then copy the first line of facts into the engine evidence table row for `ios-app` with its date. The table is updated by hand, per [`docs/ai-context/release-process/engine-evidence.md`](../ai-context/release-process/engine-evidence.md).

```
ios-app evidence
date:            YYYY-MM-DD
target:          simulator | device (wireless)
iOS version:     26.x (build NNNNN)
device model:    iPhone17,x marketing name, or the simulator device type
macOS:           26.x
Xcode:           26.x (build NNNNN)
WebDriverAgent:  <WDA_TAG> at <WDA_COMMIT>
browxai:         <version> at <BROWXAI_COMMIT>
what ran:        probe, shell-route drive, keystone describe names
result:          the tools that passed, the tools that failed with their error
snapshot time:   median and worst of N snapshots, in ms
notes:           anything the stand-in got wrong
```

The block carries no UDID, no device name, no address, no team id and no screenshot of a personal screen.

### 10.8 Failure modes

| Symptom                                                          | Cause                                                                                                                                                                         | What to do                                                                                                                                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xcodebuild` says the profile has expired, or no profile matches | Provisioning profiles for an organization team last one year. A free Personal Team lasts seven days. The Apple Development certificate also lasts one year.                   | Run `build` again with `-allowProvisioningUpdates`. Put the renewal date in the owner's calendar. The Developer ID certificate in RFC 0012 is separate and lasts five years. |
| The runner starts and stops at once, or the test fails to launch | The phone is locked or asleep                                                                                                                                                 | Unlock it, set Auto-Lock to Never, run again.                                                                                                                                |
| Xcode says Developer Mode is disabled                            | The switch is off, or the phone was restored                                                                                                                                  | Turn it on in Settings, Privacy and Security, restart, confirm.                                                                                                              |
| `wda-unreachable` from browxai, or `curl` to the phone times out | The runner is not running, the phone's address changed, the Mac and phone are on different subnets, a VPN on the Mac, or Local Network is off for the program making the call | Check the `ServerURLHere` line, ping the phone, check System Settings, Privacy and Security, Local Network, turn the VPN off.                                                |
| The phone drops out of `devicectl list devices` after a while    | Wireless debugging lapsed: the phone slept, changed network, or Wi-Fi power-saving                                                                                            | Reconnect once by cable, tick Connect via network again.                                                                                                                     |
| Build fails on a new Xcode or iOS release                        | WebDriverAgent is tied to Xcode and iOS versions (this RFC's maintenance warning)                                                                                             | Move `<WDA_TAG>` to a newer release and record the new tag.                                                                                                                  |
| "Untrusted developer" on the phone                               | The team's development certificate is not trusted yet                                                                                                                         | Settings, General, VPN and Device Management, trust it.                                                                                                                      |
| `snapshot` takes seconds, or times out at 30 seconds             | A deep tree over Wi-Fi. `defaultHttp` times out at 30 s.                                                                                                                      | Record the time. The dump cost is an open question above, and the number goes into the evidence block.                                                                       |
| A second session fails                                           | One XCUITest runner owns the phone at a time                                                                                                                                  | Stop the other `xcodebuild` run.                                                                                                                                             |

### 10.9 Done

The lane is done when the evidence table's `ios-app` row has a date, an iOS version and a WebDriverAgent tag from a real run, the README's "unproven" wording changes to match, and every shape mismatch the probe found is fixed or written down. The Simulator run in 10.1 can reach that for the Simulator half first. The device half waits for the code PR in 10.5.

### 10.10 First real-device run (2026-11-24)

The first run of `scripts/ios/wda-run.sh probe` against a real WebDriverAgent, with no mocks. It used the evidence block of 10.7.

```
ios-app evidence
date:            2026-11-24
target:          device (wireless)
iOS version:     27.2
device model:    iPhone18,5 (iPhone 17e)
Xcode:           26.5
WebDriverAgent:  v16.15.3 (appium/WebDriverAgent), automatic signing, Apple Developer Program organization team
what ran:        scripts/ios/wda-run.sh probe
result:          every endpoint below answered as listed, one route corrected (pinch)
```

WebDriverAgent was built with automatic signing for the organization team, with the runner target's bundle id under the owner's own prefix. The Mac reached the phone over the local network.

| Call                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /status`                                                          | 200. The value has `build`, `os`, `device`, `ios`, `message`, `state` and `ready`.                                                                                                                                                                                                                                                                                                                         |
| `POST /session`                                                        | 200. A session id came back.                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /session/:id/source?format=json`                                  | 200. Nodes carry `customActions`, `nativeFrame`, `label`, `rawIdentifier`, `traits`, `frame`, `isVisible`, `type`, `value`, `isEnabled`, `children`, `isAccessible`, `isNativeAccessibilityElement`, `isFocused`, `name`, `rect` and `placeholderValue`. `rawIdentifier` is present on some nodes. `isVisible` arrives as the strings `0` and `1`. The root type is `Application`, with 12 distinct types. |
| `GET /session/:id/screenshot`                                          | 200. The value is a base64 string.                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /session/:id/wda/activeAppInfo`                                   | 200. The value has `processArguments`, `name`, `pid` and `bundleId`.                                                                                                                                                                                                                                                                                                                                       |
| `POST /session/:id/element`, accessibility id, an id that is not there | 404. The error has `error`, `message` and `traceback`.                                                                                                                                                                                                                                                                                                                                                     |
| `POST /session/:id/element`, class name for the application            | 200.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DELETE /session/:id`                                                  | 200.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /session/:id/element/:id/pinch`                                  | 404, "unknown command". This build does not serve the route.                                                                                                                                                                                                                                                                                                                                               |
| `POST /session/:id/wda/element/:id/pinch`                              | 404, "stale element reference", for an element id that does not exist. The route exists.                                                                                                                                                                                                                                                                                                                   |

**What it proves.** WebDriverAgent builds, signs, runs and answers on a real iPhone over the local network, and it answers every endpoint the engine reads. The fields `toNativeTree` reads are in the phone's source dump, including `rawIdentifier` on some nodes and `isVisible` as the strings `0` and `1`, which the unit tests already cover. The pinch route was wrong, and the first run found it. Pinch is fixed (10.5, item 7), and the stand-in in the keystone now serves the real route only.

**What it does not prove.**

- The engine has not run against the phone. Device selection, install and launch still use `simctl`, so `open_session` cannot target a phone. That is the follow-up code PR in 10.5.
- The probe sends fake element ids for the pinch and for the missing-identifier find, so no gesture ran and the error code of the missing-identifier 404 is a shape check only.
- The keystone was not run against this WebDriverAgent. It still uses its stand-in server.
- One phone, one iOS release and one WebDriverAgent tag. The snapshot time for a real screen is not recorded yet.

## Honest limits

**What this will not do.**

- **No real devices in v1.** Simulators and emulators only. Real devices need signing, provisioning and, with some third-party tools on iOS 17 and later, a sudo-privileged tunnel daemon. That is a separate phase with a separate security review. Section 10 plans it as a manual evidence lane that uses only Xcode's own tools, so no tunnel daemon is involved.
- **No network interception.** There is no protocol-level tap on a native app without a system proxy or a VPN profile, and installing either is the operator's decision, which browxai never makes on their behalf. `network_read`, `network_body` and `route` refuse, through the same no-op substrate shape Safari uses.
- **No DOM stream, so no rrweb-class replay.** Native evidence is video plus hierarchy keyframes plus the action log. A reviewer can see what happened and inspect the tree at each action boundary. Scrubbing to an arbitrary instant between two actions shows the video frame and the previous keyframe, and there is nothing to interpolate.
- **One UiAutomation owner per Android device.** A browxai native session cannot coexist with another UiAutomator client on the same device: a second driver, an Espresso run, a manual `uiautomator dump`, or an accessibility service that grabs the connection. Sessions claim the device under an RFC 0005-style lease keyed on the serial, and a second claim gets a structured refusal naming the holder. There is no way to share.
- **No JS evaluation.** `eval_js` and `poll_eval` refuse on native.
- **Xcode and the Android SDK are operator-supplied.** Never bundled, never auto-installed, mirroring the credentials-provider posture.

**What is uncertain.**

- **Hierarchy dump cost.** A UiAutomator dump is hundreds of milliseconds and an XCUITest full-tree snapshot can take seconds on a deep tree. The trial asks for a diff after every action, and two dumps per action at second-scale latency changes what a session costs. Bounded tree depth and a diff-on-demand mode are the likely mitigations, and neither is designed until the numbers are measured on the two target apps.
- **Driver integration shape.** Embedding Appium drivers as libraries, running an Appium server as a child process, or speaking directly to the UiAutomator2 server and WebDriverAgent are all viable and carry different failure modes. Unresolved.
- **The apps' own testID coverage.** browxai cannot make an element addressable that the app never labelled. If the two target apps are thin on testIDs, the selector model degrades to labels and index paths, which is the failure mode the trial found in `mobile-mcp`. A `find_feedback`-style report naming unaddressable elements turns that into a fixable list for the app team, and it should ship with P2.
- **iOS lane stability.** WebDriverAgent is coupled to Xcode versions and simulator runtimes, and that coupling breaks on OS updates. Budget for it as maintenance.

## Open questions

- Does the native stage ship as a player plugin panel through the RFC 0007 `registerPanel` API, or as a first-class stage beside the DOM replay? The plugin route proves the extension API on a real consumer, which has value beyond this RFC.
- Hybrid contexts. The shipped `android` engine already drives WebViews over CDP. Whether one session can hold a native context and a CDP context at once, the way Appium's context switch does, is unresolved and affects the session model.
- Multi-app flows: share sheets, system permission dialogs, OAuth through a system browser. One session spanning several processes needs a rule for what the snapshot returns when the app under test is not frontmost.
- Should `navigate` carry deep links, or is a separate `app_open_url` clearer? Generalising keeps the vocabulary small and overloads a tool whose name implies an address bar.
- Flow files (RFC 0006) over native sessions. A recorded native flow is a plausible compile target, and nothing in this design forecloses it, but the locator stability contract that RFC 0006 lists as prerequisite 2 means something different when the selector is a testID.
