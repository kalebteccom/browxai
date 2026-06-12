# XPC as the Path to Automating REAL Safari — Feasibility Report for browxai (BYOB-attach-first)

**Date:** 2026-06-13 · **Author:** Deep-research lane (Claude Code) · **Scope:** Can browxai attach to the user's *real, logged-in* Safari on macOS the way it attaches to Chrome? What is the XPC surface, who is allowed to speak it, and what is the realistic ranked strategy?

**Evidence base:** Apple developer docs + WebKit source (`Source/JavaScriptCore/inspector/remote`, `Source/WebKit/UIProcess/Automation`, `Source/WebDriver`), WebKit blog (Apple WebKit team), WebKit Bugzilla, `safaridriver(1)` man page, Apple Developer Forums (Quinn "The Eskimo!" / DTS), pymobiledevice3 + ios-webkit-debug-proxy source, GitHub prior art, and **read-only inspection of this Mac** (macOS platform identifier 26, June 2026). Local-machine findings are marked **`[LOCAL]`** and are authoritative for this OS version. Inference (not a single quotable Apple sentence) is marked **`[INFERENCE]`**.

---

## TL;DR verdict

- **WebDriver automation in Safari is literally the Remote Web Inspector protocol with an `Automation` target type, brokered by the `webinspectord` daemon over the `com.apple.webinspector` Mach/XPC service.** It is not a separate channel.
- **The broker is entitlement-gated to Apple-signed clients.** `safaridriver` carries the Apple-private entitlement **`com.apple.private.webinspector.driver-client`** **`[LOCAL]`**; `webinspectord` is itself an Apple platform binary that validates the connecting client. A notarized third-party (even Developer ID + hardened runtime) **cannot legitimately carry `com.apple.private.*`** — CoreTrust/AMFI only honor those on Apple platform code, and there is **no provisioning profile that allowlists them**. **browxai cannot re-implement `safaridriver` and speak to the user's Safari.**
- **Even if you could speak it, WebDriver gives you the wrong browser:** Safari hard-isolates automation into a clean, ephemeral window with **separate windows, tabs, preferences, and persistent storage** — **no cookies, no localStorage, no Keychain/AutoFill, no history** from the user's real profile. WebDriver structurally cannot do BYOB.
- **The only Apple-supported channels that touch the user's REAL logged-in Safari are: (a) AppleScript/Apple Events `do JavaScript` (eval-only, real page context) and (b) a Safari Web Extension + native companion (DOM read/write of real tabs).** Both are strictly less capable than CDP; neither does protocol-level network interception or closed-shadow-DOM without help.
- **WebDriver BiDi has NOT shipped in Safari as of June 2026** (Apple position "support"; ~113 open WebKit BiDi bugs; experimental only in the Linux WebKitGTK port). It will not change the BYOB picture even when it lands, because the isolation model is security-driven.

---

## 1. How `safaridriver` actually talks to Safari

### 1.1 Binary layout `[LOCAL]`
- `safaridriver` is a symlink: `/usr/bin/safaridriver → /System/Cryptexes/App/usr/bin/safaridriver` — it ships **inside the Safari cryptex**, not the base OS.
- `codesign -dvvv`: `Identifier=com.apple.safaridriver`, `flags=0x2000(library-validation)`, `Authority=Software Signing` → `Apple Code Signing Certification Authority` → `Apple Root CA`, **`TeamIdentifier=not set`** (i.e. an Apple platform binary, `Platform identifier=26`).
- `safaridriver` is a thin CLI; the real engine is the closed `WebDriver.framework` (PrivateFramework) it loads. The man page describes it as "an HTTP server that implements the Selenium WebDriver REST API … using the version of Safari that is installed with macOS," localhost-only, **one session at a time** (`man safaridriver` `[LOCAL]`; W3C WebDriver: https://www.w3.org/TR/webdriver/).

### 1.2 The mediator is `webinspectord` (this is the key finding)
The driver and Safari rendezvous through the **Web Inspector relay daemon**, not a bespoke "WebDriver host." From WebKit's wire-protocol constants (`Source/JavaScriptCore/inspector/remote/RemoteInspectorConstants.h`):
```
#define WIRXPCMachPortName            "com.apple.webinspector"
#define WIRRemoteInspectorDomainName  CFSTR("com.apple.webinspectord")
#define WIRRemoteAutomationEnabledNotification "com.apple.webinspectord.remote_automation_enabled"
```
Source: https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/remote/RemoteInspectorConstants.h
The header comments that `WIR*` constants are *"'Web Inspector Relay' constants shared between the WebInspector framework on the OS X side, `webinspectord`, and iOS WebKit on the device side."* The Cocoa relay connects with `xpc_connection_create_mach_service(WIRXPCMachPortName, …)` in `Source/JavaScriptCore/inspector/remote/cocoa/RemoteInspectorCocoa.mm` (https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/remote/cocoa/RemoteInspectorCocoa.mm).

**`[LOCAL]` confirmation of the daemon:**
- `launchctl print gui/501/com.apple.webinspectord` → `type = LaunchAgent`, `state = not running` (on-demand), `program = /System/Cryptexes/App/usr/libexec/webinspectord`, `path = /System/Volumes/Preboot/Cryptexes/App/System/Library/LaunchAgents/com.apple.webinspectord.plist`.
- `plutil -p` of that plist:
  ```
  "Label"        => "com.apple.webinspectord"
  "MachServices" => { "com.apple.webinspector" => true,
                      "com.apple.webinspector.debugger" => true }
  "Program"      => "/System/Cryptexes/App/usr/libexec/webinspectord"
  "ProcessType"  => "Adaptive"  "EnableTransactions" => true
  ```
- `webinspectord` itself: `codesign` → `Identifier=com.apple.webinspectord`, `library-validation`, Apple `Software Signing`, `TeamIdentifier=not set` (platform binary), and its **only** entitlement is `com.apple.private.webinspector.webinspectord = true`.

**End-to-end flow (macOS):**
1. Safari registers with `webinspectord` as a `RemoteInspector` and — when automation is allowed — advertises an **automation target** (listing type `WIRTypeAutomation`, `WIRAutomationAvailabilityKey = WIRAutomationAvailabilityAvailable`).
2. `safaridriver` / `WebDriver.framework` connects to `webinspectord` as the **driver/controlling client** (gated by `com.apple.private.webinspector.driver-client`) and requests a session.
3. `webinspectord` relays `WIRAutomationSessionRequestMessage` (carrying `WIRSessionCapabilitiesKey`) to Safari; Safari's `RemoteInspector::receivedAutomationSessionRequestMessage()` calls `m_client->requestAutomationSession(...)`.
4. Safari creates a `WebAutomationSession` (UIProcess) and an isolated Automation window; WebDriver commands then travel driver ⇄ `webinspectord` ⇄ Safari as Inspector-protocol `Automation.*` messages.

The open-source ports (WebKitGTK/WPE) make this explicit: `Source/WebDriver/SessionHost.h` (connects to the inspector server, exchanges automation messages, `Inspector::RemoteInspectorConnectionClient`) + `Source/WebDriver/WebDriverService.cpp` are the open analogue of Apple's closed `WebDriver.framework`, and WebKitGTK's `RemoteInspectorServer` is the analogue of `webinspectord` (https://github.com/WebKit/WebKit/blob/main/Source/WebDriver/SessionHost.h).

### 1.3 WebDriver automation **is** the inspector protocol
Unambiguous in source. `RemoteControllableTarget::Type` enumerates target kinds and **`Automation` is one of them**, peer to `WebPage`/`JavaScript`/`ServiceWorker`:
```cpp
enum class Type { Automation, ITML, JavaScript, LegacyWebPage,
                  ServiceWorker, WasmDebugger, WebPage };
```
Source: https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/remote/RemoteControllableTarget.h
- `WebAutomationSession` (`Source/WebKit/UIProcess/Automation/WebAutomationSession.h`) implements `Inspector::AutomationBackendDispatcherHandler` and drives the same `FrontendRouter`/`BackendDispatcher` plumbing Web Inspector uses; its `Debuggable` nested class is an `Inspector::RemoteAutomationTarget`.
- The command surface is the inspector-protocol domain **`Automation`** (`Source/WebKit/UIProcess/Automation/Automation.json`): *"Automation domain exposes commands for automating user interactions with the browser"* — `createBrowsingContext`, `navigateBrowsingContext`, `performMouseInteraction`, `evaluateJavaScriptFunction`, `takeScreenshot`, etc. (https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/Automation/Automation.json).
- Apple WebKit blog confirms the work lands in WebKit's process layers: *"the low-level details of performing most of these commands are delegated to **WebAutomationSession and related classes in WebKit's UIProcess and WebProcess layers**."* (https://webkit.org/blog/6900/webdriver-support-in-safari-10/).

**Bottom line:** Safari WebDriver = Remote Web Inspector protocol + an `Automation` target type, multiplexed through `webinspectord`. The W3C/REST surface is just a front-end `WebDriver.framework` translates into `Automation.*`.

### 1.4 What "Allow Remote Automation" / `--enable` actually toggles
- Man page `[LOCAL]`: `--enable` *"Applies configuration changes so that subsequent WebDriver sessions will run without further authentication. This includes checking 'Enable Remote Automation' in Safari's Develop menu. The user must authenticate via password."*
- Mechanically it flips `RemoteInspector::Client::Capabilities.remoteAutomationAllowed`. In `RemoteInspectorCocoa.mm`, target listings set `WIRAutomationAvailabilityKey` from that flag, and incoming session requests are **dropped unless the flag is set** — both listing publication and `WIRAutomationSessionRequestMessage` acceptance are gated on it. Darwin notifications: `com.apple.webinspectord.remote_automation_enabled` / `…_disabled` (`RemoteInspectorConstants.h`).
- Storage: a `com.apple.WebDriver` defaults domain (man page DIAGNOSTICS references the `DiagnosticsEnabled` default in `com.apple.WebDriver`). `--enable` also installs a macOS authorization right so future sessions skip the password prompt. Enabling "Remote Automation" forces "Web Inspector" on (https://discussions.apple.com/thread/253026968).

### 1.5 Entitlements `safaridriver` carries `[LOCAL]` — and can a third party speak this?
`codesign -d --entitlements - /usr/bin/safaridriver`:
```xml
com.apple.private.security.storage.WebDriver  = true
com.apple.private.webinspector.driver-client  = true
keychain-access-groups = [ com.apple.webinspector ]
```
Safari.app side `[LOCAL]` (relevant subset): `com.apple.private.security.storage.WebDriver`, `com.apple.private.webinspector.remote-inspection-debugger`, `com.apple.security.temporary-exception.apple-events`, Mach-lookup global-name exceptions for `com.apple.webinspector` / `com.apple.webinspector.debugger` / `com.apple.WebInspector` / `com.apple.WebDriver`, a `com.apple.safari.develop-menu` sandbox extension (usbmuxd + `com.apple.webinspectord_sim.socket` for iOS/sim hosting), and file paths under `/Library/WebDriver/`.

What each gates:
- **`com.apple.private.webinspector.driver-client`** — authorizes a process to connect to `webinspectord` **as the controlling automation/driver client** (the side that sends `WIRAutomationSessionRequestMessage`). This is the load-bearing gate.
- **`com.apple.private.security.storage.WebDriver`** — a data-vault storage class isolating WebDriver state under `~/Library/WebDriver` (backs the clean-slate guarantee, §1.6).
- **`keychain-access-groups = com.apple.webinspector`** — shares the inspector/pairing keychain group.

**Can a third party broker this? No, not for stock Safari `[INFERENCE]` (strong).** `com.apple.private.*` are Apple-private: honored only on platform/trust-cached code; `amfid` and CoreTrust reject a re-signed third-party binary that claims them, and there is no provisioning profile that allowlists them (see §3). `webinspectord` independently validates the connecting client. So to automate the real stock Safari you must go through Apple-signed `safaridriver` / `WebDriver.framework`; you cannot legitimately re-implement the driver and have it talk to the user's Safari. (Strong inference from the AMFI private-entitlement model + the daemon's gatekeeper role, not a single quotable Apple sentence.)

### 1.6 Session isolation — what is shared vs isolated (the BYOB killer)
Apple/WebKit are explicit that automation is isolated, ephemeral, and walled off from the real profile:
- *"Test execution is confined to special **Automation windows that are isolated from normal browsing windows, user settings, and preferences**,"* and *"tests are not affected by a previous test session's persistent state such as **local storage or cookies**."* (https://webkit.org/blog/6900/webdriver-support-in-safari-10/)
- *"Safari … isolates WebDriver tests by using a **separate set of windows, tabs, preferences, and persistent storage**,"* and *"WebDriver tests that run in an Automation window always **start from a clean slate and cannot access Safari's normal browsing history, AutoFill data, or other sensitive information**."* (https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/)
- Safari installs a **"glass pane"** over the Automation window; stray user input prompts to end the session (machine effectively unusable during automation).
- `[LOCAL]` backing: the dedicated `com.apple.private.security.storage.WebDriver` storage class + sandbox paths `/Library/WebDriver` give automation its own store, separate from the user's `Library/Safari`/`Library/Cookies`.

**Net:** cookies, localStorage, history, AutoFill/Keychain passwords, and preferences are **not** shared into a WebDriver session. Every browxai tool family that depends on the user's logged-in state (the entire BYOB thesis) is unreachable via safaridriver.

---

## 2. The Web Inspector XPC channel (`webinspectord` / `com.apple.webinspector`)

### 2.1 Topology and the two protocol layers
Three-party relay: **inspected WebKit process ⇄ `webinspectord` (relay) ⇄ Web Inspector frontend / driver** (true on both macOS-local and iOS). Two distinct protocol layers:
1. **Outer = RWI / "Web Inspector Relay" transport** — a plist/XPC envelope multiplexing many target connections. Message types (`RemoteInspectorConstants.h`): `WIRSocketSetupMessage`, `WIRSocketDataMessage`, `WIRListingMessage`, `WIRAutomationSessionRequestMessage`, `WIRConnectionDiedMessage`, … Keys: `WIRMessageDataKey`, `WIRSocketDataKey`, `WIRConnectionIdentifierKey`, `WIRTargetIdentifierKey`, `WIRApplicationIdentifierKey`, `WIRPageIdentifierKey`.
2. **Inner = the actual JSON Inspector wire protocol** — the `Inspector.*`, `Runtime.*`, `Page.*`, `DOM.*`, `Console.*`, `Heap.*` domains (the one **Playwright's patched WebKit speaks**), carried as an **opaque UTF-8 payload inside `WIRMessageDataKey`** over a data socket set up by `WIRSocketSetupMessage`. In `RemoteInspectorCocoa.mm`, `receivedSetupMessage()` creates the `RemoteConnectionToTarget` and `receivedDataMessage()` routes the JSON to it.

RWI = dumb pipe + discovery/listing + session lifecycle; the JSON inspector protocol rides inside it. The cross-platform core (`RemoteInspector.h`) keeps a `HashMap<TargetID, RemoteControllableTarget*>`; the transport is pluggable: **Cocoa** uses `RemoteInspectorXPCConnection` over the `com.apple.webinspector` Mach service; **GTK/WPE** uses sockets/`RemoteInspectorServer` (https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/remote/RemoteInspector.h).

### 2.2 Gates: `isInspectable`, the entitlements `webinspectord` checks, and lockdown
- **Per-target opt-in `isInspectable` (default `false`) since macOS 13.3 / iOS 16.4 / Safari 16.4** for `WKWebView` and `JSContext` (https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/). Previously only dev-provisioned (`get-task-allow`) apps were inspectable.
- **`webinspectord` is the enforcement point.** A target is inspectable if it carries one of `com.apple.security.get-task-allow`, `com.apple.webinspector.allow`, `com.apple.private.webinspector.allow-remote-inspection`, `com.apple.private.webinspector.allow-carrier-remote-inspection` — evidenced by the jailbreak tweak `ChiChou/GlobalWebInspect`, which *"injects to `webinspectord` to bypass the entitlement check"* (https://github.com/ChiChou/GlobalWebInspect). Daemon description: *"webinspectord relays commands between Web Inspector and targets … such as WKWebView and JSContext instances"* and contains an app-allowlist `-[RWIRelayDelegateMac _allowApplication:bundleIdentifier:]` (https://macosbin.com/bin/webinspectord).
- **`com.apple.webinspector.allow` is restricted and effectively un-grantable** to third parties — Apple DTS (Quinn): *"AFAICT it's a restricted entitlement … I can't see any way to create a profile with that in its allowlist,"* and misuse crashes at launch with "Unsatisfied entitlements: com.apple.webinspector.allow"; the official replacement is `isInspectable` (https://developer.apple.com/forums/thread/745027).
- **Access is sandbox-gated:** `canAccessWebInspectorMachPort()` calls `sandbox_check(getpid(), "mach-lookup", … WIRXPCMachPortName)` (`RemoteInspectorCocoa.mm`).
- **Lockdown verdict:** progressively closed — private `com.apple.private.webinspector.*` (Apple-signed only), restricted un-grantable `com.apple.webinspector.allow`, `isInspectable` off-by-default, sandbox Mach gate, and SIP blocking the iOS-style inject-into-`webinspectord` bypass on macOS.

### 2.3 pymobiledevice3 `webinspector` — the modern reference (iOS)
Source: `pymobiledevice3/services/webinspector.py`, `.../web_protocol/inspector_session.py`, `cli/webinspector.py` (https://github.com/doronz88/pymobiledevice3/blob/master/pymobiledevice3/cli/webinspector.py; DeepWiki 8.1/8.2).
- Resolves **two service names**: `com.apple.webinspector` over `LockdownClient` (USB/TCP, pre-iOS-17) and **`com.apple.webinspector.shim.remote`** over **RSD/CoreDevice** (iOS 17+ tunnel).
- RWI RPC selectors: `_rpc_reportIdentifier:`, `_rpc_getConnectedApplications:`, `_rpc_forwardGetListing:`, `_rpc_forwardAutomationSessionRequest:`, `_rpc_forwardSocketSetup:`, `_rpc_forwardSocketData:`.
- **Capabilities against iOS Safari:** JS eval via `InspectorSession.runtime_evaluate` (`Runtime.evaluate`, with `Runtime.enable`/`Console.enable`/`Heap.*`); list tabs (`webinspector opened-tabs`); navigate/open URL (`webinspector launch <url>`); interactive WebView REPL (`shell`, `js-shell`); **a built-in CDP server** (`webinspector cdp --host 127.0.0.1 --port 9222`) — the modern equivalent of ios-webkit-debug-proxy.
- **Requirements:** Web Inspector toggle ON (Settings → Safari → Advanced); does **not** require the Remote Automation toggle; **trusted USB pairing** via usbmuxd/lockdown; **iOS 17+ requires a RemoteXPC tunnel** (QUIC + RemoteXPC, RSD handshake on port 58783, TUN/TAP → **root/sudo**; `sudo pymobiledevice3 remote start-tunnel` / `lockdown start-tunnel`); Developer Mode (iOS 16+) effectively required for the tunnel. Refs: https://github.com/doronz88/pymobiledevice3/blob/master/misc/RemoteXPC.md, https://github.com/doronz88/pymobiledevice3/blob/master/docs/guides/ios17-tunnels.md.

### 2.4 History: ios-webkit-debug-proxy + remotedebug-ios-webkit-adapter
- **ios-webkit-debug-proxy**: bridges iOS Safari's WIR protocol to a DevTools HTTP/WebSocket front over usbmuxd (`:9221` device list, `:9222` tabs, `ws://…/devtools/page/N`); 4-byte length-prefixed plist framing with `WIRPartialMessageKey`/`WIRFinalMessageKey` chunking (https://github.com/google/ios-webkit-debug-proxy). Decayed: WebKit↔CDP protocol drift, empty inspectable-pages list on newer iOS, lockdown failures.
- **remotedebug-ios-webkit-adapter**: CDP↔WebKit protocol adapter; **archived ~2021** (https://github.com/RemoteDebug/remotedebug-ios-webkit-adapter). Successor for modern iOS: pymobiledevice3 `cdp` or commercial **inspect.dev**.
- **2026 status:** iwdp + adapter work for **iOS ≤ 16** (lockdown path). **iOS 17+ broke it** — secure services require the trusted RemoteXPC tunnel and `com.apple.webinspector` is reached as `com.apple.webinspector.shim.remote`; iwdp doesn't implement the tunnel, so the community points at pymobiledevice3 (https://docs.hex-rays.com/user-guide/debugger/debugger-tutorials/ios_debugging_coredevice).

### 2.5 The macOS-LOCAL analogue — can a third party JS-eval the user's real Safari tabs? **No.**
The plumbing is identical in shape locally (`webinspectord` vends `com.apple.webinspector`; WebKit content processes push `WIRListingMessage`s; Safari's Web Inspector is the host). What blocks a third-party host process from enumerating + attaching:
1. **Private/restricted entitlements** — driving the relay as a host/inspector requires Apple-private `com.apple.private.webinspector.*` (Safari, Web Inspector, `safaridriver`) or the restricted, un-grantable `com.apple.webinspector.allow`.
2. **Sandbox / hardened runtime** — `sandbox_check("mach-lookup", "com.apple.webinspector")`; App Sandbox blocks global Mach lookups without a temporary-exception entitlement.
3. **SIP** — protects the Apple daemon; the iOS inject-to-bypass trick isn't available.
4. **Target opt-in** — third-party WebViews need `isInspectable=true` (default off). Safari opts its own WebContent in, which is why the Develop menu works — but that path is internal to Apple-signed Safari/`webinspectord`.

This is exactly why **Playwright ships its own patched WebKit** rather than attaching to the user's Safari. The one public RE that reaches it — **`zwo/patch_webinspect`** — patches the WebInspector framework **in memory** (`_allowApplication:bundleIdentifier:` opcode `84 C0` → `84 DB`), and requires **SIP disabled**, `sudo`, per-macOS-version offsets, and re-patching on every Safari relaunch (https://github.com/zwo/patch_webinspect). Not shippable.

---

## 3. The public XPC API and the code-signing gate

### 3.1 Client side: discoverability
- Modern API: `XPCSession(machService:)` (macOS 14+) "Establishes a connection to a launch agent or launch daemon with the name you specify" (https://developer.apple.com/documentation/xpc/xpcsession). C API: `xpc_connection_create_mach_service` (+ `XPC_CONNECTION_MACH_SERVICE_PRIVILEGED` for the global/root namespace).
- **You cannot ad-hoc register a service name** — *"any service name that the job wishes to listen on must be declared in its launchd.plist(5),"* else `XPC_ERROR_CONNECTION_INVALID` (Quinn, https://developer.apple.com/forums/thread/717439). Connectability also depends on bootstrap namespace (LaunchDaemon = global; LaunchAgent = per-user/session — and `[LOCAL]` `com.apple.webinspectord` is a **LaunchAgent** in `gui/501`). A sandboxed client additionally needs `com.apple.security.temporary-exception.mach-lookup.global-name`.

### 3.2 Service side: peer validation (the real gate)
Apple's repeated DTS guidance — validate by code-signing requirement, let the OS do it:
- `SecCodeCreateWithXPCMessage` (macOS 11+), then **`xpc_connection_set_peer_code_signing_requirement`** (macOS 12+), `-[NSXPCConnection setCodeSigningRequirement:]` (13+), and **`xpc_connection_set_peer_lightweight_code_requirement`** (LWCR, macOS 14.4+). Quinn: *"think of it as checking the requirement against the calling process. This is a code signing operation"* (https://developer.apple.com/forums/thread/773573, https://developer.apple.com/forums/thread/681053).
- LWCR semantics: the OS checks the peer **every message**; a failing peer's messages are dropped and you get **`XPC_ERROR_PEER_CODE_SIGNING_REQUIREMENT`**. Helper requirements: `xpc_connection_set_peer_team_identity_requirement`, `…platform_identity_requirement`, `…entitlement_exists_requirement`.

### 3.3 Why `com.apple.private.*` is off-limits to third parties
- Quinn (DTS): *"this is a restricted entitlement … There's no way for a third-party developer to get a profile that authorises an Apple private entitlement"* (https://developer.apple.com/forums/thread/756747). TN3125: restricted entitlements *"must be authorized by a provisioning profile … The entitlements in the profile act as an allowlist"* (https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles).
- Enforcement: **CoreTrust/AMFI**. Platform/trust-cached Apple binaries may possess any entitlement; non-platform (notarized Developer ID) binaries are constrained to their profile's allowlist (TheAppleWiki CoreTrust; newosxbook). Claiming an unauthorized `com.apple.private.*` either fails restricted-entitlement validation ("Unsatisfied entitlements" launch failure) or is stripped/ignored at runtime.
- The only route to get private entitlements honored on non-Apple code was a parser bug — **CVE-2022-42855 (DER "psychic paper")** — which Apple patched, i.e. treated as a vulnerability (https://projectzero.google/2023/01/der-entitlements-brief-return-of.html). **Hardened runtime + Developer ID + notarization do NOT change this** — they govern signing posture, not who may hold restricted/private entitlements.

### 3.4 Two gates, restated
- **Gate 1 (lookup):** can the name resolve in your bootstrap namespace (and sandbox allow it)? Apple daemon names generally pass for everyone.
- **Gate 2 (acceptance):** does the service's peer-requirement check accept your signature/entitlements? Apple daemons slam this on non-Apple callers. **"I can see the service" never implies "I can use the service."**
- **For `com.apple.webinspector` specifically:** browxai cannot present `com.apple.webinspector.allow` (restricted, un-grantable) or `com.apple.private.webinspector.driver-client` (private). The supported lever is `isInspectable` **on targets you control** — useless for the user's Safari.
- **The legitimate managed-entitlement pattern exists but not for this:** e.g. EndpointSecurity's `com.apple.developer.endpoint-security.client` is a *requestable* (Apple-approved) entitlement. There is **no equivalent requestable entitlement for Web Inspector / WebDriver brokering.**

### 3.5 Notarized-dev-tool realistic assessment
A notarized Developer-ID tool (hardened runtime, not App Store) can talk to **its own** Team-ID-pinned helper, and to a few **requestable** Apple capabilities — but **cannot** connect to `webinspectord`/`com.apple.webinspector` as a privileged inspector/driver, because both the private entitlement (CoreTrust/AMFI) and the daemon's peer validation block it. This is categorical, not a matter of effort.

---

## 4. Adjacent legitimate Safari channels (ranked for BYOB real-Safari)

### Rank 1 — AppleScript / Apple Events `do JavaScript` (the only eval channel into REAL tabs)
- **Capability:** `tell application "Safari" … do JavaScript "…" in document N` runs **arbitrary JS in the live page context of the user's real, logged-in tab** — full same-origin DOM read/write, can read authenticated content, click, fill, read `document.cookie`. Plus tab/window enumeration and `URL` get/set, and `document`'s `source` (HTML) / `text` (rendered) (Apple Mac Automation Scripting Guide: https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/).
- **Ceiling:** page-context JS sandbox only — no privileged browser API, no protocol-level network interception, **closed shadow DOM is invisible**, **strict CSP blocks injected JS**, per-document.
- **Permission/UX:** two gates — (a) Develop-menu **"Allow JavaScript from Apple Events"** (off by default; in Safari 17+ under Settings → Advanced → "Show features for web developers" → Developer; the old `defaults write` trick no longer works), and (b) **TCC Automation** ("\<App\> wants to control Safari"); a hardened/sandboxed sender needs `com.apple.security.automation.apple-events` + `NSAppleEventsUsageDescription` (Apple QA1888). One-time, two prompts.
- **Stability/policy:** supported in 2026 Safari (the toggle is in Apple's 2026 Safari Developer Tools docs), but a mature "legacy" surface with periodic OS-update regressions (e.g. NSAppleScript-of-Safari breakage in a 15.4 beta, https://developer.apple.com/forums/thread/759287). Low Apple-policy risk (documented feature), moderate maintenance risk (regressions).

### Rank 2 — Safari Web Extension + native companion (DOM read/write of REAL tabs, durable)
- **Capability:** content scripts read/modify the DOM of the user's real (logged-in) tabs via standard `browser.*`; native messaging via `browser.runtime.sendNativeMessage` to a `SafariWebExtensionHandler` (`NSExtensionRequestHandling`).
- **Ceiling / key restriction:** in Safari the extension **can only message its own container app** (not an arbitrary external daemon) — bridge shape is content script ↔ background ↔ SafariWebExtensionHandler ↔ (your daemon via app-group/socket/XPC) (https://developer.apple.com/documentation/SafariServices/messaging-a-web-extension-s-native-app). **Network interception is weak**: no blocking `webRequest` with non-persistent background pages; only `declarativeNetRequest` (Safari requires `regexFilter`) (https://github.com/w3c/webextensions/issues/151).
- **Permission/UX (ongoing):** user enables the extension, then grants **per-site** access ("This extension would be able to read and alter webpages … including passwords, phone numbers, and credit cards"); **no one-click "all websites."** This recurring friction is the main cost.
- **Distribution:** must ship inside a macOS app; production = App Store **or** Developer-ID-notarized outside the App Store (viable ~Safari 18.4+). "Allow Unsigned Extensions" is dev/beta only.
- **Stability/policy:** Apple's actively-developed, future-facing path (Safari 26 added Web Extension improvements). Lowest long-term maintenance risk; highest build/distribution friction; low policy risk.

### Rank 3 — macOS Accessibility (AX) API + CGEvent (last-resort input/read)
- **Capability:** read Safari's web content via the AX tree (`AXWebArea`, `AXLink…`), synthesize input via `CGEventPost`.
- **Ceiling:** **no whole-tree read API** (element-by-element traversal, slow on big pages); trees mutate on rerender; roles/actions are untyped strings (heuristic matching); exposes the rendered/accessible surface, **not the DOM, cookies, or hidden state**; coordinate clicks are fragile (https://developer.apple.com/documentation/applicationservices/axuielement).
- **Permission/UX:** one **Accessibility** TCC grant (`AXIsProcessTrustedWithOptions`); posting events also needs the post-event grant.
- **Stability/policy:** decades-old API but TCC tightened across recent macOS; App Store scrutinizes `CGEvent.post`. Highest brittleness — genuine fallback.

### Rank 4 (for BYOB) — safaridriver / WebDriver Classic (+ BiDi future)
- **Best protocol, wrong browser for BYOB.** Clean W3C automation, but the **isolated automation session** means none of the user's real state is present (§1.6). It is the right tool for *sanctioned* Safari automation, not attach-to-real.
- **WebDriver BiDi: not shipped in Safari as of June 2026.** Apple/WebKit standards-position "support" (https://github.com/WebKit/standards-positions/issues/240); **~113 open `[WebDriver][BiDi]` WebKit bugs, all NEW**, activity through Apr 2026 (https://bugs.webkit.org/buglist.cgi?quicksearch=%5BWebDriver%5D%5BBiDi%5D); enabled only experimentally in **WebKitGTK** (Igalia-driven, https://blogs.igalia.com/webkit/blog/2025/wip-33/); absent from Safari 26 / STP notes. No public ship date, and no indication BiDi would relax the isolation model.

---

## 5. Prior art (real-Safari automation/inspection)

| Project | Mechanism | Real logged-in Safari? | 2026 status |
|---|---|---|---|
| **Playwright "WebKit"** | Patched WebKit build, inspector protocol to *its own* binary | **No** — a different browser, not Safari | Works, but never the user's Safari (https://playwright.dev/docs/browsers) |
| **Selenium Safari** | Wraps `/usr/bin/safaridriver` (W3C) | No — isolated session | Alive; legacy `.safariextz` driver dead (https://www.selenium.dev/documentation/webdriver/browsers/safari/) |
| **Appium safari-driver** | Proxy over `safaridriver` | No — isolated session | Alive (https://github.com/appium/appium-safari-driver) |
| **Appium iOS web context** | XCUITest (WDA) + **ios-webkit-debug-proxy** (WebKit debugger) for DOM | iOS device Safari (not desktop) | Alive |
| **ios-webkit-debug-proxy / remotedebug-adapter** | iOS `com.apple.webinspector` over usbmuxd → CDP/WS | iOS only | iwdp ≤ iOS 16; adapter archived 2021; succeeded by pymobiledevice3 / inspect.dev |
| **pymobiledevice3 `webinspector`** | RWI over lockdown / RemoteXPC; JS eval, tabs, CDP server | iOS device Safari | **Alive — modern iOS reference** |
| **safari-mcp (achiya-automation)** | **AppleScript `do JavaScript`** (80 tools) + optional Safari Web Extension on `localhost:9224` + Swift helper daemon | **Yes — real, logged-in Safari** | **Alive — the key real-desktop-Safari MCP prior art** (https://github.com/achiya-automation/safari-mcp) |
| **zwo/patch_webinspect** | In-memory patch of WebInspector `_allowApplication:` to inspect any app's WKWebView | Yes, but **SIP off**, non-persistent, per-version | RE only; not shippable (https://github.com/zwo/patch_webinspect) |
| **BrowserStack / Sauce "real Safari"** | Real cloud devices driven via safaridriver/Appium | Real Safari, isolated session, *their* devices | Alive |
| **SafariWatir, legacy `.safariextz`** | AppleScript / old Selenium extension | — | Dead |

**The unmet niche (directly relevant to browxai):** there is **no supported, entitlement-clean way to attach a CDP/inspector-style tool to the user's real desktop macOS Safari.** The only ways to touch the real logged-in desktop profile are **AppleScript JS injection** or a **Safari Web Extension** — both strictly less capable than CDP, both unable to do protocol-level network interception or closed-shadow-DOM without help. `safari-mcp` is the existence proof of the realistic product shape (AppleScript engine + optional extension), and it validates the limits we derived independently.

---

## 6. Synthesis for browxai — ranked feasibility for "BYOB real-Safari"

Tool families: **read/snapshot · act · eval · network · storage**. Legend: ✅ full · 🟡 partial/with-help · ❌ none/blocked.

| Channel | read / snapshot | act (click/type) | eval (JS) | network (intercept/read) | storage (cookies/LS) | Real profile? | Operator friction | Stability risk | Apple-policy risk |
|---|---|---|---|---|---|---|---|---|---|
| **AppleScript `do JavaScript`** | 🟡 (DOM-derived; no a11y tree; closed shadow DOM blind; CSP blind) | 🟡 (synthesize DOM events; framework inputs need hacks) | ✅ (real page context) | ❌ (no protocol intercept) | 🟡 (read/set via JS: `document.cookie`, `localStorage`; httpOnly cookies invisible) | **✅ YES** | Low (2 one-time prompts: Apple-Events JS toggle + TCC Automation) | Medium (periodic OS regressions) | Low (documented feature) |
| **Safari Web Extension + native companion** | ✅ (content-script DOM, MAIN world) | ✅ (real DOM events in page) | ✅ (content script / `scripting`) | 🟡 (`declarativeNetRequest` only, regexFilter; **no blocking webRequest**) | 🟡 (`cookies`/storage APIs per granted host) | **✅ YES** | Medium-High (enable + **per-site** grants; no "all sites") | Low (actively developed) | Low-Medium (App Store/Dev-ID notarization, review) |
| **AX API + CGEvent** | 🟡 (AXWebArea tree; slow, lossy) | 🟡 (synthetic OS input; coordinate-fragile) | ❌ | ❌ | ❌ | ✅ YES (UI only) | Low (1 Accessibility TCC grant) | High (brittle; TCC tightening) | Medium (CGEvent.post review scrutiny) |
| **safaridriver / WebDriver Classic** | ✅ | ✅ | ✅ | 🟡 (limited; no full intercept pre-BiDi) | ✅ (but session-local) | **❌ NO (isolated session)** | Medium (`--enable` admin auth) | Low (stable) | Low (sanctioned) |
| **WebDriver BiDi (Safari)** | ✅ (when shipped) | ✅ | ✅ | ✅ (events/intercept, when shipped) | ✅ (session-local) | **❌ NO (expected isolated)** | n/a | **Not shipped (June 2026)** | Low |
| **Direct `webinspectord` / `com.apple.webinspector`** | ✅ (full CDP-grade *if* connected) | ✅ | ✅ | ✅ | ✅ | Yes *if* connected | — | — | **❌ BLOCKED — private entitlement `com.apple.private.webinspector.driver-client`; CoreTrust/AMFI + peer validation** |
| **`patch_webinspect` (SIP off)** | ✅ | ✅ | ✅ | ✅ | ✅ | Yes | **Extreme (disable SIP, sudo, re-patch per launch)** | Extreme (per-version offsets) | **❌ Not shippable** |

### Recommended Safari strategy shape (tiered)

1. **Tier A — Sanctioned automation lane: `safaridriver` (WebDriver Classic now; adopt BiDi when Safari ships it).** Use for *non-BYOB* Safari work where a clean, ephemeral session is acceptable (cross-browser testing, scripted flows that bring their own login). Honest in product copy: this is **not** the user's profile. Track WebKit BiDi bugs; BiDi will upgrade network/event coverage but **not** unlock BYOB.

2. **Tier B — TRUE-BYOB reads/eval lane: AppleScript / Apple Events `do JavaScript` companion.** This is the **only** Apple-supported way to read and `eval` in the user's real, logged-in tabs. Map browxai's `read/snapshot`, `eval`, light `act`, and JS-visible `storage` here. Accept the ceiling: no protocol network intercept, closed-shadow-DOM/CSP blind, httpOnly cookies invisible. Friction is a one-time 2-prompt setup. `safari-mcp` proves this shape works.

3. **Tier C — DEEP-BYOB lane: Safari Web Extension + native companion (browxai bridge).** When Tier B's ceiling bites (CSP pages, MAIN-world isolation, reliable `act`, per-site storage), ship a notarized (Developer-ID, Safari 18.4+) extension that bridges content script ↔ container app ↔ browxai daemon. Best fidelity into real tabs; cost is per-site permission UX and app distribution. Still **no blocking `webRequest`** — network is `declarativeNetRequest`-shaped.

4. **Tier D — Fallback input lane: Accessibility + CGEvent.** Only for native chrome / file dialogs / things page JS can't reach. Keep minimal.

5. **Explicitly do NOT pursue:** re-implementing `safaridriver` or connecting to `webinspectord`/`com.apple.webinspector` directly. It requires Apple-private entitlements that CoreTrust/AMFI will not honor on third-party code and that no provisioning profile allowlists; the daemon independently validates the peer. The only "direct inspector" route (`patch_webinspect`) needs SIP disabled and is non-shippable.

### Net positioning vs the Chrome story
browxai's Chrome BYOB rides CDP into the user's real browser. **Safari has no equivalent open door.** The realistic BYOB-real-Safari product is a **two-engine companion** (AppleScript eval for reads/eval + a Safari Web Extension for deep DOM/act), with `safaridriver`/BiDi reserved for the sanctioned, *non-BYOB* automation lane. Set capability expectations accordingly: real-Safari BYOB will be **eval+DOM-grade, not CDP-grade** — in particular, **protocol-level network interception and closed-shadow-DOM access are not available** on real Safari without Apple shipping new API.

---

## Open uncertainties (flagged)
1. **`driver-client` exclusivity** — that *only* Apple-signed binaries can hold `com.apple.private.webinspector.driver-client` and broker automation is strong inference from the AMFI private-entitlement model + the daemon's gatekeeper role, not a single quotable Apple sentence. The closed `WebDriver.framework` handshake wasn't disassembled.
2. **`webinspectord` client-side check specifics** — the exact per-version entitlement strings / acceptance logic are RE/community-sourced (GlobalWebInspect, macosbin), not Apple-documented.
3. **AppleScript `do JavaScript` cookie reach** — `document.cookie` exposes non-httpOnly cookies only; full cookie/storage export is not available via this channel. (Asserted from the page-JS sandbox model.)
4. **Future Safari BiDi isolation** — no Apple statement on whether BiDi would ever attach to a real profile; given the security rationale, assume the same isolated-window model.

## Key sources
- WebKit source: `RemoteInspectorConstants.h`, `RemoteInspectorCocoa.mm`, `RemoteInspector.h`, `RemoteControllableTarget.h`, `WebAutomationSession.h`, `Automation.json`, `Source/WebDriver/{SessionHost.h,WebDriverService.cpp}` — https://github.com/WebKit/WebKit
- WebKit blog: https://webkit.org/blog/6900/webdriver-support-in-safari-10/ · https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/ · https://webkit.org/blog/13936/enabling-the-inspection-of-web-content-in-apps/
- WebKit BiDi: https://github.com/WebKit/standards-positions/issues/240 · https://bugs.webkit.org/buglist.cgi?quicksearch=%5BWebDriver%5D%5BBiDi%5D
- Apple XPC / signing: https://developer.apple.com/documentation/xpc/xpcsession · https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles · Quinn DTS forums 681053, 773573, 717439, 756747, **745027**
- pymobiledevice3: https://github.com/doronz88/pymobiledevice3 (webinspector CLI, RemoteXPC.md, ios17-tunnels.md)
- ios-webkit-debug-proxy: https://github.com/google/ios-webkit-debug-proxy · GlobalWebInspect: https://github.com/ChiChou/GlobalWebInspect · patch_webinspect: https://github.com/zwo/patch_webinspect
- Adjacent channels: Apple Mac Automation Scripting Guide; https://developer.apple.com/documentation/SafariServices/messaging-a-web-extension-s-native-app; https://developer.apple.com/documentation/applicationservices/axuielement; QA1888
- Prior art: https://playwright.dev/docs/browsers · https://www.selenium.dev/documentation/webdriver/browsers/safari/ · https://github.com/appium/appium-safari-driver · https://github.com/achiya-automation/safari-mcp
- **`[LOCAL]`** (macOS, platform id 26, 2026-06): `man safaridriver`; `codesign -d --entitlements` of safaridriver / Safari.app / webinspectord; `launchctl print gui/501/com.apple.webinspectord`; `plutil -p` of `com.apple.webinspectord.plist`.
