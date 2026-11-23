# RFC 0012: A signed, notarized macOS app that hosts the browxai server

**Date:** 2026-11-23
**Status:** Proposed. The owner's direction is recorded below. Design and two scripts only, nothing in `src/` changes. Every statement about macOS behavior that this RFC could not check on a Mac is marked "verify on a Mac" and collected in the last section.
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

**Nested code.** The bundled `node` binary is signed with the fixed identifier `<BUNDLE_ID>.node` and the helper with `<BUNDLE_ID>.cloud`, so a requirement that names either one stays the same across builds. The default identifier of a bare executable is its file name.

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

Slice 2 builds this. Names in angle brackets are placeholders.

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

**Layout and names.** `Contents/Helpers/browxai-cloud`, signed with the fixed identifier `<BUNDLE_ID>.cloud`, the hardened runtime, a secure timestamp and no entitlements. A Rust binary needs no JIT. The wrapper `Contents/Resources/bin/browxai-cloud` resolves its own real path through any symlink and runs the helper. The Homebrew cask links that wrapper onto `PATH`, so the pairing command is `browxai-cloud` in any Terminal. A wrapper on `PATH` is a plain child of Terminal, which is fine: the helper opens an outbound connection to the internet and to the local socket, and neither is a protected resource.

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

## Login item mechanics

User level only. No root, no privileged helper, no daemon in `/Library`. The one admin step on the Mac is `sudo safaridriver --enable`, and the owner runs it in Terminal, outside the app.

**Recommended: `SMAppService` with an agent plist inside the bundle** (macOS 13 and later). The launcher calls `SMAppService.agent(plistName:)` and `register()`, and launchd runs the program the plist names. An agent plist inside a bundle uses bundle-relative paths: `BundleProgram` is `Contents/MacOS/<launcher>`, relative to the app, and not an absolute path. The agent shows in System Settings under Login Items, named after the app, where a person can switch it off. The plist sets:

- `ProgramArguments`: the launcher's own name first, then its arguments (`serve --socket <SOCKET>`). The plist holds no path to `node`. The launcher locates the app's own `Contents/Resources/node/bin/node` and `Contents/Resources/app/dist/cli.js` from its own location and runs them, so the app works wherever it is installed. The launcher also expands the `~` in the socket path, which launchd does not.
- `EnvironmentVariables`: a `PATH` that includes `/opt/homebrew/bin` and `/usr/local/bin`, and any `BROWX_*` setting the user picked. A user-level config layer is the other source.
- `KeepAlive` and `RunAtLoad`, and `AssociatedBundleIdentifiers` set to `<BUNDLE_ID>` so the system ties the agent to the app.

**Alternative: `SMAppService.mainApp`.** The app itself is the login item and starts the daemon as a child. It is simpler and it makes the child's attribution the app by the plain rule. Its cost is that the daemon only runs while the app does.

**Fallback: a plist in `~/Library/LaunchAgents`** written by a `browxai` subcommand and loaded with `launchctl bootstrap gui/<uid>`. It needs no Swift, and the agent then appears in Login Items as a command with no app name. It is the route for the npm install and for a Mac where `SMAppService` misbehaves.

Verify on a Mac: that `SMAppService.agent` runs under the app's identity for Local Network and Files prompts, whether the app must sit in `/Applications` for registration to work, and what a Homebrew install does to the registration on upgrade.

**The socket.** A short path, because a Unix socket path is limited to 104 bytes on macOS: `~/Library/Application Support/<APP_DIR>/run/browxai.sock`. The daemon already creates it owner-only. The default workspace stays `~/.browxai`, which has no permission cost.

## How MCP clients connect

- **Shell and SDK.** `browxai call` and `browxai tools` (RFC 0011) and the SDK's `createBrowxai({ endpoint: "unix://..." })` connect to the socket. These commands never look for a socket (`src/cli/shell-connect.ts`), so the `Resources/bin/browxai` wrapper sets `BROWX_SOCKET` to the app's path when the variable is unset.
- **MCP clients that spawn a stdio server** (Claude Desktop, Cursor and others) start `browxai` and talk over its standard input. That process is its own server with its own session registry. **No stdio-to-socket bridge exists today.** An MCP client that wants the app's daemon needs one, which is a new subcommand. It is a follow-up and not part of the four slices below. Until then, the app's daemon serves the shell route, the SDK, the operator channel and live view, and a stdio client keeps running its own browxai process as it does today.

## npm and the app side by side

Both can be installed. They share no state unless the user points them at the same workspace and socket. Whichever `browxai` comes first on `PATH` wins. The cask links `browxai` into Homebrew's `bin`, and `npm install -g` writes to npm's prefix, so the user's `PATH` order decides. Nothing in either install overwrites the other.

`browxai doctor` gets one row (slice 3). It reports where the running binary came from and, on macOS, the facts from `codesign -dv --verbose=4` for `process.execPath`: identifier, team identifier, flags (is `runtime` set), and the signing authority class. For an npm install it reports that the program is unsigned JavaScript run by the user's Node, with Node's own signature. `codesign` writes its facts to standard error. The row is informational and never fails doctor.

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

Slice 5 adds a line to `RELEASING.md`. This RFC does not edit it.

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

1. The bundle identifier and the app's display name.
2. Apple silicon only, an Intel build, or a universal app. A universal app doubles the Node payload and needs a universal launcher.
3. Minimum macOS. 13.0 is the floor for `SMAppService`. Is a lower floor with the launchctl fallback worth the second code path?
4. Where the cask lives: a tap under the organization, or a submission to the main cask repository, which has its own notability and signing rules.
5. Whether to build the stdio bridge so MCP clients can use the app's daemon.
6. Whether the app should ship a minimum helper version, and whether the helper refuses to pair outside a tested daemon range.
7. Whether `doctor` should read the bundled manifest and report the helper's version when it runs from the app.

## Verify on a Mac

Everything below was reasoned from documentation and from reading `src/`. None of it was run.

1. The exact attribution rules for a child process of the app, a LaunchAgent and a Terminal, for Local Network, Files and Folders and camera and microphone prompts.
2. Whether the Local Network prompt appears for a plain Node child connecting to a LAN address, and which name it shows. Whether `NSLocalNetworkUsageDescription` in the app's `Info.plist` is what the prompt uses.
3. What Chrome and Chromium do for camera and microphone when launched by the app.
4. Which entitlements the official Node binary carries, and whether `allow-jit` alone lets a signed Node start and run the keystone suite on the target macOS. Node's own release is signed with broader entitlements, so a failure here is likely and the list may need `allow-unsigned-executable-memory`.
5. That `SMAppService.agent` registers from the bundle, from `/Applications`, and after a Homebrew upgrade, and that Local Network and Files prompts name the app.
6. That `safaridriver --enable` and the Safari engine work with the daemon started by the agent. That `xcrun` from a launchd job finds the active Xcode.
7. That `playwright-core` 1.65.1 runs from inside a bundle path with spaces, and that its browser cache stays in the user's cache directory.
8. The size of the Node binary for the pinned release and of the zip.
9. That a cask upgrade keeps TCC grants, shown by `verify-app.sh` with `BROWXAI_DR_BASELINE` across two builds and then by a real upgrade.
10. The pasteboard privacy setting in recent macOS, and whether the write-only clipboard path is affected.
11. That a password manager CLI still works when called from the app's daemon.
12. The role needed on the organization team to create a Developer ID certificate and an App Store Connect API key.

## Slices

1. **This RFC and the scripts.** `release-app.sh`, `verify-app.sh` and `entitlements.plist`, written and syntax-checked, never run.
2. **App bundle layout and launcher code, with the optional helper embedding.** Needs the owner's certificate to verify. Includes the assembly step, the wrappers and the pinned Node download with its checksum.
3. **Login item and a `doctor` identity row.**
4. **Homebrew cask and the update path.**
5. **A release process line in `RELEASING.md`.**

The related iOS device lane plan is in [RFC 0008](0008-native-app-control.md), section 10. Its Local Network permission is the first one that the app's stable identity helps with.
