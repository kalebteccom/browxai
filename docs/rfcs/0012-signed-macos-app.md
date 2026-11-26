# RFC 0012: A signed, notarized macOS app that hosts the browxai server

**Date:** 2026-11-23
**Status:** Proposed. The owner's direction is recorded below. Slice 1 (two scripts and the entitlements file) is written and syntax-checked. Slice 2 (the launcher, the bundle templates and the assembly script) was built, signed, notarized and stapled once on one Mac on 2026-11-24, and the signed app ran `browxai doctor`, a daemon and a headless Chromium session. Slices 3 to 5 (the `doctor` identity row, the Homebrew cask and the release steps in `RELEASING.md`) are written, unverified until built and run on a Mac. The login item, an Intel or universal build, the cloud helper and the cask have not been run. Every statement about macOS behavior that this RFC could not check on a Mac is marked "verify on a Mac" and collected in the last section, with the resolved ones dated.
**Trigger:** The owner asked for browxai on macOS to ship as a signed, notarized app, where today it is an unsigned Node process, and said to bundle the cloud host agent into it.

## What this is for

Today the browxai daemon on a Mac is `node dist/cli.js serve --socket PATH`. It runs under whatever started it: a Terminal window, a launchd job that names the Homebrew `node`, a client app that spawned it. macOS shows permission prompts for that process by the name of the program that started it, and a grant made to `node` covers every Node program on the machine.

A signed `.app` that hosts the daemon gives it one name, one stable code identity, an entry in System Settings that a person can switch off, and a download that Gatekeeper accepts without a warning. This RFC says what that costs and how to build it with the signing and notarizing done on the owner's Mac.

## Owner direction (recorded, final)

1. **Distribution.** A signed, hardened-runtime, notarized, stapled `.app` bundle hosts the server. It runs `serve --socket` as a user login item or LaunchAgent, and carries the signed CLI inside it. It ships as a zip, with a disk image possible later, and as a Homebrew cask.
2. **npm stays.** `npm install` keeps working as it does today, as unsigned JavaScript run by the user's own Node.
3. **Bundled host agent.** The cloud host agent, a separate binary produced by a separate release outside this repository, is embedded in the app as a helper. One app means one permission identity, one notarization, one install and one update channel. See "Bundled helpers".

## What browxai needs from macOS today

I read `src/` for every place the server touches the operating system. The honest answer is that browxai asks macOS for almost nothing itself. What it asks of the browsers, adb and Xcode tools it starts is a separate question, and that is where permissions come from.

| Feature                                                          | What it touches on the Mac                                                                                                                                                             | Permission prompt from browxai itself                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Managed and incognito Chromium, Firefox, WebKit (Playwright)     | Child processes over a pipe to the browser. Windows are ordinary app windows. Browsers download to the user cache.                                                                     | None.                                                                                                          |
| Installed Google Chrome (`chrome start`, `chrome login`)         | `src/cli/chrome-launch.ts` looks for `/Applications/Google Chrome.app` and `~/Applications`, and `src/cli/chrome.ts` spawns it detached. Debug port on loopback.                       | None from browxai. What Chrome asks for is covered below.                                                      |
| Attach to a running Chrome or Electron app over CDP              | A TCP connection. Loopback needs nothing.                                                                                                                                              | None for loopback. A Chrome on another machine on the LAN is a Local Network connection.                       |
| Screenshots, live view, video                                    | CDP `Page.startScreencast` and screenshots from the browser (`src/helper/operator-screencast.ts`). No `screencapture`, no CoreGraphics call.                                           | None. No Screen Recording permission.                                                                          |
| Clicks, typing, gestures                                         | CDP, XCUITest through WebDriverAgent, adb. No `CGEvent`, no accessibility API, no `osascript`.                                                                                         | None. No Accessibility permission, no Automation (Apple events) permission.                                    |
| Clipboard (`clipboard` capability)                               | Write-only, through the browser. No `pbcopy` or `pbpaste` in `src/`.                                                                                                                   | None known. Verify on a Mac for the newer pasteboard privacy setting.                                          |
| Safari engine (`safari`)                                         | Spawns `/usr/bin/safaridriver -p PORT --bidi PORT` (`src/engine/adapters/safari/launch.ts`). One-time `safaridriver --enable` with admin rights, and Safari's Allow Remote Automation. | None known. The `--enable` step is a system authorization, not a privacy permission. Verify on a Mac.          |
| Android (`android`, `android-app`)                               | Runs `adb` from `PATH`. adb's server listens on loopback. A USB phone goes through the OS USB stack.                                                                                   | None known. Verify on a Mac for USB.                                                                           |
| iOS Simulator (`ios-app`, simulator half)                        | `xcrun simctl` for boot, install, launch, screenshot. WebDriverAgent on loopback.                                                                                                      | None.                                                                                                          |
| iOS device lane (planned, RFC 0008)                              | `xcrun devicectl` and WebDriverAgent on the phone over the local network.                                                                                                              | Local Network, on macOS 15 and later, for the process that connects to the phone's address.                    |
| Workspace, profiles, `.browx` archives, downloads                | Files under `$BROWX_WORKSPACE`, default `~/.browxai` (`src/util/workspace.ts`).                                                                                                        | None for the default. A workspace under Desktop, Documents or Downloads triggers the Files and Folders prompt. |
| Credential providers (`oathtool`, `lpass` and others)            | Child processes of the named CLIs (`src/util/credentials-providers.ts`).                                                                                                               | None from browxai. A password manager CLI may check which app calls it. Verify on a Mac.                       |
| The daemon socket                                                | A Unix socket, mode `0600` (`src/cli/serve-socket.ts`). No TCP listener.                                                                                                               | None, and no firewall prompt for incoming connections.                                                         |
| Camera, microphone, location, notifications as web page requests | The browser asks, and browxai's policies answer the page-side request.                                                                                                                 | None from browxai. Chromium may ask the OS. The attribution question is in the next section.                   |

Three consequences.

- **Nothing here needs the app.** A signed app grants browxai no permission that it lacks today.
- **The first permission that the app helps with is Local Network,** for the iOS device lane and for any CDP attach to a LAN address. On macOS 15 and later it is per app.
- **Two practical gaps come from running under launchd.** A launchd job has a short `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so `adb`, `oathtool`, `lpass` and a Homebrew `node` are not found unless the plist sets `PATH`. It also reads no shell startup file, so `BROWX_*` settings come from the plist or from the saved config layer. The login item design below handles both.

## What changes when an app hosts the server

macOS keeps a per-user list of permission grants (the TCC database). When a process asks for something protected, the system decides which program to ask the user about and which program to record the grant for. Apple calls that program the responsible process. I know these rules from Apple's documentation of the prompts and from engineering write-ups, and Apple publishes no complete specification. Every line in this section is "verify on a Mac" unless it says otherwise.

- **Started from Terminal.** The grant belongs to Terminal (or iTerm). The prompt names it.
- **Started by launchd as a LaunchAgent that runs a bare `node`.** The grant belongs to that `node` binary. It is shared by every program that uses it.
- **Started by an app, as a child process.** The child is usually attributed to the app. A child that goes through Launch Services as its own app, or one that disclaims responsibility when it starts, is attributed to itself.
- **A grant is recorded against a code signature requirement, not a path.** The next section shows why that makes the signature design the center of this RFC.

What this means for the daemon:

- The daemon, and everything it spawns without disclaiming (Chromium, adb, `xcrun`), is attributed to the app. Prompts name the app. A person turns them off in one place.
- Chrome launched by `chrome start` is attributed the same way, unless Chrome's own launch logic disclaims. If it is attributed to the app, a page's camera request would ask about the app. The app would need `NSCameraUsageDescription` and the camera entitlement to be allowed at all. **Decision: add neither.** No browxai feature uses either, and a prompt that names the app and then fails would only confuse the user. Verify on a Mac what Chrome and Chromium do when launched by the app.
- Running `browxai call` from Terminal talks to the daemon over the socket. The Terminal does not become the one that needs permissions, because the daemon does the work.

## The identity design

Three values. Placeholders here, because the team name and team id stay out of the repository.

| Value               | Placeholder              | Notes                                                                                                                                              |
| ------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle identifier   | `<BUNDLE_ID>`            | Reverse-DNS, chosen once, never changed. It is part of every grant. The owner picks it before slice 2.                                             |
| Team ID             | `<TEAM_ID>`              | The 10-character id of the organization team.                                                                                                      |
| Signing certificate | Developer ID Application | Created for the organization team. Valid five years. Its private key lives only in the owner's keychain, with an encrypted backup the owner holds. |

**The designated requirement.** `codesign` gives every Developer ID build a requirement of this shape, and the script never overrides it:

```
identifier "<BUNDLE_ID>" and anchor apple generic
  and certificate leaf[subject.OU] = "<TEAM_ID>"
  and (the Developer ID extension markers)
```

It names the bundle id and the team and carries no hash of the code. So a new build, a new certificate from the same team, and a renewed certificate all satisfy the same requirement, and a grant made to the old build applies to the new one. That is why the bundle id and the team id must never change.

**Why ad-hoc signing breaks grants.** An ad-hoc signature has no team. Its requirement pins the exact hash of that build (`cdhash`). The next build has a different hash, so the system treats it as a different program and asks again, or quietly refuses. A build signed with an Apple Development certificate has a different requirement from a Developer ID one, so a developer build and a release build do not share grants either. A person testing a development build will be asked again after installing the release.

`scripts/macos/verify-app.sh` prints the requirement and can compare it with the one from an earlier build (`BROWXAI_DR_BASELINE`). That check is the cheapest proof that an upgrade keeps grants. The first release writes the baseline file, which stays outside the repository.

**Nested code.** The bundled `node` binary is signed with the fixed identifier `<BUNDLE_ID>.node` and the helper with `com.kalebtec.browxai-cloud` (the identifier the cloud release signs with, not derived from the bundle id), so a requirement that names either one stays the same across builds. The default identifier of a bare executable is its file name.

## Hardened runtime and entitlements

Notarization requires the hardened runtime on every executable, a secure timestamp, and a Developer ID signature. The hardened runtime blocks things a Node process does: it forbids JIT-compiled code pages, unsigned executable memory, loading libraries signed by another team, and `DYLD_*` environment variables. An entitlement lifts one restriction. The aim is the shortest list.

| Entitlement                                              | Needed?                    | Reason                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `com.apple.security.cs.allow-jit`                        | Starting point, unverified | V8 compiles JavaScript to machine code in memory mapped with `MAP_JIT`. The hardened runtime refuses that mapping without this key. Whether it is enough on its own is not verified: Node's own release is signed with broader entitlements.                                         |
| `com.apple.security.cs.allow-unsigned-executable-memory` | No, until a crash shows it | Older V8 paths and some WebAssembly paths ask for plain writable-and-executable memory. Apple silicon with `MAP_JIT` normally does not. Add it only after a signed build fails without it, and record the failure here.                                                              |
| `com.apple.security.cs.disable-library-validation`       | No                         | It lets the process load a native addon or dylib signed by another team. The production dependencies (`@modelcontextprotocol/sdk`, `playwright-core`, `rrweb`, `zod`) are JavaScript with no `.node` addon. `rrweb` runs inside the browser. Needed only if an addon is added later. |
| `com.apple.security.cs.allow-dyld-environment-variables` | No                         | Nothing here sets `DYLD_*`.                                                                                                                                                                                                                                                          |
| Camera, microphone, Apple events, user-selected files    | No                         | No feature uses them (previous sections).                                                                                                                                                                                                                                            |
| `com.apple.security.app-sandbox`                         | No                         | The App Sandbox would stop the daemon from starting Chrome, adb and `xcrun`. Developer ID distribution does not require it. The hardened runtime is a different, lighter protection and is the one in use.                                                                           |
| `com.apple.security.get-task-allow`                      | Never                      | Notarization rejects it.                                                                                                                                                                                                                                                             |

`scripts/macos/entitlements.plist` holds `allow-jit` alone, as the proposed minimum. **That minimum is unverified.** My understanding is that Node's own release is signed with broader entitlements, `allow-unsigned-executable-memory` and `disable-library-validation` among them. I have not confirmed it against the pinned release. So the minimum has to be tested on a Mac with a signed Node: dump the official binary's entitlements with `codesign -d --entitlements - <node>` as the baseline, sign the bundled copy with `allow-jit` alone, and run the keystone suite and `browxai doctor` against it. Widen the list only with a recorded failure. `release-app.sh` applies the file to the one path `Contents/Resources/node/bin/node` and to nothing else, and the launcher and the helper get the hardened runtime and no entitlements. `verify-app.sh` enforces that split: it fails when any other Mach-O file carries an entitlement, and when `node` carries a key other than `allow-jit`. Widening the list means changing both scripts in the same commit as the reason.

## Building the host: bundle the runtime, not a single executable

Two ways to make a Node program a signed Mac binary.

**A. Node single executable application (SEA).** Node injects a blob into a copy of its own binary. One file, nothing else to sign.

- The blob is one script. The repo is ESM with a `dist/` tree. It would need a bundler that the repo does not use, and the bundle has to cope with `playwright-core` reading its own package files at runtime. I did not check that against the pinned 1.65.1. Verify on a Mac.
- Injecting the blob invalidates the binary's signature. The flow is remove signature, inject, sign again, and it depends on the Node release.
- Updating one bug means a new 100 MB binary, and the bundle gives no way to inspect the code that runs.

**B. Bundle the Node binary next to `dist/`.** The app carries an unmodified official Node binary, the built `dist/` and the production `node_modules`, and a small compiled launcher starts `node dist/cli.js serve --socket PATH`.

- Nothing changes in how browxai is built or tested. The same `dist/` that the release workflow builds and checks for reproducibility is what ships.
- Facts about the repo: no native addon in the production dependencies, `playwright-core` is JavaScript, and a clean install is 110 packages and 61.5 MB in `node_modules` (roadmap item 4, measured on Linux). The Node binary adds about a hundred megabytes, which I have not measured for the pinned release. Chromium is not bundled. The 313 MB browser download stays a separate, on-demand step, as it is for npm users.
- The launcher is a compiled executable because of the identity the process runs under. A script as the main executable is run by its interpreter, so the running process has the interpreter's code identity (`/bin/sh` or `env`), and a permission prompt or grant is tied to that and not to the app. `codesign` can sign a script, keeping the signature in an extended attribute, but that does not change which program runs.

**Decision: B.** SEA stays a later option if the size or the layout becomes a problem. The pinned Node release comes from nodejs.org, checked against its published `SHASUMS256.txt` and the signature on that file, and re-signed with our identity.

**Architectures.** Apple silicon first, because the owner's Mac is one. An Intel build needs a separate Node binary and its own notarization run. A universal app needs `lipo` over two Node binaries and a universal launcher. Open question below.

## The bundle layout

`scripts/macos/build-app.sh` builds this (slice 2). Names in angle brackets are placeholders. The chosen values are in the Build section.

```
<APP_NAME>.app/
  Contents/
    Info.plist                    CFBundleIdentifier <BUNDLE_ID>, LSUIElement true,
                                  LSMinimumSystemVersion 13.0, NSLocalNetworkUsageDescription,
                                  CFBundleShortVersionString = the browxai version
    MacOS/<launcher>              compiled launcher, the main executable
    Helpers/browxai-cloud         optional embedded helper (see "Bundled helpers")
    Library/LaunchAgents/<BUNDLE_ID>.agent.plist   the agent definition (see "Login item")
    Resources/
      node/bin/node               official Node binary, re-signed
      app/dist/                   the built browxai
      app/node_modules/           production dependencies, hoisted, no symlinks out of the bundle
      app/package.json
      bin/browxai                 shell wrapper: sets BROWX_SOCKET, runs the bundled node on dist/cli.js
      bin/browxai-cloud           shell wrapper for the helper (only with a helper)
      bundled-helpers.json        written by release-app.sh (only with a helper)
      THIRD_PARTY_NOTICES.md, sbom.cdx.json, node-LICENSE
```

The scripts under `Resources/bin` are sealed as resources, so the bundle signature covers them. The signed binaries are the Node binary, the launcher and the helper. `LSUIElement` keeps the app out of the Dock and the app switcher.

## Bundled helpers

The cloud host agent is a Rust binary that connects a relay to `browxai serve --socket` on the user's machine. A separate release outside this repository builds it. The app embeds it as an optional helper.

**Layout and names.** `Contents/Helpers/browxai-cloud`, signed with the fixed identifier `com.kalebtec.browxai-cloud`, the hardened runtime, a secure timestamp and no entitlements. A Rust binary needs no JIT. The wrapper `Contents/Resources/bin/browxai-cloud` resolves its own real path through any symlink and runs the helper. The Homebrew cask links that wrapper onto `PATH`, so the pairing command is `browxai-cloud` in any Terminal. A wrapper on `PATH` is a plain child of Terminal, which is fine: the helper opens an outbound connection to the internet and to the local socket, and neither is a protected resource.

**How the release script obtains the binary without the OSS repo depending on private source.** The repository holds no reference to the helper's source, its repository or its build. The cloud release publishes a universal macOS binary and a SHA-256 of it as release artifacts. The owner downloads both. `release-app.sh` takes them from two environment variables:

- `BROWXAI_CLOUD_HELPER`: the path to the binary.
- `BROWXAI_CLOUD_HELPER_SHA256`: its SHA-256.

The helper is optional. With neither variable set, the script builds the plain browxai host app. With one set and not the other, the script stops. With both, it checks the digest and stops on a mismatch, before anything is signed. It copies the binary into its work directory first, hashes that copy, and uses only the copy from then on, so the file cannot change between the check and the use. It clears the quarantine attribute on the copy, checks that it is a Mach-O file with every architecture the app has, that the input app carries the `browxai-cloud` wrapper, and that `--version` prints exactly one line and exits 0 within ten seconds. The binary is run only after its digest matched. A missing or unreadable architecture list is a failure for the launcher, the bundled `node` and the helper, and the zip's architecture label comes from the launcher and `node`, which must agree.

**Helper contract.** This is what the script needs from the helper. It is a request to the cloud release, not code here.

1. `browxai-cloud --version` prints one line and exits 0.
2. The helper is a universal Mach-O file built without a development signature requirement. The script signs over whatever signature it has.
3. The helper only starts when the user pairs it. The login agent starts the daemon and nothing else.
4. The helper connects to the daemon's socket as a client. It opens no listener on the Mac.

**Signing order.** Inside out, with no `--deep` on signing. The script signs the helper first, then every other Mach-O file deepest first, then nested bundles, then the app. It writes `Contents/Resources/bundled-helpers.json` before signing, so the manifest is inside the seal. The manifest records the helper's name, path, identifier, version and the digest of the file as the cloud release produced it. The digest of the signed file differs, because signing rewrites the binary, so the manifest carries the source digest. One notarization submission covers the app and the helper, because the helper is inside the bundle that is submitted.

**Verification.** `verify-app.sh` checks that the helper's signature verifies on its own and carries the expected identifier, the same team as the app, the hardened runtime flag, a timestamp and no entitlements. It prints the helper's `--version`, checks it against the manifest, and, when `BROWXAI_CLOUD_HELPER_SHA256` is set, checks the manifest's source digest against it.

**Version compatibility.** The app and the helper ship as a tested pair. A helper update is a new app build, so the cask is the only update channel and there is no state where the two drift apart on a user's machine. The helper talks to the daemon over MCP on the socket, which is the stable surface under `docs/tool-reference.md`. The release notes list the pair. The helper should refuse to pair when the daemon's server version is outside the range it was tested with. That check lives in the helper and is a request to the cloud release. Open question: whether the app should also carry a minimum helper version, so a stale helper file never ships.

**The OSS threat model does not change.** The helper starts when the user pairs, not at login. It adds no capability and no listener to browxai. It reaches browxai through the same owner-only socket as `browxai call`, so every gate, origin rule and secret mask in the daemon applies to what it does. A user who never pairs runs the same daemon as a user of the plain app, and the helper file sits unused in the bundle. The helper's own network behavior belongs to its own documentation outside this repository.

## Notarization and packaging

`scripts/macos/release-app.sh APP VERSION` does all of this on the owner's Mac. It reads `BROWXAI_APPLE_TEAM_ID` and `BROWXAI_NOTARY_KEYCHAIN_PROFILE` from the environment and stops without them. The `BROWXAI_` prefix keeps it from picking up an unrelated shell variable. It shares the family with the helper's own scripts: `BROWXAI_APPLE_TEAM_ID`, `BROWXAI_APPLE_SIGNING_IDENTITY` and `BROWXAI_NOTARY_KEYCHAIN_PROFILE`.

1. Resolve the input app and the output directory to real paths. Refuse when the output directory is, contains or sits inside the input app, and when it exists and is not empty. Refuse any symlink in the bundle that resolves outside it. Copy the app to a temporary work directory, which is the only thing the script deletes, so the input is never modified or removed.
2. Find the Developer ID Application certificate for the team with `security find-identity -v -p codesigning`, and refuse when none or several match (`BROWXAI_APPLE_SIGNING_IDENTITY`, a hash or a full name, picks one). The name is never printed.
3. Add and sign the helper, when given (above).
4. Sign every other Mach-O file, then nested bundles, then the app: `codesign --force --options runtime --timestamp`, and the entitlements file on `node`.
5. `codesign --verify --deep --strict`.
6. Zip with `ditto -c -k --keepParent` and run `xcrun notarytool submit ... --keychain-profile <KEYCHAIN_PROFILE> --wait`. The script reads the status from the JSON result. On anything but `Accepted` it saves the notary log to the output directory and stops.
7. `xcrun stapler staple` the app, then `stapler validate`.
8. `spctl --assess --type execute --verbose=4` must report `Notarized Developer ID`. The output carries the certificate's organization name, so the scripts mask it before printing.
9. Zip the stapled app, write `browxai-VERSION-macos-ARCH.zip` and its `.sha256`.

The notary credential is an App Store Connect API key stored once with `xcrun notarytool store-credentials <KEYCHAIN_PROFILE>`. The key never enters the repository, a CI system or a command line. A disk image is a later option: `hdiutil`, then sign, notarize and staple the image itself. A zip is enough for the cask.

## Build

Slice 2 adds the sources and the assembly script. The author wrote them without a Mac, and the owner has since built, signed and notarized the app once (see "First run on a Mac" below). Everything below is what the owner runs on a Mac with Xcode or its command line tools (for `swiftc`, `lipo` and `notarytool`), `pnpm` 9 and a network connection.

**Values chosen for the scripts.** These are public identifiers, not secrets. The Team ID is not among them and stays an environment input.

| Value                      | Chosen                                                                         |
| -------------------------- | ------------------------------------------------------------------------------ |
| Bundle identifier          | `com.kalebtec.browxai`. Never changes.                                         |
| App name and bundle        | `Browxai`, so `Browxai.app`. LSUIElement is true, so there is no Dock icon.    |
| Main executable            | `Contents/MacOS/browxai-launcher`                                              |
| Node binary identifier     | `com.kalebtec.browxai.node`                                                    |
| Helper identifier          | `com.kalebtec.browxai-cloud`                                                   |
| Login agent label and file | `com.kalebtec.browxai.agent`, in `Contents/Library/LaunchAgents/<label>.plist` |
| Minimum macOS (Info.plist) | 13.0                                                                           |
| Architectures              | `arm64` by default. `BROWXAI_ARCHS="arm64 x86_64"` builds a universal app.     |
| Default socket             | `~/Library/Application Support/Browxai/run/browxai.sock`, directory mode 0700  |
| Agent log                  | `~/Library/Logs/Browxai/browxai.log`, mode 0600, rotated once at 5 MB          |
| Node version               | the one line in `macos/node-version.txt`                                       |

**What the launcher does.** `macos/launcher/main.swift` is one file that builds with plain `swiftc`, with no package manifest and no Xcode project. It finds the app from its own real path and never from `PATH`.

- `run [--socket PATH]` makes the socket directory (mode 0700) and the log file (mode 0600), and replaces itself with `node dist/cli.js serve --socket PATH`. The socket comes from `--socket`, then `BROWX_SOCKET`, then the default above. A path over 103 bytes is refused. The agent's environment is a fixed `PATH` (system directories first, then Homebrew), `HOME`, `USER`, `LOGNAME`, `TMPDIR`, the locale variables and every `BROWX_*` variable. Nothing else passes through.
- `cli ARGS...` replaces itself with `node dist/cli.js ARGS...` in the caller's own environment, and defaults `BROWX_SOCKET` to the app's socket. The `Resources/bin/browxai` wrapper calls it, so `browxai` on `PATH` is the bundled CLI.
- `helper ARGS...` does the same for `Contents/Helpers/browxai-cloud`. The `Resources/bin/browxai-cloud` wrapper calls it. A build without the helper says so and exits 1.
- `login-item status|register|unregister` uses `SMAppService.agent(plistName:)`. Where the API is missing (macOS before 13) or `register` fails, it prints a shell script that writes a plain launchd agent with absolute paths and loads it with `launchctl bootstrap`.
- `version` prints the app version.

**What `build-app.sh` does.** It never writes into the working tree. It asks for one argument, a new or empty output directory.

1. Reads the version from `package.json` and the Node version from `macos/node-version.txt`.
2. Downloads `SHASUMS256.txt` for that Node version from nodejs.org, then each darwin tarball, and checks the SHA-256 before extracting. It takes `bin/node` and `LICENSE` and nothing else. With `BROWXAI_NODE_KEYRING` set to a keyring of the Node release keys, it also checks the signature on `SHASUMS256.txt` with `gpgv`. This is the script's only network use.
3. Builds the launcher with `swiftc -O -target <arch>-apple-macos12.0` per architecture and joins the results with `lipo` when there are two. The deployment target is lower than the app's floor so the launcher can print the launchctl fallback on a Mac without `SMAppService`.
4. Copies `dist/`, `package.json` and the production `node_modules`. From a checkout the dependencies come from `pnpm deploy --prod` into a temporary directory, which reads the lockfile. From an installed package (set `BROWXAI_SOURCE_DIR`) they are copied from its `node_modules`. The `.bin` shims and the package manager's bookkeeping files are dropped, because they hold absolute paths. Symlinks that remain stay relative and inside the bundle.
5. Fills `macos/Info.plist.in` and `macos/launchagent.plist.in`, lints both with `plutil`, and copies the two wrappers.
6. Checks every path that `release-app.sh` and `verify-app.sh` read, checks the symlinks, and on the host architecture runs `browxai-launcher version`.

The result:

```
Browxai.app/
  Contents/
    Info.plist
    MacOS/browxai-launcher
    Library/LaunchAgents/com.kalebtec.browxai.agent.plist
    Resources/
      node/bin/node
      app/dist/
      app/node_modules/
      app/package.json
      bin/browxai
      bin/browxai-cloud
      node-LICENSE
      THIRD_PARTY_NOTICES.md
      sbom.cdx.json              only when the source has one
```

`Contents/Helpers/` and `bundled-helpers.json` are absent on purpose. `release-app.sh` adds the helper, so the unsigned app is the same for every release flavor.

**The owner's steps, in order.** Placeholders in angle brackets are for the owner to fill in. The scripts never read a certificate, a key or the notary credential. `release-app.sh` finds the Developer ID Application certificate in the login keychain and passes only the keychain profile name to `notarytool`.

1. Build the app, from a checkout of the release tag:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm sbom
scripts/macos/build-app.sh "$HOME/browxai-macos/unsigned"
```

2. Sign, notarize, staple and zip it. The helper variables are optional, both or neither:

```bash
export BROWXAI_APPLE_TEAM_ID=<TEAM_ID>
export BROWXAI_NOTARY_KEYCHAIN_PROFILE=<KEYCHAIN_PROFILE>
# export BROWXAI_CLOUD_HELPER=<path to the helper binary>
# export BROWXAI_CLOUD_HELPER_SHA256=<its SHA-256>
BROWXAI_OUT_DIR="$HOME/browxai-macos/signed" \
  scripts/macos/release-app.sh "$HOME/browxai-macos/unsigned/Browxai.app" <VERSION>
```

3. Verify the result:

```bash
BROWXAI_EXPECT_TEAM_ID="$BROWXAI_APPLE_TEAM_ID" BROWXAI_EXPECT_BUNDLE_ID=com.kalebtec.browxai \
  scripts/macos/verify-app.sh "$HOME/browxai-macos/signed/Browxai.app"
```

4. Try the login agent from the signed app, in `/Applications`:

```bash
/Applications/Browxai.app/Contents/MacOS/browxai-launcher login-item register
/Applications/Browxai.app/Contents/MacOS/browxai-launcher login-item status
/Applications/Browxai.app/Contents/Resources/bin/browxai tools
```

`register` works only on a signed copy. When it reports `requires approval`, switch Browxai on in System Settings, General, Login Items & Extensions.

## Login item mechanics

User level only. No root, no privileged helper, no daemon in `/Library`. The one admin step on the Mac is `sudo safaridriver --enable`, and the owner runs it in Terminal, outside the app.

**Recommended: `SMAppService` with an agent plist inside the bundle** (macOS 13 and later). The launcher calls `SMAppService.agent(plistName:)` and `register()`, and launchd runs the program the plist names. An agent plist inside a bundle uses bundle-relative paths: `BundleProgram` is `Contents/MacOS/<launcher>`, relative to the app, and not an absolute path. The agent shows in System Settings under Login Items, named after the app, where a person can switch it off. The plist sets:

- `ProgramArguments`: the launcher's own name first, then its arguments (`run`). The plist holds no path to `node` and none to the socket: `run` takes the socket from `--socket`, then `BROWX_SOCKET`, then the default below. The launcher locates the app's own `Contents/Resources/node/bin/node` and `Contents/Resources/app/dist/cli.js` from its own location and runs them, so the app works wherever it is installed. The launcher also expands the `~` in the socket path, which launchd does not.
- `EnvironmentVariables`: a `PATH` that includes `/opt/homebrew/bin` and `/usr/local/bin`, and any `BROWX_*` setting the user picked. A user-level config layer is the other source.
- `KeepAlive` and `RunAtLoad`, and `AssociatedBundleIdentifiers` set to `<BUNDLE_ID>` so the system ties the agent to the app.

**Alternative: `SMAppService.mainApp`.** The app itself is the login item and starts the daemon as a child. It is simpler and it makes the child's attribution the app by the plain rule. Its cost is that the daemon only runs while the app does.

**Fallback: a plist in `~/Library/LaunchAgents`** written by a `browxai` subcommand and loaded with `launchctl bootstrap gui/<uid>`. It needs no Swift, and the agent then appears in Login Items as a command with no app name. It is the route for the npm install and for a Mac where `SMAppService` misbehaves.

Verify on a Mac: that `SMAppService.agent` runs under the app's identity for Local Network and Files prompts, whether the app must sit in `/Applications` for registration to work, and what a Homebrew install does to the registration on upgrade.

**The socket.** A short path, because a Unix socket path is limited to 104 bytes on macOS: `~/Library/Application Support/<APP_DIR>/run/browxai.sock`. The daemon already creates it owner-only. The default workspace stays `~/.browxai`, which has no permission cost.

## How MCP clients connect

- **Shell and SDK.** `browxai call` and `browxai tools` (RFC 0011) and the SDK's `createBrowxai({ endpoint: "unix://..." })` connect to the socket. These commands never look for a socket (`src/cli/shell-connect.ts`), so the `Resources/bin/browxai` wrapper sets `BROWX_SOCKET` to the app's path when the variable is unset.
- **MCP clients that spawn a stdio server** (Claude Desktop, Cursor and others) start `browxai` and talk over its standard input. That process is its own server with its own session registry. `browxai bridge` connects such a client to the app's daemon: it speaks MCP on stdio and relays every message to the socket. It is specified in [RFC 0013](0013-stdio-socket-bridge.md) and was not part of the four slices below. The client's entry is the app's `browxai` command with the one argument `bridge`, and `browxai init` writes that entry when it runs from the app. `bridge --start` asks the launcher's `login-item start` command to start a registered agent that is stopped. A bare `browxai` in a client's entry still starts a server of its own.

## npm and the app side by side

Both can be installed. They share no state unless the user points them at the same workspace and socket. Whichever `browxai` comes first on `PATH` wins. The cask links `browxai` into Homebrew's `bin`, and `npm install -g` writes to npm's prefix, so the user's `PATH` order decides. Nothing in either install overwrites the other.

`browxai doctor` gets one row, `macos-app` (slice 3, `src/cli/doctor-macos-app.ts`). It exists on macOS only: Linux and Windows output does not change. The row decides where browxai runs from. Node counts as inside the app when `process.execPath` sits under a `.app/Contents/` directory whose `Info.plist` holds the bundle id `com.kalebtec.browxai`. Anything else, including a Node inside some other app bundle, is an npm install or a source checkout.

- **Not in the app.** One line: `not running from the signed Browxai app. Permission grants then attach to the launching terminal or MCP client.`
- **In the app.** The row runs `codesign -dv --verbose=4` and `codesign --verify --strict` on the bundle, and the launcher's `login-item status`, all through one injectable command runner, so the unit tests use a fake and no test needs a Mac. It shows whether the bundle is signed, its identifier, its team id, whether the hardened runtime flag is set, whether the signature verifies, and whether the login agent is registered. It prints no certificate name, only the identifier and the team id. A launcher that has no `login-item` command adds nothing to the line.
- **Never a failure.** The row is informational and never changes the exit code. It is a `⚠` with a next step in the short summary when the bundle is not signed, the signature does not verify, the signature has no team id (an ad hoc signature, which does not keep grants across builds) or the hardened runtime is off. Otherwise only `--verbose` shows it.

## SBOM and provenance for the signed artifact

- **SBOM.** The release workflow already attaches `sbom.cdx.json` (CycloneDX, from the lockfile). The app ships the same file under `Resources/`. `cdxgen -t pnpm` does not see the Node binary or the helper, so the app's notice file lists both by hand: the Node version and licence, and the helper as an opaque component with its version and source digest.
- **Provenance.** npm provenance is signed by the release workflow's OIDC run and covers the npm tarball. The app is built on the owner's Mac, so no workflow run signs it and the repository claims no such statement for it. What backs the app is Apple's notarization ticket, the SHA-256 file, the signed git tag, and the fact that `dist/` is the tree the release workflow already rebuilt and diffed in its reproducibility job. The app build should start from that tag. Attaching an attestation from a workflow that only downloads the zip would name the workflow and not the build, so it is not done.

## Release process with no secrets in CI

Signing and notarizing happen on the owner's Mac. `.github/workflows/release.yml` is unchanged: it holds no signing key, no notary credential and no Apple account. After the tag publishes to npm through the existing workflow, the owner:

1. Checks out the tag, runs the install and build, and assembles the app (slice 2's assembly step).
2. Downloads the helper artifact and its SHA-256 from the cloud release, when bundling it.
3. Runs `release-app.sh`, then `verify-app.sh`.
4. Uploads the zip and the `.sha256` file to the GitHub Release by hand.
5. Updates the cask (slice 4).

`RELEASING.md` has the macOS app section for these steps (slice 5). The npm publish is unchanged, and the app is a separate manual artifact until a Mac CI lane exists.

## Homebrew

Slice 4 adds the cask as a template, `packaging/homebrew/browxai.rb`, and `scripts/macos/make-cask.sh`, which prints the finished cask for one release zip. The script needs no network. It computes the zip's SHA-256, checks it against the `.sha256` file that `release-app.sh` wrote next to the zip, and fills the version, the digest and the architecture. The cask lives in a tap, not in this repository.

**The tap.** The proposed tap repository is `kalebteccom/homebrew-tap`, with the file at `Casks/browxai.rb`. The name is a proposal. Creating the repository and pushing the cask into it is the owner's step, and nothing in this repository does either. Users then run `brew install --cask kalebteccom/tap/browxai`, or `brew tap kalebteccom/tap` once and `brew install --cask browxai`. A submission to the main cask repository is the alternative in open question 4. It has its own notability and signing rules, so the tap comes first.

**What the cask does.**

- It downloads `browxai-<version>-macos-<arch>.zip` from the GitHub Release `v<version>`, the file `release-app.sh` writes, and Homebrew checks the SHA-256.
- It moves `Browxai.app` into `/Applications` and links `Contents/Resources/bin/browxai` onto `PATH`. For a build with the bundled helper, built with `make-cask.sh --with-helper`, it links `browxai-cloud` as well.
- It requires macOS 13 (Ventura) or later with `depends_on macos: :ventura`, the same floor as `LSMinimumSystemVersion` and `SMAppService`. An `arm64` or `x64` zip adds a `depends_on arch:` line before it, because `brew style` wants the architecture first. A `universal` zip has only the macOS line.
- `livecheck` reads the latest GitHub release.
- `brew uninstall --cask browxai` stops the login agent and quits the app. `--zap` also trashes the app's Application Support and cache folders, its preferences, and the fallback LaunchAgent plist. It leaves the workspace (`~/.browxai`) alone, because the profiles, saved logins and replay archives in it are the user's data.

**The update path.** `brew upgrade --cask browxai` replaces the app in `/Applications` with the new build and restarts the login agent. Permission grants survive, because the new build has the same bundle id and team id and so satisfies the same designated requirement as the old one (see "The identity design"). `verify-app.sh` with `BROWXAI_DR_BASELINE` is the check before a release goes out. A user whose first install was an ad hoc or development build is asked again once, after moving to the release build. Whether the login agent registration survives an upgrade without a manual step is not verified. It is item 5 under "Verify on a Mac".

## Updates

**Homebrew cask first.** `brew upgrade --cask` replaces the app. The new build has the same bundle id and team, so it satisfies the same requirement and keeps its grants. Homebrew puts the app in `/Applications` and downloads with the quarantine attribute set, so a notarized and stapled app opens without a warning, offline.

**Sparkle later, if at all.** It adds a framework to sign inside the bundle, a second key pair (Sparkle's own signing key, a secret) and an appcast host. The cask gives one update channel with none of that. The owner can revisit it when non-Homebrew users ask for in-app updates.

## Decisions

| #   | Decision                                                                                                                                                                     | Who                        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| D1  | Ship a signed, hardened-runtime, notarized, stapled `.app` as the macOS host, plus a Homebrew cask.                                                                          | Owner                      |
| D2  | `npm install` stays as it is.                                                                                                                                                | Owner                      |
| D3  | The cloud host agent is bundled as an optional helper, signed with the same identity. The OSS repo takes it from a path and a digest.                                        | Owner                      |
| D4  | Bundle an official Node binary next to `dist/`, with a compiled launcher. No SEA for now.                                                                                    | This RFC, owner to confirm |
| D5  | Developer ID Application certificate for the organization team. Default designated requirement. Bundle id and team id never change.                                          | This RFC                   |
| D6  | `allow-jit` on `node` only as a starting point, unverified. Other exceptions are added one at a time, each with a recorded failure. No App Sandbox. No camera or microphone. | This RFC                   |
| D7  | Login agent through `SMAppService.agent`, user level, with the launchctl plist as fallback.                                                                                  | This RFC, owner to confirm |
| D8  | Sign and notarize on the owner's Mac. Notary credential is an App Store Connect API key in the login keychain. Nothing in CI.                                                | Owner                      |
| D9  | Zip and cask first. Disk image and Sparkle later.                                                                                                                            | This RFC                   |
| D10 | `release.yml` stays unchanged. The owner uploads the signed zip to the Release.                                                                                              | This RFC                   |

## Open questions

1. The bundle identifier and the app's display name. The scripts use `com.kalebtec.browxai` and `Browxai`.
2. Apple silicon only, an Intel build, or a universal app. A universal app doubles the Node payload and needs a universal launcher. The build script defaults to `arm64` and builds a universal app on request.
3. Minimum macOS. 13.0 is the floor for `SMAppService`. Is a lower floor with the launchctl fallback worth the second code path?
4. Where the cask lives: a tap under the organization, or a submission to the main cask repository, which has its own notability and signing rules.
5. Whether to build the stdio bridge so MCP clients can use the app's daemon.
6. Whether the app should ship a minimum helper version, and whether the helper refuses to pair outside a tested daemon range.
7. Whether `doctor` should read the bundled manifest and report the helper's version when it runs from the app.

## Verify on a Mac

The items below were reasoned from documentation and from reading `src/`, then checked one by one. An item marked "Resolved" was observed on one machine, on 2026-11-24: macOS 26.5 (25F71), arm64, Xcode 26.5, Node 26.13.1 as pinned. "Verified on one machine" is the strongest claim any of them makes. The others are open.

### First run on a Mac

The owner ran the scripts from this branch on that machine.

- `scripts/macos/build-app.sh` built an unsigned `Browxai.app` (arm64, 202 MB). Its own layout, symlink and smoke checks passed.
- `release-app.sh` signed the nested `node` with `allow-jit` and the app with Developer ID, the hardened runtime and a secure timestamp. Apple notarized it with status `Accepted`. The first submission took about 45 minutes. The script stapled the ticket, and `spctl` reported `accepted, source=Notarized Developer ID`.
- `verify-app.sh` printed `all checks passed`: the team id and bundle id matched, two Mach-O files were signed and hardened, `stapler validate` passed, the designated requirement named the bundle id and a team, and only `node` carried an entitlement (`com.apple.security.cs.allow-jit`).
- The signed app's bundled Node ran `browxai doctor` with every row green. Through the app's `Resources/bin/browxai` wrapper, `browxai serve --socket` and `browxai call` opened a headless Chromium session, navigated to a page and took a snapshot. The server logged `session: Chromium OS sandbox on (mode auto)`.

Not run yet: `login-item register|status|unregister`, the agent plist running at login, attribution after `execve`, an x86_64 or universal build, the cloud helper embedding, the cask install, and running the app from `/Applications`.

### The list

Resolved:

- **Item 4.** Which entitlements the official Node binary carries, and whether `allow-jit` alone lets a signed Node start and run. **Resolved 2026-11-24, verified on one machine:** with `allow-jit` as the only entitlement, the signed Node ran `browxai doctor`, a daemon and a Playwright-launched Chromium session under the hardened runtime. The keystone suite itself was not run against the signed app, so widen the list only if a later flow fails. What the official binary's own entitlements are was not recorded.
- **Item 15.** That `swiftc -O -target <arch>-apple-macos12.0` builds `macos/launcher/main.swift`. **Resolved for arm64, 2026-11-24:** it compiled on Xcode 26.5 and the launcher ran. The x86_64 build, a `lipo` join, and the launcher on the oldest macOS the app supports are still open.
- **Item 16.** That `pnpm deploy --prod` accepts the root project of this workspace. **Resolved 2026-11-24:** `pnpm --filter browxai deploy --prod` worked on the pinned pnpm, and the resulting bundle passed the layout and symlink checks.
- **Item 17.** That `plutil -extract` reads `package.json`. **Resolved 2026-11-24:** the version and name were read and the build went through. Whether `plutil` or the `sed` fallback answered was not recorded.

Partly resolved:

- **Item 8.** The size of the Node binary for the pinned release and of the zip. The unsigned arm64 app is 202 MB. The Node binary and the zip sizes were not recorded.

Open:

- **Item 1.** The exact attribution rules for a child process of the app, a LaunchAgent and a Terminal, for Local Network, Files and Folders and camera and microphone prompts.
- **Item 2.** Whether the Local Network prompt appears for a plain Node child connecting to a LAN address, and which name it shows. Whether `NSLocalNetworkUsageDescription` in the app's `Info.plist` is what the prompt uses.
- **Item 3.** What Chrome and Chromium do for camera and microphone when launched by the app.
- **Item 5.** That `SMAppService.agent` registers from the bundle, from `/Applications`, and after a Homebrew upgrade, and that Local Network and Files prompts name the app.
- **Item 6.** That `safaridriver --enable` and the Safari engine work with the daemon started by the agent. That `xcrun` from a launchd job finds the active Xcode.
- **Item 7.** That `playwright-core` 1.65.1 runs from inside a bundle path with spaces, and that its browser cache stays in the user's cache directory.
- **Item 9.** That a cask upgrade keeps TCC grants, shown by `verify-app.sh` with `BROWXAI_DR_BASELINE` across two builds and then by a real upgrade.
- **Item 10.** The pasteboard privacy setting in recent macOS, and whether the write-only clipboard path is affected.
- **Item 11.** That a password manager CLI still works when called from the app's daemon.
- **Item 12.** The role needed on the organization team to create a Developer ID certificate and an App Store Connect API key.
- **Item 13.** That the cask installs and upgrades with `brew install --cask` and `brew upgrade --cask` from the tap, passes `brew style` and `brew audit --cask`, and links `browxai` onto `PATH`. That the `launchctl` label (`com.kalebtec.browxai.agent`) and the Application Support folder name in the cask match what the launcher uses, and that the zap list is complete.
- **Item 14.** That `browxai doctor` on a Mac reports the signed app as expected: the `codesign` output parses, the `login-item status` wording maps to the login agent line, and a build from the app's own `node` path is found inside the bundle. The `doctor` run in the first run above was green, but the `macos-app` row's `codesign` parsing and `login-item status` mapping were not singled out.
- **Item 18.** That the official Node release for the pinned version runs on the oldest macOS in `LSMinimumSystemVersion`. It ran on macOS 26.5. Node's own floor can be higher than 13.0.
- **Item 19.** That a process that replaces itself with `node` through `execve` keeps the app's attribution for Local Network and Files prompts, when started by the login agent. This is the largest open item.
- **Item 20.** That `SMAppService.agent(plistName:)` registers from a launcher run by path, that the status values match the messages, and what the agent plist's `AssociatedBundleIdentifiers` does for the name shown in Login Items.
- **Item 21.** That the agent log under `~/Library/Logs/Browxai` gets the daemon's output.
- **Item 22.** That an Intel or universal build assembles, signs and runs, and that `release-app.sh` accepts the cloud helper embedding.

## Slices

1. **This RFC and the scripts.** `release-app.sh`, `verify-app.sh` and `entitlements.plist`, written and syntax-checked, never run.
2. **App bundle layout and launcher code, with the optional helper embedding.** Needs the owner's certificate to verify. Includes the assembly step, the wrappers and the pinned Node download with its checksum. Built and notarized once on one Mac. The helper itself is added by `release-app.sh`, as designed above.
3. **Login item and a `doctor` identity row.** The `doctor` row is written (`src/cli/doctor-macos-app.ts`). The login item belongs to the launcher code of slice 2.
4. **Homebrew cask and the update path.** Written: `packaging/homebrew/browxai.rb`, `scripts/macos/make-cask.sh` and the "Homebrew" section. Never run.
5. **The macOS app section of `RELEASING.md`.** Written.

The related iOS device lane plan is in [RFC 0008](0008-native-app-control.md), section 10. Its Local Network permission is the first one that the app's stable identity helps with.
