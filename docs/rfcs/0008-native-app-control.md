# RFC 0008: Native app control (iOS simulator and Android emulator as engines)

**Date:** 2026-09-15
**Status:** Draft. Design only, nothing built.
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

Real devices are out of scope for v1. Simulators and emulators only. §Honest limits says why.

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
| Secret scoping                   | `src/page/actions-secrets.ts:29`                       | `ctx.secrets.materialize(raw, ctx.page.url())`. Scope is a URL substring check. A native screen has no URL.                                                                                                                        |
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

`registerEngine` works as-is. The `EngineEntry` record (`src/engine/registry.ts:101-135`) asks for a kind, a capability row, a launch function, a substrate bundle and a post-wire step. A native adapter supplies all five, and `src/engine/adapters/safari.engine.ts` is the 58-line template.

Five type changes, each one line or close to it.

1. **`EngineKind` gains `"ios-app"` and `"android-app"`** (`src/engine/types.ts:25`, plus `ENGINE_KINDS` at `:27-33` and the mirror list in `eslint.config.js`). The existing `android` kind keeps its meaning: real Chrome on a real phone over adb and CDP. Two names that both say "android" is a documentation cost, and renaming a shipped engine kind is a breaking config change, so the new kind takes the qualifier.

2. **`BrowserSession.page()` becomes optional** (`src/session/types.ts:120`): `page?(): Page`. The `page` sub-interface at `src/engine/types.ts:61-67` is already the declared discriminator; this makes the type agree with it. Safari stops throwing from a method it declares, and every call site that reads `session.page()` gets a compile error pointing at a real decision. That error set is the true cost of this RFC's first phase and it should be measured before P1 is sized as medium.

3. **`SubstrateCapableSession.page` becomes optional** (`src/page/snapshot-substrate-select.ts:27-32`), and the selector keys on handle presence instead of the engine literal at `:44`. The engine-owned `makeSubstrates` path (`src/page/substrate-bundle-safari.ts`) already bypasses this file for Safari; native follows the same route and the legacy selector stops accumulating literals.

4. **A native session handle, mirroring `safari?()`**: `native?(): NativeSessionHandle` on `BrowserSession` (`src/session/types.ts:136`). The handle carries a driver client, a device id, an app id, and the platform. Its substrate bundle reads it, exactly as the Safari bundle reads `e.session.safari!()`.

5. **`SecretRegistry.materialize(value, pageUrl)` renames its second parameter to a scope context** (`src/util/secrets.ts:126`). The check is already a case-insensitive substring containment, so passing `app://com.acme.app/CheckoutScreen` works without touching the logic. §6 says why this matters.

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

Scope binding works through the renamed second parameter (§1.5): a secret registered with `scope: "com.acme.app"` refuses to materialise into a different app's session, using the same substring containment check the URL path uses.

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

| Phase | Scope                                                                                                            | Rough size                      |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| P1    | Port widening: optional `page()`, the native handle, the gesture and touch substrate, the deep-flag retirement   | medium, with an unmeasured tail |
| P2    | Android emulator engine: adapter, hierarchy walker into the snapshot substrate, action substrate, selector model | large                           |
| P3    | Capture: native event types, segmented video, the manifest device row, secret masking on hierarchy dumps         | medium                          |
| P4    | iOS simulator engine over XCUITest                                                                               | large                           |
| P5    | Player: a native stage drawing hierarchy keyframes, video segments and touch overlays                            | medium                          |
| P6    | CI lanes, build caching, the capability and threat-model docs pass                                               | medium                          |

P1's tail is the compile-error set from making `page()` optional. Every call site that reads it becomes a decision, and the count is unknown until someone flips the type. Measure it before committing P1 to a sprint.

P2 before P4 because Android's plumbing is adb and a device-side server, which is inspectable and cheap to iterate against, while iOS adds WebDriverAgent signing and simulator boot latency to every debug cycle. P3 after P2 so the capture path is designed against a real hierarchy. P5 last because §4 shows the existing player already opens a native archive with reduced fidelity, so the stage is an upgrade with no blocking dependents.

## Honest limits

**What this will not do.**

- **No real devices in v1.** Simulators and emulators only. Real devices need signing, provisioning and, on iOS 17 and later, a sudo-privileged tunnel daemon. That is a separate phase with a separate security review.
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
