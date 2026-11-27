# RFC 0015: A staged, auto-updating runtime and launcher for npm installs

**Date:** 2026-11-27
**Status:** Accepted. Decisions D1 to D21 are signed off with their recommended defaults, and five of them (D1, D2, D3, D5, D15) carry refinements from the sign-off, folded into the text below. Design only. No code, build or test is part of this change.
**Trigger:** An npm install of browxai that MCP clients launch by absolute path stays on the version that wrote the client entry. A machine was found running 0.10.0 while 0.21.0 was published, and no part of the product could move it.

## What this is for

MCP clients start browxai from a path written into their config. Today that path names one version's `dist/cli.js`, so the client runs that version until someone edits the config. This RFC specifies a runtime directory that holds each release side by side, one launcher path that never changes, a manual and a background updater that stage, verify and smoke-check a release before it becomes `current`, and a rollback that needs no network.

Goals:

1. A client entry names one launcher path. A new release reaches the client at its next start with no config edit.
2. A release is staged, verified and smoke-checked before it becomes `current`. A release that fails a check never becomes `current`.
3. A running server keeps the version it started with. A switch never removes files a live process uses.
4. Rollback is one command and works offline.
5. The launcher makes no network call. The MCP server makes no update call. Only the updater talks to the registry. No MCP tool is added, no capability changes and nothing runs as root.
6. The signed macOS app of [RFC 0012](0012-signed-macos-app.md) keeps its own update path, the Homebrew cask. This design never touches the app bundle.

Non-goals: Windows beyond a docs paragraph, hot-swapping code inside a running process, updating the macOS app, and updating plugins under `<workspace>/plugins/`.

## Measured facts

Observed on one machine with a hand-built runtime directory, called `<runtime>` here.

- The runtime's `package.json` asked for `browxai` at `^0.10.0`, and the installed tree was 0.10.0. A caret on a `0.x` version allows `>=0.10.0 <0.11.0`, so that tree could never move past 0.10.x.
- Most of the machine's client configs launched `node <runtime>/node_modules/browxai/dist/cli.js`, the 0.10.0 tree. One launched the copy under `<runtime>/current`. Every client on 0.10.0 missed the 0.13.0 change that made the installed Google Chrome the default browser.
- A hand-written launchd job installed `browxai@latest` into a new directory every six hours and repointed `current`. Most clients never read `current`, so the job's updates reached almost nothing. The script also had these defects, each of which this design avoids:
  - a lock directory with no age limit, so one killed run stopped updates for good;
  - `npm install` with dependency install scripts enabled and no signature or provenance check;
  - `rm -rf` on the target before the move, which removes files from under running servers when the target is the version already in use;
  - `ln -sfn`, which unlinks and then creates, so `current` is missing for an instant;
  - pruning by modification time with no check for versions in use;
  - no smoke check, no rollback, no channel and no delay after publish.

Read from the source at the commit this branch starts from.

| Fact                                                                                                                                                                                                                 | Where                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `init` writes the absolute path of its own `dist/cli.js` into every client entry, so whatever tree ran `init` is pinned.                                                                                             | `src/cli/init.ts`                                             |
| The only "always current" option `init` prints is `npx -y browxai`, which needs the network on every start.                                                                                                          | `src/cli/init.ts`                                             |
| Nothing in `src/` checks for updates. A search for `registry.npmjs`, `npm view` and `update-notifier` finds nothing.                                                                                                 | `rg` over `src/`                                              |
| The bin is `dist/cli.js`. `files` is `dist` and `THIRD_PARTY_NOTICES.md`. Four production dependencies, `playwright-core` exact, the others with ranges. `engines.node` is `>=22`. The tarball carries no CHANGELOG. | `package.json`                                                |
| Publishing runs only through `release.yml`, as `npm publish --provenance --access public` with no `--tag`. The release ritual verifies with `npm audit signatures`.                                                  | `.github/workflows/release.yml`, `RELEASING.md`               |
| A bad release is handled with `npm deprecate`, or unpublished within 72 hours.                                                                                                                                       | `RELEASING.md`                                                |
| Pre-1.0 minors carry default-behaviour changes, each with an `**Upgrading**` paragraph in the CHANGELOG. Several releases have the literal note "Nothing to do."                                                     | `docs/tool-reference.md` "Stability & semver", `CHANGELOG.md` |
| Code loads lazily through `await import(...)` in 16 places, and `playwright-core` loads files lazily too. Deleting a version directory under a live process breaks it mid-session.                                   | `rg "await import\(" src`                                     |
| The daemon exits 0 on `SIGTERM` and `SIGINT`. The app's agent plist uses `KeepAlive` with `SuccessfulExit` false, so a non-zero exit restarts it.                                                                    | `src/cli/serve.ts`, `macos/launchagent.plist.in`              |
| `doctor` exits 1 when any non-informational row fails. The `macos-app` row is informational and takes an injected command runner.                                                                                    | `src/cli/doctor.ts`, `src/cli/doctor-macos-app.ts`            |
| Subcommands are add-only through `registerCommand`.                                                                                                                                                                  | `src/cli/register-commands.ts`                                |
| A bridge keeps the code it loaded when its files are replaced, and reconnects to a restarted daemon.                                                                                                                 | [RFC 0013](0013-stdio-socket-bridge.md)                       |

## 1. Runtime layout

```text
<runtime>/                         $BROWX_RUNTIME_DIR. Mode 0700, owned by the user.
  layout.json                      {"schemaVersion":1}. Marks a directory this code manages.
  runtime.json                     owner settings: channel, autoUpdate, majorPolicy, cooldownHours. Mode 0600.
  node-path                        absolute path of the node the shim and the agent use (D3).
  bin/browxai                      the launcher shim (section 2). Never changes between versions.
  current -> versions/0.22.0       relative symlink. The only mutable pointer.
  versions/                        mode 0700.
    0.21.0/                        one npm prefix per version, never written after its switch.
      package.json                 {"private":true,"dependencies":{"browxai":"0.21.0"}}, exact version.
      package-lock.json
      node_modules/browxai/dist/cli.js
      .runtime-meta.json           integrity, publishedAt, installedAt, node used, checks passed, verification result.
  staging/<version>-<pid>/         installs in progress. Swept after 1 hour when the pid is gone.
  state.json                       lastCheck, nextCheck, lastResult, pending, held, failed, previous, backoffUntil, contacts, applies.
  journal.jsonl                    one line per check, apply, rollback and gc. Capped at 1 MB with one rotation.
  notes/<version>.md               Upgrading notes for a pending or applied version (section 6).
  lock                             {pid, startedAt}. Stale after 1 hour or when the pid is gone.
```

**`layout.json` and its schema version.** The file carries `schemaVersion`, an integer, starting at 1. A command reads it first. A version it doesn't know (a newer runtime wrote the directory) makes every write command refuse with the version it found and the one it supports. Read-only commands (`status`) still report. A later layout change bumps the number and ships a migration step in the same release.

**The switch is atomic.**

1. Create `current.tmp-<pid>` as a symlink to `versions/<v>`.
2. `rename(2)` it over `current`, through Node's `fs.renameSync`, which renames the link itself.
3. Never `ln -sfn`. Never `mv` without `-h` on macOS, because BSD `mv tmp current` moves into the directory `current` points at.

**A running process keeps its version.**

1. The shim resolves `current` once and execs node on the resolved `versions/<v>/.../cli.js`. The process never reads `current` again.
2. Node resolves the main module's real path unless `--preserve-symlinks-main` is set, so lazy imports resolve under `versions/<v>` too. Point 1 makes this a second guard.
3. A version directory is never written after its switch. A reinstall of the same version goes to a new staging directory and replaces nothing in use.
4. Garbage collection skips versions in use (below).

**Retention.** Keep `current`, `previous` and one more, N=3 (D10). A version past N is removed only when no live process uses it. The check scans `ps -axo pid=,command=` for `<runtime>/versions/<v>/`, which works because the shim's `exec` puts the resolved path in node's argv. No lease files. A held or failed version's staging directory goes at once.

**Rollback.** `browxai runtime rollback` switches `current` to `previous` and marks the version it left as held ("rolled back by user"), so the agent doesn't apply it again. The hold clears when a newer version appears, or with `runtime update --version <v>`. `rollback --to <v>` works for any kept version. No network.

**Refusals at every command.** A command refuses, names the reason and changes nothing when:

- the runtime directory, `versions/`, or any file in them is owned by another user;
- the runtime directory or `versions/` is group-writable or world-writable;
- the runtime directory or `versions/` is a symlink, checked with `lstat` on the path as given;
- the runtime directory overlaps `$BROWX_WORKSPACE`, because a tool with `file-io` writes under the workspace and runtime code there would let an agent plant code that runs at the next launch;
- the process runs as root;
- the directory exists without `layout.json` (a hand-made layout), in which case the command prints migration steps (section 11);
- `layout.json` has a `schemaVersion` the command doesn't know.

## 2. The launcher

**A POSIX `sh` shim at `<runtime>/bin/browxai` (D2).** `runtime install` writes it. It's the same for every version. It resolves `current` with `cd -P` and `pwd -P`, which POSIX defines and which behave the same on macOS and Linux. It doesn't use `readlink -f`, which is a GNU extension and missing from older macOS releases.

```sh
#!/bin/sh
# browxai runtime launcher: runs the version `current` points at, resolved once.
rt=$(cd -P -- "$(dirname -- "$0")/.." && pwd -P) || exit 127
target=$(cd -P -- "$rt/current" 2>/dev/null && pwd -P) || {
  echo "browxai: no current version in $rt. Run: browxai runtime install" >&2
  exit 127
}
cli=$target/node_modules/browxai/dist/cli.js
[ -f "$cli" ] || {
  echo "browxai: $cli is missing. Run: $rt/bin/browxai runtime rollback" >&2
  exit 127
}
node=${BROWX_RUNTIME_NODE:-}
[ -n "$node" ] || node=$(cat -- "$rt/node-path" 2>/dev/null)
[ -x "$node" ] || node=$(command -v node) || {
  echo "browxai: no node found. Set BROWX_RUNTIME_NODE." >&2
  exit 127
}
BROWX_RUNTIME_DIR=$rt BROWX_RUNTIME_VERSION=${target##*/} exec "$node" "$cli" "$@"
```

- **Arguments.** `"$@"` passes every argument unchanged, spaces and empty strings included. Every expansion that holds a path is quoted or sits in an assignment, where the shell doesn't split it. `--` guards `cd`, `dirname` and `cat` against a path that starts with `-`. A test runs the shim under `dash` and the macOS `/bin/sh` with arguments that hold spaces, quotes and an empty string.
- **No network.** It resolves one directory and reads one file, then execs, so the PID, standard input and output, signals and exit codes are the server's.
- **Two env vars.** `BROWX_RUNTIME_DIR` and `BROWX_RUNTIME_VERSION` tell `doctor` and the daemon that they run from the runtime. Both are informational. No gate reads them.
- **Why a script launcher is enough here.** RFC 0012 needs a compiled launcher because the app's code identity decides which program macOS attributes permission prompts to. An npm install has no such identity: prompts already attach to the client or to `node`.

**Client entries.** Every entry names the shim by absolute path. A switch changes what the next start runs, and no client config changes.

| Client use                                               | Entry                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| stdio server                                             | `command: <runtime>/bin/browxai`, `args: []`, `env: {BROWX_WORKSPACE, ...}` as today |
| attached stdio server                                    | the same command, with `BROWX_ATTACH_CDP` and `BROWX_CAPABILITIES` in `env`          |
| bridge to a user-run daemon (RFC 0013)                   | `command: <runtime>/bin/browxai`, `args: ["bridge", "--socket", PATH]`               |
| user-run daemon (a launchd or systemd job the user owns) | `ProgramArguments: [<runtime>/bin/browxai, "serve", "--socket", PATH]`               |

**How each process picks up a new version.**

- **A stdio server**, a child of the client, keeps its version until the client starts it again. No signal is sent: killing an MCP child under a client breaks the client's session.
- **A bridge** keeps its loaded code, as RFC 0013 describes. Its version needn't match the daemon's.
- **A daemon** (`serve --socket`) started through the shim drains itself when idle (D11). It reads `current` every 5 minutes, a local read. When `current` differs from its own version, and no socket client is connected and no session is open for 15 minutes, it logs one line and exits 75 (`EX_TEMPFAIL`). A launchd job with `KeepAlive` and `SuccessfulExit` false, or a systemd unit with `Restart=on-failure`, starts it again through the shim, on the new version. A connected bridge reconnects. A daemon under a job that doesn't restart on a non-zero exit stops, and the doctor row says so. This applies only with `BROWX_RUNTIME_DIR` set and `BROWX_RUNTIME_DAEMON_RESTART=idle`, the default under the runtime.
- **The macOS app's daemon** runs the bundle's sealed code and is outside this mechanism.

**`init` from a runtime.** When `init` runs from a runtime version (the real path of `dist/cli.js` sits under `<BROWX_RUNTIME_DIR>/versions/`, or `BROWX_RUNTIME_DIR` is set), it writes `<runtime>/bin/browxai` as `command`. Without this change, `init` from a runtime would write `versions/<v>/...` and pin the version again. The bridge branch for the app is unchanged.

## 3. Commands

```text
browxai runtime install  [--dir PATH] [--channel latest|next] [--no-agent] [--link] [--write-client-config] [--profile-dir DIR]...
browxai runtime update   [--check] [--version V] [--allow-major] [--now] [--auto]
browxai runtime rollback [--to V]
browxai runtime status   [--json]
browxai runtime notes    [V]
browxai runtime config   auto-update on|off | channel latest|next | major allow|hold
browxai runtime gc
browxai runtime uninstall [--keep-versions] [--yes]
```

- **`install`** works from any browxai: a global npm install, `npx` or a checkout. It creates the layout, records `node-path` (the absolute `process.execPath`), runs the same stage, verify, smoke and switch steps as `update`, writes the shim, installs the background job unless `--no-agent`, and prints the client entries. Exit 0, or 1 when the first install fails a check, which leaves no `current`.
  - `--write-client-config` rewrites user-level entries whose command names a browxai `dist/cli.js` or `npx browxai`, through the code in `init-user-config.ts`. It writes only the active client config of each client: the one that client reads in the current environment. It never searches for other profile directories. Each `--profile-dir DIR` adds one more config directory, named explicitly. Without the flag, `install` prints the entries and writes nothing (D15).
  - `--link` symlinks the shim into a user bin directory on `PATH` (D17), and warns when another `browxai` comes earlier on `PATH`.
- **`update`** reads the registry. With a newer allowed version it stages, verifies, smoke-checks, switches and records. With none it exits 0 and says so.
  - `--check` downloads nothing and prints what it would do and why (delay, hold, major, engines).
  - `--version V` installs a given version, up or down. A downgrade warns once.
  - `--now` skips the delay after publish. A manual run without `--auto` skips it too.
  - `--auto` is the background job's mode: rate limits, backoff, jitter and the delay apply, and output goes to the journal.
- **`rollback`**, **`gc`**: section 1.
- **`status`** shows what the doctor row shows, plus kept versions and the pids that use them.
- **`notes`** prints the Upgrading notes between the version this process runs and `current`, or for `V`.
- **`config`** writes `runtime.json`. It and `install` are the only writers.
- **`uninstall`** removes the background job, refuses while a process uses a version unless `--yes`, removes the directory, and prints the client entries that still name the shim. It never touches `$BROWX_WORKSPACE`.
- **Inside the macOS app**, every `runtime` verb prints that this browxai is the signed app and updates with `brew upgrade --cask browxai`, and exits 2.

Exit codes follow the shell route: 0 ok, 1 a failed check or an internal error, 2 usage or a refused context, 3 the registry unreachable on a manual run or `--check`.

## 4. Update source and verification

**Source.** The registry in the user's npm config, through npm: `npm view browxai --json` for the packument, `npm install` for the tarball and its dependencies. A private mirror in `.npmrc` is honoured. No GitHub API call and no second host.

**Selection, in order.**

1. Read the dist-tag for the channel, `latest` or `next` (D6).
2. Skip a version that isn't newer than `current`, unless `--version`.
3. Skip a version the packument marks `deprecated`. `npm deprecate` is how the release process already withdraws a bad release, so the updater obeys it with no new infrastructure. When `current` itself is deprecated, doctor warns and quotes the message.
4. Delay: skip until `time[v]` plus `cooldownHours` has passed, for `--auto` only (D8).
5. Version guard (D7).
6. Hold a version whose `engines.node` excludes the shim's node, with a reason that names both versions.
7. Skip held versions and versions with three failed applies.

**Install into staging.**

```text
npm install --prefix <staging> browxai@<exact V> --omit=dev --ignore-scripts --no-audit --no-fund \
            --before <publishedAt(V) + 1h>
```

- `--ignore-scripts`: no dependency lifecycle script runs. The production tree has no native addon.
- `--before`: transitive ranges resolve to what existed when V was published, which is as close as npm allows to the tree CI tested, and excludes a dependency version published after the release.
- An exact version with no caret, which ends the `^0.x` failure above.
- After install, `node_modules/browxai/package.json` must report V and `dist/cli.js` must exist.

**How npm is run (D3).** The updater never depends on the login shell's `PATH`. Under launchd or systemd that `PATH` is absent, and with node under mise, nvm or Homebrew, `npm` isn't on the system `PATH` either. So:

- the updater runs npm as `<node-path> <npm-cli.js>`, where `npm-cli.js` is found from the recorded node's install prefix (`<prefix>/lib/node_modules/npm/bin/npm-cli.js` on macOS and Linux), and `install` checks that file exists;
- the background job's environment sets `PATH` with `dirname(node-path)` first, then `/usr/bin:/bin`, so anything npm spawns finds the same node;
- `doctor` warns when the recorded node is gone, which happens when a version manager prunes it, and names `runtime install` to record a new one.

**Verification (D5).**

- **S1: registry signatures.** `npm audit signatures`, run in staging, must exit 0. It checks the registry signature of every installed package, and the provenance attestation where one exists. Before S1's code relies on it, S1 runs it against the real published browxai (the current release and the one before) and records the exit code and output shape in the PR. That confirms the registry signature check passes on today's releases before any provenance pin exists.
- **S3: provenance pinned to the release workflow.** Once npm trusted publishing over OIDC is confirmed live for the package, S3 pins the provenance identity of browxai itself. It reads `versions[V].dist.attestations.url` from the same registry, decodes the SLSA provenance statement, and requires:
  - the subject digest to equal the tarball's `dist.integrity`;
  - `workflow.repository` to equal `https://github.com/kalebteccom/browxai`;
  - `workflow.path` to equal `.github/workflows/release.yml`, the trusted-publisher workflow;
  - `workflow.ref` to equal `refs/tags/v<V>`.

  The signature on the bundle stays delegated to npm. `npm audit signatures` checks the Sigstore bundle but compares the source repository to nothing, so a package published with valid provenance from another repository would pass it. The pin closes that case. From S3 on, a browxai version with no attestation fails verification.

**Smoke check (D9).** From staging, with the shim's node:

1. `cli.js --version` prints exactly V within 10 seconds.
2. An MCP handshake: start the staged stdio server with `BROWX_WORKSPACE` set to a fresh temporary directory, send `initialize`, `initialized` and `tools/list`, and require `serverInfo.version` to equal V and at least one tool. Then close standard input. 20 seconds at most. No browser starts.
3. No new `doctor` failures: run `doctor --json` for staging and for `current`, and fail only when a row that passes on `current` fails on staging. Rows that depend on the machine (Firefox missing, no `adb`) fail on both and don't block. A plain `doctor` exit code would block on any machine without the optional engines.
4. From S2: the staged `runtime status --json` exits 0 and parses, so a release whose updater can't start never becomes `current`.

A failure discards staging, increments `failed[V]`, writes the journal and leaves `current` alone. After three failures V is held until a newer version appears.

**A Playwright bump on a machine without Chrome (D20).** When staging's `playwright-core` differs from `current`'s and the `chromium` doctor row on `current` reports the bundled fallback (no installed Chrome), V is held with a reason that names the manual steps. The updater never downloads a browser, since that host isn't the registry. Machines that use Google Chrome need nothing.

**What the trust rests on.** npm registry signatures, GitHub OIDC provenance from `release.yml` behind the manual `release` environment approval, and the identity pin. There's no project-held signing key to lose or rotate. The registry and GitHub are trusted parties.

## 5. Channels and the version guard

**Channels (D6).** `latest` is the default and equals what `npm install browxai` gets. `next` is opt-in, for prereleases such as `0.23.0-next.1`. `release.yml` publishes with no `--tag` today, so `next` needs `--tag next` when the git tag has a `-`, and a RELEASING step. That's an S3 item and an owner-approved release change. The channel comes from `BROWX_RUNTIME_CHANNEL` or `runtime.json`, never from workspace config or `set_config`.

**Version guard (D7).**

- From 1.0.0, a major is never crossed automatically. `update --allow-major` or `runtime config major allow` opts in. The job records the version as pending and held, and doctor shows it.
- Before 1.0, minors cross automatically and the Upgrading notes are surfaced. The semver policy puts breaking changes in minors before 1.0, so a guard on majors protects nothing there. Holding minors would recreate the failure this RFC fixes: a machine on 0.21 while 0.22, 0.23 and 0.24 ship.

## 6. Upgrading notes

- The tarball has no CHANGELOG. The build generates `dist/upgrading.json` from `CHANGELOG.md` (D13): per version, the `**Upgrading from X.**` paragraph and any per-entry `**Upgrading.**` sentences. It's small, readable offline, and covered by the tarball's integrity and provenance.
- The updater writes the notes for every version between `previous` and `current` to `notes/<V>.md` and to the journal.
- doctor shows a line for unseen notes until `runtime notes` runs once. A note that is exactly "Nothing to do." gets no line.
- A server prints one standard-error line on its first start of a new version, naming `browxai runtime notes <V>`. Standard error reaches only client logs, so doctor is the dependable surface.

## 7. The background job

**macOS.** `~/Library/LaunchAgents/com.kalebtec.browxai.runtime-update.plist`, loaded with `launchctl bootstrap gui/<uid>`. The label differs from the app's `com.kalebtec.browxai.agent`.

- `ProgramArguments`: `<runtime>/bin/browxai runtime update --auto`.
- `StartInterval` 3600, `RunAtLoad` true, `ProcessType` Background, `LowPriorityIO` true, `Nice` 10.
- `EnvironmentVariables`: `PATH` set to `dirname(node-path):/usr/bin:/bin`, and `BROWX_RUNTIME_NODE` set to the recorded node (D3).
- Standard output and error go to `<runtime>/agent.log`, mode 0600. The journal is the record.

**Linux.** `~/.config/systemd/user/browxai-runtime-update.service` (`Type=oneshot`, `ExecStart=<runtime>/bin/browxai runtime update --auto`, `Environment=PATH=<dirname(node-path)>:/usr/bin:/bin`, `Environment=BROWX_RUNTIME_NODE=<node-path>`, `Nice=10`, `IOSchedulingClass=idle`) and a `.timer` (`OnCalendar=hourly`, `Persistent=true`, `RandomizedDelaySec=15m`), enabled with `systemctl --user enable --now`. Without lingering the timer runs only while the user has a session.

**Windows.** Docs only (D18): no job and no shim. `npx -y browxai@latest` resolves the newest version on every start and needs the network to start, or `npm install -g browxai@latest` updates by hand.

**The job runs `current`'s updater.** If it exits 1 with an internal error three runs in a row, the next run uses `previous`'s updater once, and the journal and doctor say so (D19). With smoke step 4, a release that breaks the updater can't strand the machine.

**Policy inside `update --auto` (D12).**

| Knob                       | Value                                                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Check interval             | 6 hours plus 0 to 60 minutes of jitter. The job wakes hourly and returns at once when early.                |
| After boot                 | The first contact waits 10 to 30 minutes after the first run that follows boot.                             |
| Registry contacts          | at most 6 per 24 hours                                                                                      |
| Applies                    | at most 2 per 24 hours                                                                                      |
| Failed smoke checks        | 3 per version, then held                                                                                    |
| Backoff on a network error | 1 hour, doubling, capped at 24 hours, reset by a successful check                                           |
| Delay after publish        | 24 hours for `--auto` (D8), none for a manual run                                                           |
| Lock                       | `<runtime>/lock` with pid and start time. Stale when the pid is gone or after 1 hour. A second run exits 0. |

**Offline.** A failed packument fetch writes `offline` to the journal, applies backoff and leaves `current` alone. It exits 0 under `--auto` and 3 on a manual run. The launcher never needs the network, so servers start offline. A half-done install stays in `staging/` and is swept later.

## 8. Security posture

An auto-updater turns "a bad version was published" into "a bad version runs on every machine within hours". The mitigations, by weight:

1. **Integrity and identity.** Registry signatures and provenance through `npm audit signatures` (S1). Provenance pinned to the repository, the release workflow and the version's tag (S3). Exact versions, `--before` for transitive dependencies, `--ignore-scripts`.
2. **Time.** A 24-hour delay and the `deprecated` skip give the maintainers a window to `npm deprecate` a bad release before most machines take it.
3. **Who can write the runtime directory.** The owner only: mode 0700 directories and 0600 state files, and the refusals in section 1. Code running as the same user can still write it, as with any `npm install -g`, and this design doesn't defend against that.
4. **No privilege.** It refuses root, uses no `sudo`, writes no system path, and uses only the user's launchd domain or `systemctl --user`.
5. **Settings come from the environment or the owner's file only.** Channel, auto-update, major policy and the delay come from `BROWX_RUNTIME_*` variables or `<runtime>/runtime.json`. The workspace `config.json`, `set_config` and every MCP tool can't set them, so an agent with tool access can't switch the channel, turn verification down or roll back to an older version. `BROWX_EXTENSIONS_DIR` follows the same rule.
6. **No new network from servers.** The MCP server and the launcher make no update calls. The daemon's drain check reads a local symlink.
7. **Opt-out (D16).** `BROWX_RUNTIME_AUTO_UPDATE=off` or `runtime config auto-update off`. It fails closed: a value outside `on|1|true|yes|off|0|false|no` turns auto-update off and logs a warning. "Off" in either place wins. The job reads its own environment, not the shell's, so the doctor row says where the setting came from.
8. **Capability posture unchanged.** No tool, no capability and no default changes. A version switch can change the defaults of the next server start, because pre-1.0 minors do. The Upgrading notes and D7 cover that.
9. **The signed app never runs runtime code.** If the app's daemon ran JavaScript from a user-writable directory, anything that can write it would act under the app's identity. `runtime` verbs exit 2 inside the app, and an S1 test pins it.
10. **Logs.** The journal records versions, integrity hashes, reasons and timings. It records no tokens and no npm config values. `.npmrc` auth stays in npm.

## 9. The macOS app and the Homebrew cask

- The app's daemon runs code from inside the sealed bundle, and changing anything there breaks the signature and the notarization staple. The runtime updater never touches the app (D14).
- The app updates with `brew upgrade --cask browxai`. The runtime job never runs it: it replaces an app in `/Applications` and restarts its agent, which is the user's and Homebrew's call.
- Inside the app, the doctor `runtime` row says the app updates through Homebrew. The app makes no update network call.
- With both installed, `PATH` order decides which `browxai` a shell runs, and `install --link` warns about it. Client entries name absolute paths and aren't affected.
- The cask doesn't change. Its `zap` list doesn't include the runtime directory, which has its own `runtime uninstall`.

## 10. `doctor`

A new `runtime` row, informational like `macos-app`: it never changes the exit code, except for a verification failure, which is a ✗ because it points at a supply-chain problem. Shown on every platform. It makes no network call: it reads `state.json`, `current` and `runtime.json`.

| State                        | Line                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Not from a runtime           | `− not running from a browxai runtime. Client entries that name <path> don't update.`            |
| From the app                 | `− signed app. Updates through Homebrew: brew upgrade --cask browxai`                            |
| Up to date                   | `✓ 0.22.0 (channel latest), checked 2h ago, next check in ~4h, auto-update on (runtime.json)`    |
| Pending                      | `⚠ 0.23.0 available, waits until <time>`, or held with its reason (major, Node engine, Chromium) |
| Process older than `current` | `⚠ this process runs 0.21.0, current is 0.22.0. Restart the MCP client to pick it up`            |
| Notes unseen                 | `⚠ Upgrading notes for 0.22.0: browxai runtime notes`                                            |
| Last apply failed            | `⚠ 0.23.0 failed its smoke check twice (<reason>). current stays 0.22.0`                         |
| Verification failed          | `✗ 0.23.0 failed signature or provenance verification and is held`                               |
| Auto-update off              | `− auto-update off (<source>)`, with the available version when a cached check knows it          |
| `current` deprecated         | `⚠ 0.22.0 is deprecated: "<message>". Run browxai runtime update`                                |
| Recorded node missing        | `⚠ the recorded node at <path> is gone. Run browxai runtime install`                             |
| Daemon drift                 | `⚠ the daemon on <socket> runs 0.21.0, current is 0.22.0. It restarts when idle`                 |

`--verbose` adds the kept versions, `previous`, the pids in use, the node path and the registry URL npm reported at the last check. The daemon drift detail reuses the `macos-app` row's 2-second socket probe plus the handshake's `serverInfo.version`.

## 11. Install, migration and uninstall

**A new machine.**

```sh
npx -y browxai runtime install
```

It prints the runtime directory and version, whether the job loaded, one `claude mcp add-json` line per entry, and the entries for the other clients, which `--write-client-config` writes. It notes that these entries name `<runtime>/bin/browxai`, so they follow updates.

**A hand-made layout.** When the runtime path holds a directory without `layout.json`, `install` changes nothing and prints the steps:

1. Unload and remove any job that updates that directory.
2. Move the directory aside, then run `browxai runtime install`.
3. Point client entries at the shim: `--write-client-config` for the active config of each client, and `--profile-dir DIR` once per further config directory the user names.
4. Remove the old directory once no process uses it.

It does none of these itself, because they touch jobs and files it didn't create.

**Uninstall.** `browxai runtime uninstall` (section 3). It names the client entries that still point at the shim.

## 12. Tests

All run in CI, none on a developer machine.

1. **Unit, pure policy.** Selection (newer, deprecated, delay, the D7 guard, engines, held, failure count), schedule (jitter bounds, contact and apply caps, backoff sequence, lock staleness), settings (fail-closed env parsing, env over `runtime.json`), notes extraction from a CHANGELOG fixture ("Nothing to do." gives no notes). Injected clock and random source.
2. **Unit, filesystem and commands with fakes.** A fake registry port and a fake command runner for `npm`, `launchctl`, `systemctl` and `ps`, injected the way the `macos-app` doctor row takes its runner. Temporary directories for the runtime. Cases:
   - `current` stays valid at every step, with a crash injected between staging and the rename;
   - an existing version directory is never written;
   - `gc` skips a version in use;
   - every refusal in section 1, including a symlinked or group-writable `versions/` and an unknown `schemaVersion`;
   - the plist and unit text are exact (snapshot), with `dirname(node-path)` first on `PATH`;
   - npm is invoked as `<node-path> <npm-cli.js>`;
   - `--write-client-config` writes only the active config, and touches another profile directory only when `--profile-dir` names it;
   - `runtime` exits 2 inside a fake app bundle;
   - `init` writes the shim path from a runtime.
3. **The shim.** `sh -n`, then runs under `dash` and `bash --posix` on Linux, and under `/bin/sh` on the macOS CI lane when one is available, against a temporary layout with a stub `cli.js` that prints its argv and pid. Asserts argv passes through unchanged (spaces, quotes, an empty string, a leading `-`), the env vars, the exit code, that the pid is the shim's, and the clear errors when `current` or node is missing. A runtime path that contains a space is one of the fixtures.
4. **Switch and rollback, integration, Linux CI, no browser.** `pnpm pack` the build twice as versions A and B. A small loopback registry serves the packuments (with `time`, `dist-tags` and `deprecated`) and the tarballs, and dependencies resolve from a pre-filled npm cache. Steps: `install` gets A; a stdio server starts through the shim and stays up; B is published and `update --now` switches; the A server still answers `tools/list` as A after a forced `gc`; a new start answers B; `rollback` gives A; a version C whose `--version` lies fails the smoke check and never becomes `current`; a deprecated D is skipped. `npm audit signatures` can't run against a fake registry, so it's unit-tested through the runner fake.
5. **Real registry signatures (S1).** A test on the release lane, after publish, runs `npm audit signatures` against the version just published and the one before (D5 refinement).
6. **Daemon drain.** `startServeForTests` with a temporary runtime env. Flip `current`, keep a connection open and assert no exit, close it, advance a fake clock and assert exit 75. With a session open, assert no exit.
7. **By hand on a Mac.** The launchd job loading and its behaviour across sleep, the real npm path with `--before` and `audit signatures`, the migration steps, and a Claude Code session started before and after a switch.

## 13. Semver

Additive, so a minor. `runtime` is a new subcommand. `BROWX_RUNTIME_DIR`, `BROWX_RUNTIME_CHANNEL`, `BROWX_RUNTIME_AUTO_UPDATE`, `BROWX_RUNTIME_NODE` and `BROWX_RUNTIME_DAEMON_RESTART` are new documented keys. `init`'s entry changes only when it runs from a runtime, which is new. The daemon's exit 75 happens only under the runtime with the env set. No tool, input or output shape, `ActionResult` field or default capability changes, so the stable-surface clock doesn't reset. The Upgrading note: "Nothing changes unless you run `browxai runtime install`."

Docs that change with the code slices: a guide page for runtime updates, the `runtime` paragraph in the tool reference's CLI section, the env table, two threat-model rows, the README install section, a line in the `driving-browxai` skill, a pointer from RFC 0013's client section, and RELEASING notes (each publish reaches auto-updating machines after the delay, `npm deprecate` stops the rollout, prereleases need `--tag next`, and "Nothing to do." must be literal when true). Each slice's CHANGELOG entry says what runs in the background and how to turn it off.

## 14. Alternatives considered

- **Entries name `<runtime>/current/.../cli.js` with a bare `node`.** No shim. A client started from the desktop has no shell `PATH`, so the bare `node` fails, and there's no place for the version env or a clear error.
- **A Node launcher.** A second Node start on every launch, about 40 ms, for nothing the shim can't do.
- **A self-contained tarball with `node_modules`, published as a GitHub Release asset with an attestation.** One file and the exact tested tree. It adds a second host and a release job, and the updater would need its own verification code.
- **In-process Sigstore verification with the `sigstore` package.** No dependency on npm for the check, and one more dependency to trust.
- **`npx -y browxai@latest` as the client command.** No install at all. It needs the network on every start, fails when the registry is down, and runs whatever was published a minute ago with no delay and no check.
- **Holding minors before 1.0, or patches only.** That's the `^0.x` behaviour that left a machine on 0.10.0.
- **A per-release `defaultsChanged` flag that holds behaviour-changing releases for a manual update.** Tidier later. It needs a release-ritual step and a test that keeps the flag in step with the Upgrading paragraph.
- **The updater restarts the daemon** through `launchctl kickstart -k` after asking it for sessions. It needs the job label and a socket client in the updater, and a race kills sessions.
- **The runtime job runs `brew upgrade --cask browxai`.** Outward-facing, and Homebrew's concern.
- **Rewrite client configs by default, or across every profile directory found.** One step fewer. It edits configs the user didn't name, including other profiles, with no prompt.

## 15. Failure modes

| What happens                                               | Result                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry down                                              | Nothing changes. Backoff.                                                                                                                                                                                                                                      |
| Install fails (network, disk full)                         | Staging discarded. `failed[V]` goes up.                                                                                                                                                                                                                        |
| Signature or provenance check fails                        | Staging discarded. V held for good as "verification failed", with no retry. doctor shows ✗.                                                                                                                                                                    |
| Smoke check fails                                          | Staging discarded. `failed[V]` goes up. Held after 3.                                                                                                                                                                                                          |
| The rename fails                                           | `current` unchanged. Staging kept for one retry.                                                                                                                                                                                                               |
| A bad release found after the switch                       | `browxai runtime rollback`. The maintainers `npm deprecate` the version, which stops further machines and shows a doctor warning on the rest. No automatic rollback after a switch: servers start under clients, and nothing dependable observes their health. |
| The updater in `current` is broken                         | `previous`'s updater runs.                                                                                                                                                                                                                                     |
| The recorded node was pruned                               | The shim falls back to `command -v node`. The job fails its run, and doctor names `runtime install`.                                                                                                                                                           |
| A client config in another profile still names an old path | It keeps the old version. `install` printed it, and `--profile-dir` writes it.                                                                                                                                                                                 |

## 16. Decisions

Signed off with the recommended defaults. The refinements from the sign-off are part of the default.

| #   | Decision                                      | Default, as signed off                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Runtime directory                             | `$BROWX_RUNTIME_DIR`, with a default dot directory in the user's home that S1 names. Managed only when `layout.json` is present. `layout.json` carries `schemaVersion`. A runtime directory or `versions/` that is a symlink or group-writable or world-writable is refused. A foreign layout is refused with migration steps. Never inside `$BROWX_WORKSPACE` or the app's Application Support. |
| D2  | Launcher                                      | A POSIX `sh` shim at `<runtime>/bin/browxai` that resolves `current` once with `cd -P` and `pwd -P` (no `readlink -f`), passes `"$@"` unchanged, and execs node. Same behaviour on macOS and Linux.                                                                                                                                                                                              |
| D3  | Node for the shim and the job                 | `BROWX_RUNTIME_NODE`, then `node-path` recorded at install, then `command -v node`. The launchd and systemd jobs put `dirname(node-path)` first on `PATH`, and the updater runs npm as `<node-path> <npm-cli.js>`, so the job never depends on the login shell's `PATH`. doctor warns when the recorded node is gone.                                                                            |
| D4  | Install mechanism                             | `npm install` of the exact version with `--omit=dev --ignore-scripts --before <publishedAt + 1h>`.                                                                                                                                                                                                                                                                                               |
| D5  | Verification                                  | S1: `npm audit signatures` in staging, first confirmed against the real published package so the registry signature check is known to pass on current releases before any provenance pin. S3: pin provenance to the repository, the trusted-publisher workflow `release.yml` and the tag, once npm trusted publishing over OIDC is live.                                                         |
| D6  | Channels                                      | `latest` by default, `next` opt-in, from env or `runtime.json` only. `next` needs `--tag next` in `release.yml`.                                                                                                                                                                                                                                                                                 |
| D7  | Version guard                                 | From 1.0, hold majors. Before 1.0, cross minors automatically and surface the Upgrading notes.                                                                                                                                                                                                                                                                                                   |
| D8  | Delay after publish                           | 24 hours for the job, none for a manual run.                                                                                                                                                                                                                                                                                                                                                     |
| D9  | Smoke check                                   | `--version`, an MCP handshake with `tools/list`, no new doctor failures, and from S2 the staged updater's own `status`. No browser.                                                                                                                                                                                                                                                              |
| D10 | Retention                                     | Three versions (current, previous, one more), never one in use.                                                                                                                                                                                                                                                                                                                                  |
| D11 | Daemon onto a new version                     | Drain itself: exit 75 after 15 minutes with no connections and no open sessions, under the runtime only.                                                                                                                                                                                                                                                                                         |
| D12 | Schedule                                      | Wake hourly. Check every 6 hours plus up to 60 minutes of jitter, first contact 10 to 30 minutes after boot. 6 contacts and 2 applies a day, 3 failures per version, backoff from 1 to 24 hours.                                                                                                                                                                                                 |
| D13 | Upgrading notes                               | Generate `dist/upgrading.json` at build. Journal, doctor, `runtime notes`, and one standard-error line on first start.                                                                                                                                                                                                                                                                           |
| D14 | App and cask                                  | The runtime never touches the app. `runtime` verbs exit 2 inside it. The job never runs `brew upgrade`.                                                                                                                                                                                                                                                                                          |
| D15 | Client config rewrite                         | Print by default. `--write-client-config` writes only the active client config of each client, and never searches other profile directories. A further directory is written only when named with `--profile-dir`.                                                                                                                                                                                |
| D16 | Opt-out                                       | `BROWX_RUNTIME_AUTO_UPDATE=off`, failing closed on unknown values. "Off" in env or `runtime.json` wins. Never from workspace config or a tool.                                                                                                                                                                                                                                                   |
| D17 | Names                                         | Subcommand `runtime`, job label `com.kalebtec.browxai.runtime-update`, units `browxai-runtime-update.{service,timer}`. `--link` is opt-in.                                                                                                                                                                                                                                                       |
| D18 | Windows                                       | Docs only.                                                                                                                                                                                                                                                                                                                                                                                       |
| D19 | A broken updater in `current`                 | Fall back to `previous`'s updater after three internal errors, and warn.                                                                                                                                                                                                                                                                                                                         |
| D20 | A Playwright bump on a machine with no Chrome | Hold the version with a doctor reason. The updater never downloads a browser.                                                                                                                                                                                                                                                                                                                    |
| D21 | RFC first                                     | Land this RFC, sign off D1 to D20, then build S1.                                                                                                                                                                                                                                                                                                                                                |

## 17. Slice plan

Each slice is one PR or a short series, in order, each with its own docs-impact pass.

| Slice | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1    | **Layout, launcher, manual update.** The `runtime` subcommand with `install` (no job), manual `update`, `status`, `gc` and `uninstall`. The layout with `schemaVersion` and every refusal, the POSIX shim, the atomic switch, exact-version install with `--ignore-scripts` and `--before`, npm run through the recorded node, `npm audit signatures` with its check against the real published package, smoke steps 1 to 3 (which need `doctor --json`), garbage collection that skips versions in use. The `init` change and the app refusal. `--write-client-config` limited to the active config, with `--profile-dir`. Tests 1 to 5. Docs: the guide's manual flow, the tool reference paragraph, a CHANGELOG entry, a draft threat-model row. |
| S2    | **Updater job and doctor.** `update --auto` with the schedule, caps, backoff and lock. The launchd plist and systemd units, with `dirname(node-path)` on `PATH`, written by `install` and removed by `uninstall`. The `runtime` doctor row. The opt-out and `runtime config`. `dist/upgrading.json`, `runtime notes`, the first-start line, the fallback to `previous`'s updater, smoke step 4. The daemon drain and test 6. Docs: the background job section, the env keys, the RELEASING note.                                                                                                                                                                                                                                                    |
| S3    | **Channel, provenance and rollback hardening.** The `next` channel with the owner-approved `release.yml` change. The provenance pin to the trusted-publisher workflow, once npm OIDC publishing is live. The delay, the `deprecated` skip, the D7 guard and held versions. `rollback --to` and the hold after a rollback. The Playwright-bump hold. Final threat-model rows.                                                                                                                                                                                                                                                                                                                                                                        |

## Honest limits

These weren't verified while writing this RFC. Each is checked before the slice that depends on it.

- **Atomicity.** `rename(2)` over a symlink on APFS while another process resolves `current`. A loop of 10,000 switches with a concurrent reader settles it (S1).
- **npm 11 behaviour**, each with a fixture or a real run:
  - whether `--before` applies to every package in the resolution;
  - what `npm audit signatures` checks and how it exits, which S1 records against the real package;
  - the packument's `deprecated` and `time` fields;
  - `dist.attestations.url` and the SLSA predicate field names (S3);
  - whether npm 11 refuses a prerelease publish without `--tag`.
- **Node.** That Node keeps the real path for lazy imports when the main script was reached through a symlinked directory. The shim resolves first, so the design doesn't depend on it.
- **launchd.** Whether a missed `StartInterval` runs once after wake. Whether `npm-cli.js` sits at the expected place beside node for mise, nvm and Homebrew layouts.
- **Client restarts.** Whether each client (Claude Code, Codex, Cursor, Claude Desktop) starts its MCP stdio children per session or per app launch. That decides how fast "next start" comes.
- **Several client profiles.** Whether `init-user-config.ts` can address a config directory other than the active one. `--profile-dir` depends on it.
- **Linux.** How a systemd user timer behaves without lingering on a headless machine.
- **Cost.** Install time and disk per version weren't measured. A clean install is 110 packages.
- **Provenance timing.** The S3 pin waits on npm trusted publishing over OIDC being confirmed live for the package.
- **Same-user writes.** Code running as the user can write the runtime directory. The refusals stop mistakes and other users, nothing more.

## Addendum: S3 provenance pin and the `next` channel, as built

**What the published package carries.** Read from the registry for `browxai@0.21.0` (and checked the same on 0.10.0 and 0.17.0) before the pin was written:

- `dist.attestations` is `{ url, provenance: { predicateType } }`, with `url` `https://registry.npmjs.org/-/npm/v1/attestations/browxai@<v>` and `predicateType` `https://slsa.dev/provenance/v1`. Versions before 0.10.0 have no `dist.attestations`.
- The document at that URL is `{ attestations: [...] }` with two entries. One has `predicateType` `https://github.com/npm/attestation/tree/main/specs/publish/v0.1`, a Sigstore bundle v0.2 signed with the registry's public key. The other has `predicateType` `https://slsa.dev/provenance/v1`, a bundle `application/vnd.dev.sigstore.bundle.v0.3+json` whose `verificationMaterial.certificate.rawBytes` is the signing certificate.
- The SLSA bundle's `dsseEnvelope.payloadType` is `application/vnd.in-toto+json`. The decoded payload has `_type` `https://in-toto.io/Statement/v1`, one `subject` `{ name: "pkg:npm/browxai@<v>", digest: { sha512: <hex> } }`, where the hex is the base64 of `dist.integrity` decoded, and `predicate.buildDefinition` with `buildType` `https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1` and `externalParameters.workflow` `{ ref: "refs/tags/v<v>", repository: "https://github.com/kalebteccom/browxai", path: ".github/workflows/release.yml" }`.
- The certificate's subject alternative name is the URI `https://github.com/kalebteccom/browxai/.github/workflows/release.yml@refs/tags/v<v>`. Its Fulcio extensions name the issuer `https://token.actions.githubusercontent.com`, the repository `kalebteccom/browxai`, the ref `refs/tags/v<v>`, the event `push` and the environment `release`.

Section 4's field names match: `workflow.repository`, `workflow.path` and `workflow.ref` sit under `predicate.buildDefinition.externalParameters`.

**What the pin requires, beyond section 4.** Exactly one SLSA provenance v1 entry, an in-toto v1 statement, the build type above, attestations on the same origin as `dist.tarball`, and a signing certificate whose SAN URI is the workflow at the tag. The certificate check was added because the statement is written by whoever runs the publish: a statement that names this repository, signed by a certificate issued to another, passes a signature check with no identity policy. Node's `X509Certificate` reads the SAN, so no dependency was added. The signature and the certificate chain stay with `npm audit signatures`.

**No cut-off date.** From this slice on, every version needs an attestation. Every release since 0.10.0 has one, and the runtime has never installed an older version, so no date is needed. `update --version` of a pre-0.10.0 version fails verification.

**A failed download is not a mismatch.** The attestations document is fetched with a plain GET, since npm has no command that prints it. A network or HTTP failure counts as an ordinary failed attempt (held after three). Only a document that doesn't name the trusted publisher holds the version for good.

**`next` resolves to the newer of the two dist-tags.** Section 5 reads "the dist-tag for the channel". Built that way, a machine on `next` would stay on `0.23.0-next.1` after `0.23.0` ships on `latest`, which is the stall this RFC exists to end, and `next` would fail outright today, since the package has no `next` dist-tag (`npm view browxai@next` returns E404). So `next` reads `latest` first and takes the `next` dist-tag only when it names a newer version. The delay, the deprecated skip, D7 and every check are the same on both channels. The updater never moves down, so a machine that switches back to `latest` while on a prerelease keeps it until `latest` passes it, and doctor says so.

**`release.yml`.** The publish step adds `--tag next` when `GITHUB_REF_NAME` contains a `-`. Nothing else in the workflow changed. The GitHub Release for a prerelease tag isn't marked as a prerelease by this change.

## References

- [RFC 0012](0012-signed-macos-app.md): the app, its launcher, the cask as its only update channel.
- [RFC 0013](0013-stdio-socket-bridge.md): the bridge, its reconnect, and the client entries this RFC changes for npm installs.
- [RFC 0011](0011-shell-route.md): the exit codes this command follows.
- `src/cli/init.ts`, `src/cli/init-user-config.ts`: what writes client entries today.
- `src/cli/doctor.ts`, `src/cli/doctor-macos-app.ts`: the doctor rows and the injected runner.
- `src/cli/serve.ts`: the daemon's exit on signals.
- `.github/workflows/release.yml`, `RELEASING.md`: publishing, provenance and deprecation.
- `scripts/audit-package-contents.mjs`: the tarball rules `dist/upgrading.json` must meet.
