# RFC 0014: The `ios-app` engine on a real iPhone

**Date:** 2026-11-26
**Status:** Proposed, awaiting reviewer sign-off. Design only. No code, build or test is part of this change.
**Trigger:** [RFC 0008](0008-native-app-control.md) section 10.5 lists the code a device lane needs and leaves it to a later PR. Roadmap item 7 names that PR as the next step. This RFC is the spec for it, written for sign-off before anything is built.

## What this is for

The `ios-app` engine drives an app on the iOS Simulator. This RFC specifies the change that lets the same engine drive an app on one physical iPhone that the operator named in the server's environment.

The change is small in code and large in reach. A simulator is a sandbox on the Mac. A phone holds accounts, messages, payment methods and a keychain. Most of this RFC is about what the engine refuses to do on a phone.

## Measured facts

Measured on 2026-11-24 against a real iPhone 17e on iOS 27.2, with WebDriverAgent v16.15.3 and Xcode 26.5, over the local network. The full table is in RFC 0008 section 10.10.

- WebDriverAgent builds with automatic signing for an Apple Developer Program organization team and runs on the phone.
- It serves on the phone's own local network address, port 8100.
- Every endpoint the engine reads answered: `/status`, `POST /session`, `/source?format=json`, `/screenshot`, `/wda/activeAppInfo` and the element find.
- `/status` returned a value with `build`, `os`, `device`, `ios`, `message`, `state` and `ready`.
- The engine did not run against the phone. Only the probe in `scripts/ios/wda-run.sh` did.

## What the code does today

Read from `src/` at the commit this branch starts from.

| Step                             | Where                                                                                     | How                                                                                                                   | Works on a phone |
| -------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Read the launch settings         | `iosEnvFrom` in `src/engine/adapters/ios-app.engine.ts`                                   | `BROWX_IOS_DEVICE`, `BROWX_IOS_APP_ID`, `BROWX_IOS_APP_PATH`, `BROWX_IOS_WDA_URL`. `open_session` has no native field | yes              |
| Pick a device                    | `resolveSimulator`, `selectDevice` in `ios/simulator.ts` and `ios/simctl.ts`              | `simctl list devices --json`, iOS simulator rows only. With nothing requested it picks a booted simulator             | no               |
| Boot                             | `IosSimulator.boot`                                                                       | `simctl boot` then `simctl bootstatus -b`                                                                             | no               |
| Install                          | `IosSimulator.install`, also `IosLifecycle.install` for `app_install`                     | `simctl install`                                                                                                      | no               |
| Launch and terminate             | `IosSimulator.launch`, `terminate`, also `IosLifecycle` for `app_launch`, `app_terminate` | `simctl launch`, `simctl terminate`                                                                                   | no               |
| List apps                        | `IosSimulator.listApps` for `app_list`                                                    | `simctl listapps`, parsed from a property list                                                                        | no               |
| Screenshot                       | `IosXcuiDriver.screenshot`                                                                | `simctl io screenshot` to a temporary file. `WdaClient.screenshot()` exists and has no caller                         | no               |
| Deep link                        | `IosXcuiDriver.openUrl`, reached from `iosNavigate` in `src/page/ios-actions.ts`          | `simctl openurl`                                                                                                      | no               |
| Hierarchy, find, input, gestures | `WdaClient` in `ios/wda-client.ts`                                                        | HTTP to `BROWX_IOS_WDA_URL` (default `http://127.0.0.1:8100`) with `fetch`, 30 s timeout                              | yes              |
| Frontmost app                    | `WdaClient.activeAppInfo`                                                                 | HTTP                                                                                                                  | yes              |
| Close                            | the `close` closure in `launchIosSession`                                                 | deletes the WebDriverAgent session, then `simctl terminate`                                                           | half             |
| `device_list`                    | `src/tools/native-device-tools.ts`                                                        | `listSimulators()` for iOS. Phones are absent                                                                         | no               |

Four more facts shape the design.

- `IosXcuiDriver` and `IosLifecycle` take an `IosSimulator` in their constructors. The class is the seam, and it is concrete.
- The `android-app` engine keeps a lease table keyed on a device serial. The `ios-app` engine has no lease table.
- `app_uninstall` and `app_reset` refuse on `ios-app` with `NativeUnsupportedError`.
- `browxai doctor` has no iOS row. The injectable runner this RFC reuses is `CommandRunner` in `src/cli/doctor-macos-app.ts`: one program, an argument list, no shell, a 10 s limit.

The `navigate` tool calls `confirmNavigation` before any engine sees a URL. With no `BROWX_ALLOWED_ORIGINS` list, `isOriginAllowed` allows every URL, deep links included.

## Scope

In scope: one physical iPhone, reached over the local network, with a WebDriverAgent the operator already built, signed and started.

Out of scope:

- Building, signing or starting WebDriverAgent. The engine never runs `xcodebuild`. Section "Who starts WebDriverAgent" says why.
- USB port forwarding. The owner chose a network phone (RFC 0008 section 10).
- CI. The device lane stays a manual run on one Mac.
- Android phones. The `android-app` engine is not changed here.
- Real devices as a supported surface. The roadmap's "not planned" entry stands. This engine path exists so one evidence lane can run.

## 1. Choosing simulator or device

**The target is server configuration.** A new variable, `BROWX_IOS_TARGET`, takes `simulator` or `device`. Unset means `simulator`, and every existing setup behaves as it does today.

`open_session` gets no new argument in this RFC. Three reasons:

1. `BROWX_IOS_WDA_URL` is one value for the process. One WebDriverAgent serves one device. A per-session target would need a per-session WebDriverAgent address, app id and allowlist to go with it.
2. The agent calls `open_session`. A target argument would let the agent move a session from a sandbox to a phone. With an environment variable only the operator can do that.
3. `open_session` already has a `device` field, which is a Playwright preset name for browser sessions. RFC 0008 section 2 proposed a `native: {...}` option for both native engines and neither engine has built it. A wire change on the stable tool surface belongs in its own RFC.

Decision D1 asks the reviewer to confirm this. If the reviewer wants an argument, the rule is that the environment sets the widest target and an argument can only select `simulator` under a `device` ceiling.

**The new variables stay out of the config store.** `set_config` is an MCP tool, so the agent can call it, and `<workspace>/config.json` outlives a session. None of the variables in this RFC becomes a config-store key. If a later change adds one, `src/util/config-ceiling.ts` must bound it so a saved layer can only narrow it.

**One iOS target per server process.** A process started with `BROWX_IOS_TARGET=device` opens device sessions only. A second `ios-app` session in the same process refuses through a lease (section 6).

With `device`, a launch never boots anything and never calls `simctl`.

## 2. Device discovery and identity

Discovery uses Xcode's CoreDevice tool, `xcrun devicectl`, which ships with Xcode 15 and later. It lists cabled and network devices and needs no usbmuxd client and no tunnel daemon run by browxai.

**Command.** `xcrun devicectl list devices --json-output <file>`. `devicectl` writes JSON to a file, so the runner creates a temporary directory outside the workspace, reads the file and deletes the directory, the way `IosSimulator.screenshot` does today. Verify on a Mac: the flag name `--json-output`, and whether `--timeout <seconds>` is accepted on `list devices`.

**Fields the parser reads.** All field names below are from memory of Xcode 15 and 16 output. Verify every one on a Mac with Xcode 26.5, and save one masked sample as a test fixture.

| Field (verify on a Mac)                           | Meaning                                                           | Use                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `result.devices[].identifier`                     | CoreDevice identifier, a UUID that CoreDevice assigns on this Mac | The identity the allowlist matches                            |
| `hardwareProperties.udid`                         | The hardware UDID, the id `xcodebuild -destination id=` takes     | Accepted in the allowlist as a second form. Never printed     |
| `hardwareProperties.platform`, `deviceType`       | `iOS`, `iPhone`                                                   | Drop everything that is not an iPhone or iPad running iOS     |
| `hardwareProperties.productType`, `marketingName` | Model, for example `iPhone18,5`                                   | Shown in `device_list`, doctor and the evidence block         |
| `deviceProperties.osVersionNumber`                | iOS version                                                       | Shown, and compared with WebDriverAgent's `/status`           |
| `deviceProperties.name`                           | The name the owner gave the phone, which is often a person's name | Read by nothing. The parser drops it                          |
| `deviceProperties.developerModeStatus`            | `enabled` or `disabled`                                           | Gate. `disabled` refuses with `ios-device-developer-mode-off` |
| `deviceProperties.ddiServicesAvailable`           | Whether the developer disk image services are up                  | Doctor row. Install and launch need them                      |
| `connectionProperties.pairingState`               | `paired` or `unpaired`                                            | Gate. Covers the Trust prompt                                 |
| `connectionProperties.tunnelState`                | `connected`, `disconnected` or `unavailable`                      | Gate. Only `connected` proceeds                               |
| `connectionProperties.transportType`              | `wired` or `localNetwork`                                         | Shown. Both are accepted                                      |

**Stable identifier and hardware UDID.** The CoreDevice identifier is stable for a paired phone on one Mac and differs from the hardware UDID. Verify on a Mac that it survives an unpair and a new pairing. If it does not, the allowlist entry changes after a new pairing, which is acceptable for one phone and is written into the runbook. The allowlist accepts either form because `scripts/ios/wda-run.sh` already takes the hardware UDID and an operator has it at hand.

**Identity rules.**

- A match is an exact string match on the identifier or the hardware UDID. A device name never matches. `selectDevice` matches a simulator by name today, and the device path does not copy that.
- `devicectl --device` also accepts a name, an ECID and a serial number. The engine passes the CoreDevice identifier only, after the allowlist check, as its own argv element.
- The engine never picks a phone because it is the only one connected. Section 6 has the allowlist.

**What `device_list` reports.** A new `iosDevices` array next to `simulators`. Each row has the identifier, the model, the iOS version, the pairing state, the tunnel state, the transport and the Developer Mode state. It lists allowlisted phones only. Other connected phones appear as one count, `iosDevicesNotAllowed`, with no identifier. With `BROWX_IOS_TARGET` unset the array is empty and `devicectl` is not run. No row carries a device name or a hardware UDID.

## 3. Mapping each simulator operation

| Operation              | Simulator today              | Device path                                                                                                | Status of the device command                                                                                            |
| ---------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| List devices           | `simctl list devices --json` | `devicectl list devices --json-output <file>`                                                              | Exists. Verify flag spelling                                                                                            |
| Boot                   | `simctl boot`, `bootstatus`  | None. A phone is on or it is not                                                                           | Not applicable                                                                                                          |
| Install                | `simctl install`             | `devicectl device install app --device <id> <path>`                                                        | Exists. Verify on a Mac. The only install route, since WebDriverAgent has none                                          |
| Launch at session open | `simctl launch`              | WebDriverAgent `POST /session` with `bundleId`, which `WdaClient.newSession` already sends                 | Measured: the call returned 200 with a session id. Verify that the app is frontmost afterwards                          |
| `app_launch`           | `simctl launch`              | WebDriverAgent `POST /session/:id/wda/apps/launch` with `bundleId`                                         | From WebDriverAgent's route list. Verify on v16.15.3 with the probe                                                     |
| `app_terminate`, close | `simctl terminate`           | WebDriverAgent `POST /session/:id/wda/apps/terminate` with `bundleId`                                      | Same. Verify                                                                                                            |
| Fallback launch        | none                         | `devicectl device process launch --device <id> <bundle-id>`                                                | Exists. Verify the `--terminate-existing` flag. Used only if the WebDriverAgent route is missing on the pinned tag      |
| Fallback terminate     | none                         | `devicectl device process terminate --device <id> --pid <pid>`, pid from `devicectl device info processes` | Verify both. Two subprocess calls, which is why WebDriverAgent goes first                                               |
| `app_list`             | `simctl listapps`            | `devicectl device info apps --device <id> --json-output <file>`                                            | Exists. Verify the JSON shape. The result is filtered to the app allowlist (section 6)                                  |
| Screenshot             | `simctl io screenshot`       | `WdaClient.screenshot()`, base64 PNG decoded to a `Buffer`                                                 | Measured: 200, a base64 string. `devicectl` has no screenshot command that I know of                                    |
| Deep link              | `simctl openurl`             | WebDriverAgent `POST /session/:id/url` with `url`                                                          | From WebDriverAgent's route list. Verify on v16.15.3, and note whether iOS shows an "Open in" prompt                    |
| Frontmost app          | WebDriverAgent               | WebDriverAgent, unchanged                                                                                  | Measured                                                                                                                |
| Lock state             | none                         | WebDriverAgent `GET /wda/locked`                                                                           | From WebDriverAgent's route list. Verify. `devicectl device info lockState` may also exist on Xcode 26, verify          |
| Device details         | none                         | `devicectl device info details --device <id>`                                                              | Verify. Doctor only                                                                                                     |
| Uninstall, reset       | refuse                       | refuse, same `NativeUnsupportedError`                                                                      | `devicectl device uninstall app` exists, and the engine does not call it. Removing an app from a phone deletes its data |

**Why lifecycle goes through WebDriverAgent.** It is the transport the 2026-11-24 run already evidenced, it adds no subprocess call, and a launch through it is visible to the same XCUITest session that reads the screen. `devicectl` stays for the two things WebDriverAgent cannot do: list devices and install.

**Why deep links go through WebDriverAgent `/url`.** Three routes exist.

1. WebDriverAgent `POST /session/:id/url`. One HTTP call on the transport already in use. The running app receives the URL the way it does from another app, so the app's state before the link is kept. Chosen.
2. `devicectl device process launch --payload-url <url> <bundle-id>`. It needs the bundle id that owns the scheme, and it launches the process, so a running app may restart and lose the state under test. Verify on a Mac that the flag exists. Kept as a documented fallback that the engine does not implement in the first slice.
3. Safari: open Safari, type the URL, tap the "Open" prompt. It needs Safari on the app allowlist, it drives a second app's UI, and the prompt text depends on the phone's language. Rejected.

If the probe shows `/url` missing or broken on the pinned tag, `navigate` refuses on a device with `ios-device-deeplink-unsupported` and names the tag. It does not fall back without a decision.

**Code shape.** No `engine === "..."` branch is added anywhere, and no file under `src/session/` learns about targets.

- `src/engine/adapters/ios/devicectl.ts`: pure argv builders and JSON parsers plus a runner type, the same split `simctl.ts` has.
- `src/engine/adapters/ios/device.ts`: `IosPhysicalDevice`, which holds the identifier, a `devicectl` runner and the `WdaClient`.
- A small interface, `IosDeviceHost`, with `install`, `launch`, `terminate`, `listApps`, `openUrl` and `screenshot`. `IosSimulator` already has all six. `IosXcuiDriver` and `IosLifecycle` take the interface in place of the class.
- `launchIosSession` reads `BROWX_IOS_TARGET` once and builds one host or the other. The simulator branch keeps its current order: resolve, boot, install, launch, attach.
- `NativeDeviceInfo` gains an optional `kind: "simulator" | "device"`.
- `WdaUnreachableError` gets a device variant. Its text names the phone's lock state, the runner and the Mac's Local Network setting, and it does not print the `xcodebuild` simulator line.

The device session order is: read settings, check the allowlists, `devicectl list devices`, check pairing, tunnel and Developer Mode, take the lease, `GET /status`, check the binding (section 5), optional install, `POST /session`, check that the frontmost app is the app under test.

## 4. Who starts WebDriverAgent

The operator does, with the runbook in RFC 0008 sections 10.3 and 10.4 and `scripts/ios/wda-run.sh`. The engine connects to `BROWX_IOS_WDA_URL` and does nothing else.

**The engine does not manage `xcodebuild test-without-building`.** That is out of scope, for these reasons:

- It needs a WebDriverAgent checkout, a derived data directory, a team id and a signing identity. Those are the operator's, and signing material does not belong in a browxai process.
- `xcodebuild` output prints a certificate name, a device name and a UDID. The script masks them. A managed child process would put them in the server's log.
- A long-lived child process is a daemon, and the owner decided against one for this lane.
- A session that can start the runner can also restart it after a person stopped it. Stopping the runner is the operator's off switch, and it has to stay off.

With `BROWX_IOS_TARGET=device`, `BROWX_IOS_WDA_URL` is required. The default `http://127.0.0.1:8100` is refused, because on a Mac it would reach a simulator's WebDriverAgent while `devicectl` installs onto the phone.

## 5. Binding the WebDriverAgent address to the allowlisted phone

`devicectl` identifies a phone by identifier. WebDriverAgent is identified by an address. Nothing ties the two together, so a wrong address could put taps on a different phone from the one that received the install. The engine checks three things at session open and refuses with `ios-device-wda-mismatch` when one fails.

1. `/status` must not report a simulator. Verify on a Mac which field says so. From memory it is `ios.simulatorVersion`, present on a simulator only.
2. The iOS version in `/status` (`os.version`, verify) must equal the version `devicectl` reported for the allowlisted phone.
3. After `POST /session`, the pid in `activeAppInfo` must appear for the same bundle id in `devicectl device info processes --device <id>`. Verify the JSON shape. This is the one check that ties the address to the phone, since a pid for the app under test on another phone would differ.

If check 3 cannot be built because the process list does not carry what it needs, the RFC falls back to checks 1 and 2 and the threat-model row says the binding is by configuration.

## 6. Capability posture and guard rails

### No new capability

`native-device` already gates this path, twice. `registerEngine` declares `requiresCapability: "native-device"` for `ios-app`, so `open_session` refuses without it. Each `device_*` and `app_*` tool also runs `gateCheck`. The device path adds no tool and no capability.

The capability alone does not open a phone. A device session needs three things the operator set in the environment: `native-device`, `BROWX_IOS_TARGET=device` and an allowlist with at least one phone. Granting `native-device` to a server that runs simulators changes nothing.

A second capability was considered (decision D2). It would give `capability-gate.test.ts` a second row and would not protect more than a required environment variable does, since both are operator settings that a saved config layer cannot widen.

### Installing onto a phone is gated at least as much as on a simulator

| Gate                                                                    | Simulator | Device                               |
| ----------------------------------------------------------------------- | --------- | ------------------------------------ |
| `native-device` at session creation and on `app_install`                | yes       | yes                                  |
| Bundle path resolves inside `$BROWX_WORKSPACE`, real path checked       | yes       | yes, same `resolveAppBundlePath`     |
| Path is one argv element, no shell                                      | yes       | yes                                  |
| Target and device named by the operator                                 | no        | yes                                  |
| Bundle id on the app allowlist, read from the bundle before the install | no        | yes                                  |
| Confirmation by a person                                                | no        | yes, by default (decision D4)        |
| Install count per session                                               | no        | yes                                  |
| The OS checks the signature and the provisioning profile                | no        | yes. browxai never signs or re-signs |

The bundle id comes from `Info.plist` inside the `.app`, read with `/usr/bin/plutil -extract CFBundleIdentifier raw` through the injectable runner. Verify on a Mac. The engine refuses a bundle whose id it cannot read.

### What an agent can reach on a phone that it cannot reach on a simulator

- **Data.** Photos, contacts, messages, mail, notes, health data, and the content of every installed app.
- **Accounts.** A signed-in Apple account, and whatever apps are logged in.
- **Money.** In-app purchases, App Store purchases, wallet cards, banking apps.
- **Speaking as the owner.** Sending a message, an email, a post or a call.
- **The device itself.** Settings, passcode, profiles, erasing content.
- **The screen as a read channel.** A screenshot or a hierarchy dump of the home screen shows notification text from any app.
- **Input reaches the frontmost app.** WebDriverAgent sends taps and keys to whatever is in front. `tap(x, y)` does not know which app it lands in.

The simulator has none of these, so the `native-device` row in the threat model was written for a sandbox. The guard rails below are for the phone.

### Guard rails

All of them apply only when `BROWX_IOS_TARGET=device`. Simulator behaviour does not change.

**G1. Device allowlist.** `BROWX_IOS_DEVICE_ALLOWLIST` is a comma-separated list of CoreDevice identifiers or hardware UDIDs. It is required. Empty or unset refuses with `ios-device-not-allowlisted`. `BROWX_IOS_DEVICE` then names one entry. With one entry on the list, `BROWX_IOS_DEVICE` may be left out, because the operator already named that phone. The engine never selects a phone from what `devicectl` happens to list.

**G2. App allowlist.** `BROWX_IOS_DEVICE_APPS` is a comma-separated list of exact bundle ids. `BROWX_IOS_APP_ID` must be on it. `app_launch`, `app_terminate`, `app_install` and the session's own launch all check it. `app_list` returns the intersection of the installed apps and the list, so the agent does not learn what else is on the phone. No wildcard and no prefix match.

**G3. Confirmation for an app off the list.** A new confirm hook, `native_device_app`, joins the four in `ConfirmHook`. It is on by default for a device target. A launch or install of a bundle id that is not on the list asks a person through the existing `await_human` confirm path. With no human channel the call refuses. `approve_actions` cannot grant this scope: the agent whose action the hook holds must not be the one that approves it, and `self-approval` was not written with a phone in mind. Decision D4 offers a stricter default, which is a flat refusal with no hook.

**G4. System apps.** A bundle id that starts with `com.apple.` refuses with `ios-device-system-app`, for launch, terminate and as the app under test. That covers Settings, Messages, Phone, Mail, Wallet, App Store and Safari. An operator who needs one lists it exactly in `BROWX_IOS_DEVICE_APPS`, and G3's confirmation still applies to it on every launch. The manual keystone needs Settings, so its runbook lists `com.apple.Preferences` on purpose, on a dedicated phone.

**G5. Foreground fence.** Before every input dispatch on a device (tap, type, set-value, swipe, pinch, button press) the driver reads `activeAppInfo` and compares the bundle id with the app allowlist. A frontmost app that is off the list refuses with `ios-device-foreground-not-allowed` and names the bundle id. The same check runs before `snapshot` and `screenshot`, so the home screen, another app and the lock screen are never read. The cost is one HTTP round trip per action. This fence is what stops a tap from landing in a messaging app after a share sheet or a notification moved focus.

The fence has known holes, and the threat-model row must state them:

- A notification banner drawn over an allowed app is in the screenshot and may be in the hierarchy.
- A system sheet shown inside the allowed app's process, such as a share sheet or a payment sheet, may report the allowed app as frontmost. Verify on a Mac which process owns a purchase sheet and a share sheet on iOS 27.
- The check and the tap are two calls. Focus can change between them.

**G6. System alerts.** A permission prompt belongs to SpringBoard. Under G5 the agent cannot tap it. By default the session reports `ios-device-foreground-not-allowed` and a person taps the prompt, or the operator pre-grants the permission. Decision D5 offers an opt-in that lets the engine tap alert buttons only.

**G7. Deep link schemes.** `navigate` on a device refuses any URL whose scheme is not in `BROWX_IOS_DEVICE_URL_SCHEMES`. Unset means every deep link refuses. On a phone `tel:`, `sms:`, `facetime:`, `mailto:`, `itms-apps:` and the settings schemes all leave the app under test, and several of them start a call or a message. `https` links stay under the existing origin policy and `confirmNavigation`, and they also need `https` on the scheme list.

**G8. Buttons.** `home`, `volumeUp` and `volumeDown` pass. After `home` the fence blocks input until an allowed app is launched again. The engine never calls WebDriverAgent's lock or unlock routes.

**G9. Never unlock.** The engine holds no passcode and sends none. A locked phone refuses with `ios-device-locked`. A registered secret is not a route around this, because secrets do not materialise on native engines today.

**G10. Rate limits.** The repository has no rate limiter today, so this is new code: counters on the session handle, in memory, with limits the operator can lower or raise in the environment. Proposed defaults: 5 installs per session, 30 launch or terminate calls per session, 20 deep links per session, 3,000 input actions per session, and at most 5 input actions per second. A call over a limit refuses with `ios-device-rate-limit` and names the limit. The numbers are a starting point for review (decision D6). They bound a runaway loop. They do not stop one wrong tap.

**G11. One session per phone.** A lease keyed on the device identifier, copied from the `android-app` engine's table. A second session refuses with `native-device-leased` and names the holder.

**G12. Uninstall and reset stay refused.** No change from today, with a device-specific sentence in the refusal.

**G13. A warning that names the target.** The `native-device` warning at server start gains a second line when the target is `device`: the model, the iOS version and the count of allowlisted apps. It never prints a device name. Each install, launch, terminate and deep link on a device is logged with the bundle id or the scheme.

**G14. Close does less.** Closing a device session deletes the WebDriverAgent session and terminates the app under test if it is on the allowlist. It does not stop WebDriverAgent and does not touch any other app.

### What the guard rails do not cover

- An allowed app can itself send a message, post, or buy something. If the app under test has a "Buy" button, the agent can tap it. Use a test account and a sandbox payment environment.
- WebDriverAgent has no authentication. While it runs, any machine on the same network can send it commands, with none of the guard rails above. browxai does not change that, and the threat-model row must say it. The runbook should say: a dedicated phone, a network the operator controls, and stop the runner when the session ends.
- Traffic between the Mac and the phone is plain HTTP. Screenshots and hierarchy dumps cross the local network unencrypted.
- A `.browx` archive or a saved screenshot from a device session holds whatever was on the screen.

The lane's standing rule from RFC 0008 stays: a dedicated test phone with no personal data and no personal Apple account. The guard rails are the second layer.

## 7. What `doctor` checks

`browxai doctor` gains an `ios-device` group. It appears only when `BROWX_IOS_TARGET=device` or the selected engine is `ios-app`. Every row is informational or a warning. None fails doctor. Rows use the `CommandRunner` type from `doctor-macos-app.ts` and an injectable HTTP function, so they unit-test with fakes.

| Row                  | Source                                                | Warn when                                                 |
| -------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `devicectl` present  | `xcrun devicectl --version`                           | missing, or Xcode older than 15                           |
| Allowlist            | `BROWX_IOS_DEVICE_ALLOWLIST`, `BROWX_IOS_DEVICE_APPS` | unset, empty, or `BROWX_IOS_APP_ID` not on the app list   |
| Device found         | `devicectl list devices`                              | no allowlisted phone listed                               |
| Trust                | `pairingState`                                        | not `paired`                                              |
| Tunnel               | `tunnelState`, `transportType`                        | not `connected`                                           |
| Developer Mode       | `developerModeStatus`                                 | not `enabled`                                             |
| Developer services   | `ddiServicesAvailable`                                | false                                                     |
| WebDriverAgent URL   | `GET <BROWX_IOS_WDA_URL>/status`, 3 s timeout         | unset, loopback, no answer, or `ready` is false           |
| WebDriverAgent build | `build` and `os` from `/status`                       | the iOS version differs from the one `devicectl` reported |
| Lock state           | `GET /wda/locked` (verify)                            | locked                                                    |

Doctor prints the model and the iOS version. It never prints a device name, a UDID or the phone's address. When the tunnel is connected and `/status` gets no answer, the fix line names the Mac's Local Network setting first.

Doctor cannot read the provisioning profile's expiry date, because the profile is inside the runner app on the phone and in the operator's derived data. The renewal date stays in the owner's calendar, as RFC 0008 section 10.8 says.

## 8. Local Network privacy

macOS 15 and later asks before a program connects to an address on the local network, and the grant belongs to the program that opened the connection. For browxai that program is the terminal, the MCP client, or the signed app from [RFC 0012](0012-signed-macos-app.md), whichever started the Node process. The engine's `fetch` to the phone fails with a transport error until the grant exists, and `WdaClient` reports that as `wda-unreachable`.

- The device variant of the error says to check System Settings, Privacy and Security, Local Network for the launching program.
- browxai cannot read or request the grant. The first connection triggers the system prompt.
- A new launching program means a new prompt. Moving from the npm install to the signed app is one such change.
- Whether `devicectl` calls from a child process need the same grant is unknown. Verify on a Mac. CoreDevice has its own daemon, so the answer may be no.
- The phone has its own Local Network list. The runner app must be allowed there.

## 9. Failure modes

| Symptom                                          | Cause                                                        | What the engine does                                                                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session open refuses with `ios-device-locked`    | The phone is locked or asleep                                | Refuses. Never unlocks. The fix names Auto-Lock                                                                                                            |
| `invalid session id` from WebDriverAgent mid-run | The runner restarted, or its session went stale              | Reports `ios-device-session-lost`. It does not create a new session by itself, because a new session relaunches the app and the evidence would not show it |
| `xcodebuild` reports an expired profile          | An organization team's profile and certificate last one year | Nothing. The runner is the operator's. The engine sees `wda-unreachable` and the device error text lists an expired profile as one cause                   |
| The network drops mid-session                    | Wi-Fi sleep, a network change                                | A read (`snapshot`, `screenshot`) retries once after 1 s. An input action never retries, since the first tap may have landed. The result says so           |
| The phone leaves `devicectl list devices`        | Wireless debugging lapsed                                    | The next lifecycle call refuses with `ios-device-disconnected`. WebDriverAgent calls may still work                                                        |
| Two phones are connected                         | A second paired device                                       | The allowlist decides. A phone off the list is never used. Two listed phones need `BROWX_IOS_DEVICE`                                                       |
| Two sessions ask for one phone                   | A second `open_session`                                      | `native-device-leased`                                                                                                                                     |
| `devicectl install` fails                        | The app is not signed for this phone, or storage is full     | The refusal carries `devicectl`'s own message                                                                                                              |
| `ios-device-wda-mismatch`                        | The address points at a simulator or another phone           | Refuses before any install                                                                                                                                 |
| `snapshot` takes seconds                         | A deep tree over Wi-Fi, 30 s HTTP limit                      | Unchanged. The manual keystone records the time                                                                                                            |
| WebDriverAgent tag lacks a route                 | A route in section 3 is missing on the pinned tag            | The verb refuses and names the route and the tag                                                                                                           |

## 10. Secrets

- No Apple account, password, session token, App Store Connect key, certificate, private key or provisioning profile ever appears in browxai's environment, config store or logs. The engine has no variable for any of them.
- `scripts/ios/wda-run.sh` takes a team id and optional App Store Connect key paths. Those stay in the script's environment in the operator's shell. The engine never reads them.
- `devicectl` uses the Mac's existing pairing with the phone. browxai does not read or copy pairing records.
- An identifier, a hardware UDID, a device name and the phone's address are personal data here. They are never written to a tool result beyond the allowlisted identifier, never to an evidence block, and never to a fixture. Fixtures use made-up identifiers.
- Registered secrets do not materialise on native engines today. This RFC does not change that.

## 11. Tests and the keystone

**Unit tests, in CI.** No Xcode and no phone.

- `devicectl.ts`: argv builders, and parsers against masked fixture JSON, with a fake runner. The runner type returns parsed JSON, and the default runner owns the temporary file, so a fake needs no file system.
- `device.ts`: the session order, each gate, the binding check, each rate limit, with a fake runner and a fake `Http`.
- Guard rails: the allowlist match rules, the `com.apple.` rule, the fence on every input verb, the scheme list.
- Doctor rows: each warn condition, with a fake `CommandRunner` and a fake HTTP function, the pattern `doctor-macos-app.test.ts` uses.
- A check that no device-path result or log line contains a device name or a hardware UDID from the fixture.

**The capability keystone.** The existing first describe in `test/keystone/ios-app.keystone.test.ts` runs everywhere and stays. One case is added: with `native-device` on and `BROWX_IOS_TARGET=device` and no allowlist, `open_session` refuses. It needs no phone.

**The manual-lane keystone.** A new file, `test/keystone/ios-device.keystone.test.ts`. It runs only when `BROWX_KEYSTONE_IOS_WDA_URL` names a real WebDriverAgent address, together with `BROWX_KEYSTONE_IOS_DEVICE` and an app id. Unset means every describe skips. It follows the three outcomes of `test/keystone/android-device-gate.ts`: absent skips, ready runs, and a phone that is named but locked, unpaired or unreachable fails. It never runs in CI.

Its assertions are the replacements RFC 0008 section 10.6 lists: a snapshot with a known label and at least one ref, a tap whose effect shows in the next snapshot, a stale ref refusal, a PNG from WebDriverAgent whose size is a whole multiple of the root rect, a swipe, a pinch, a find for a missing identifier, `app_foreground`, and the time of one snapshot. This RFC adds guard-rail assertions: a launch of a bundle id off the list refuses, `press home` followed by a tap refuses at the fence, and a deep link with an unlisted scheme refuses.

## 12. Recording evidence

The block in RFC 0008 section 10.7 is reused with three more lines: the transport (`localNetwork` or `wired`), the guard-rail assertions that ran, and the snapshot time. The `ios-app (real device)` row in the engine evidence table in `docs/tool-reference.md` moves from "probe" to "engine" when the manual keystone passes, per `docs/ai-context/release-process/engine-evidence.md`. The row and the block carry no identifier, device name, address or team id.

## 13. Semver

Additive. Everything sits behind `native-device`, which is off by default, and the tool reference says surfaces behind an off-by-default capability are experimental.

- No tool is added, renamed or removed. `open_session`'s schema does not change.
- `device_list` gains two output fields. `app_list` on a device returns a filtered list, which is new behaviour on a path that did not work before.
- New environment variables: `BROWX_IOS_TARGET`, `BROWX_IOS_DEVICE_ALLOWLIST`, `BROWX_IOS_DEVICE_APPS`, `BROWX_IOS_DEVICE_URL_SCHEMES`, and the rate limit overrides.
- One new confirm hook name, accepted by `BROWX_CONFIRM_REQUIRED` and by `set_config`'s `confirmRequired`.
- The default capability set does not change. The stable-surface clock does not reset.
- With `BROWX_IOS_TARGET` unset, behaviour is byte-for-byte what it is today.

Docs that change with the code slices: the tool reference's native section and environment table, the `native-device` threat-model row, the README sentence on real devices, the capability posture map note, and the CHANGELOG.

## 14. Alternatives considered

- **A direct usbmuxd client.** Rejected. It serves cabled devices and the owner chose a network phone. From iOS 17 the developer services moved behind a RemoteXPC tunnel, so a usbmuxd client alone no longer reaches install or launch. It would also mean reimplementing the pairing protocol and reading pairing records, which are secrets.
- **libimobiledevice and its tools.** Rejected. A native binary dependency the operator must install, a mix of LGPL and GPL parts to audit against the MIT licence floor, and its support for the iOS 17 and later tunnel has lagged behind Xcode.
- **`pymobiledevice3`.** Rejected. GPL-3.0, excluded by RFC 0008's licence floor, and it needs a Python runtime and a privileged tunnel process.
- **`go-ios`.** Rejected for now. MIT, so the licence is fine. It adds a second binary and its own tunnel process, and `devicectl` already covers the three calls this design needs with a tool the operator has.
- **`appium-ios-remotexpc`, or a full Appium server.** Rejected. A new npm dependency tree for calls `devicectl` already makes, and RFC 0008 rules that nothing routes through an Appium server.
- **Everything through WebDriverAgent, no `devicectl`.** Rejected. WebDriverAgent cannot install an app, cannot report pairing or Developer Mode, and cannot prove which phone it runs on.
- **Everything through `devicectl`, WebDriverAgent for the screen only.** Rejected. Terminate needs two subprocess calls and a pid lookup, and `devicectl` has no screenshot.
- **The engine manages `xcodebuild`.** Rejected in section 4.
- **A separate engine kind, `ios-device`.** Rejected. It would copy the substrate bundle and every refusal, and the difference is six host operations behind one interface.

## 15. Decisions for the reviewer

| #   | Decision                                                                    | Recommended default                                                                                                                                     |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How a session chooses `simulator` or `device`                               | Environment only (`BROWX_IOS_TARGET`), default `simulator`, no `open_session` argument                                                                  |
| D2  | A second capability for physical devices                                    | No. `native-device` plus a required target and allowlist                                                                                                |
| D3  | What the device allowlist matches                                           | CoreDevice identifier or hardware UDID, exact. Never a name. Never the only connected phone                                                             |
| D4  | An app off the app allowlist                                                | Ask a person through the new `native_device_app` hook, refuse with no human channel, not grantable by `approve_actions`. Stricter option: always refuse |
| D5  | System permission alerts                                                    | The agent cannot tap them. Opt-in for alert buttons is a later change                                                                                   |
| D6  | Rate limit numbers                                                          | 5 installs, 30 launch or terminate calls, 20 deep links, 3,000 input actions per session, 5 per second                                                  |
| D7  | The foreground fence also blocks `snapshot` and `screenshot`                | Yes                                                                                                                                                     |
| D8  | Deep link route                                                             | WebDriverAgent `/url`, with a scheme allowlist that is empty by default                                                                                 |
| D9  | Launch and terminate route                                                  | WebDriverAgent first, `devicectl` only if the pinned tag lacks the route                                                                                |
| D10 | `com.apple.` apps                                                           | Refused unless listed exactly, and confirmed on every launch                                                                                            |
| D11 | Whether `device_list` shows phones that are off the allowlist               | A count only                                                                                                                                            |
| D12 | If binding check 3 (pid match) cannot be built                              | Ship with checks 1 and 2 and say so in the threat model                                                                                                 |
| D13 | Whether the simulator path should move its screenshot to WebDriverAgent too | No. Out of scope, and `simctl` works with no WebDriverAgent                                                                                             |

## 16. Slice plan

Each slice is one small PR with its own docs-impact pass. None merges before this RFC is signed off.

| Slice | Scope                                                                                                                                                                                                                                                                                                                | Leaves the product                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| S1    | `devicectl.ts` (list builder, parser, runner), `BROWX_IOS_TARGET` and the device allowlist parsing, `iosDevices` in `device_list`, the `ios-device` doctor rows. Unit tests with fake runners. A session with `device` still refuses                                                                                 | Able to see an allowlisted phone. Unable to drive it     |
| S2    | `IosDeviceHost`, `IosPhysicalDevice`, the device session order, the binding check, the lease, screenshot and lifecycle and deep links through WebDriverAgent, install through `devicectl`, the device error text. G1, G2, G4, G9, G11 and G12 ship in this slice, so no build can drive a phone without an allowlist | Able to drive an allowlisted app on an allowlisted phone |
| S3    | The remaining guard rails: the `native_device_app` hook (G3), the foreground fence (G5, G6), the scheme list (G7), buttons (G8), rate limits (G10), the warning and log lines (G13). The threat-model row is rewritten here                                                                                          | At the posture this RFC describes                        |
| S4    | The manual keystone, the runbook additions, the tool reference and README wording, the evidence row once a run passes                                                                                                                                                                                                | Evidenced on one phone                                   |

S2 is not released on its own. S2 and S3 land in the same release, or S2 stays behind an internal flag until S3 merges. The reviewer may prefer to merge S3's fence into S2. That costs a larger PR.

## 17. Verify on a Mac

Everything this RFC states from memory, in one list. Each item is checked before the slice that depends on it.

1. `devicectl list devices --json-output` and every field name in section 2 (S1).
2. Whether the CoreDevice identifier survives a new pairing (S1).
3. Whether a network-only phone reports `tunnelState: connected` when idle, or only after a first command (S1).
4. `devicectl device install app`, its flags and its JSON result (S2).
5. `devicectl device info apps` and `info processes`, their JSON shapes, and whether a pid is listed per bundle id (S2).
6. WebDriverAgent v16.15.3 routes: `/wda/apps/launch`, `/wda/apps/terminate`, `/url`, `/wda/locked`. Add them to `scripts/ios/wda-run.sh probe` (S2).
7. Which `/status` field marks a simulator, and where the iOS version sits (S2).
8. Whether `POST /session` with a `bundleId` brings an already running app to the front (S2).
9. Which process `activeAppInfo` reports during a permission alert, a share sheet and a purchase sheet (S3).
10. `plutil -extract CFBundleIdentifier raw` on a `.app` bundle (S2).
11. Whether `devicectl` from a child process needs the Local Network grant (S1).
12. `devicectl device process launch --payload-url` and `--terminate-existing` (fallbacks only).
13. `devicectl device info lockState` (optional).

## Honest limits

- The design was written from the source and from one probe run. No part of the device path has run.
- The `devicectl` details are from memory of Xcode 15 and 16. Xcode 26.5 may differ.
- The foreground fence depends on what `activeAppInfo` reports during system sheets, which is unmeasured.
- The guard rails bound which app the agent drives. They do not bound what the agent does inside that app.
- One phone, one iOS release, one WebDriverAgent tag. WebDriverAgent's coupling to Xcode and iOS versions is a standing upkeep cost, as RFC 0008 says.

## References

- [RFC 0008](0008-native-app-control.md), sections 8 and 10.
- [RFC 0012](0012-signed-macos-app.md), for which program holds the Local Network grant.
- [`docs/roadmap.md`](../roadmap.md), item 7.
- [`docs/threat-model.md`](../threat-model.md), the `native-device` row.
- [`scripts/ios/wda-run.sh`](../../scripts/ios/wda-run.sh).
