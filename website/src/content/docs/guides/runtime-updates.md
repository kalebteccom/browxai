---
title: Keep browxai current with a runtime
description: Install browxai into a runtime directory you own, point MCP clients at one launcher path, and let a background job or `browxai runtime update` move it to new releases. Covers what an update verifies, the provenance pin, the `latest` and `next` channels, the versions it holds, the background job and how to turn it off, the settings and `browxai runtime config`, Upgrading notes, rollback, a daemon that moves to a new version when idle, a link on your PATH, what the commands refuse, and moving from a hand-made directory.
---

An MCP client starts browxai from the path in its config. When that path names one
version's `dist/cli.js`, the client keeps running that version until someone edits
the config. `browxai runtime` fixes that. It keeps each release side by side in a
directory you own, and gives every client one launcher path that never changes. An
update installs the new release next to the old one, checks it, and only then points
the launcher at it. The next time a client starts browxai, it gets the new version.

```text
browxai runtime install  [--dir PATH] [--channel latest|next] [--no-agent] [--link] [--write-client-config] [--profile-dir DIR]...
browxai runtime update   [--check] [--version V] [--allow-major] [--now] [--auto]
browxai runtime status   [--json]
browxai runtime notes    [V]
browxai runtime config   [auto-update on|off | channel latest|next | major allow|hold | cooldown-hours N]
browxai runtime rollback [--to V]
browxai runtime gc
browxai runtime uninstall [--keep-versions] [--yes]
```

`install` also sets up a background job that checks for a new release every few
hours and applies it with the same checks. See [The background job](#the-background-job)
for what it does and how to turn it off.

## Install a runtime

Run it with any browxai, from a global install, `npx` or a checkout:

```bash
npx -y browxai runtime install
```

`install` creates the runtime directory (`~/.browxai-runtime` unless `--dir` or
`BROWX_RUNTIME_DIR` names another), records the absolute path of the `node` it runs
on, writes the launcher at `<runtime>/bin/browxai`, then installs the newest release
of the channel the way `update` does. Then it installs the background job, unless you
pass `--no-agent`, and prints the client entries to use. With `--link` it also puts
the launcher on your `PATH` (see [A link to the launcher](#a-link-to-the-launcher)).
When that first install fails a check, it exits 1, leaves no current version and
installs no job.

The directory looks like this:

```text
~/.browxai-runtime/
  layout.json         marks a directory browxai manages
  runtime.json        your settings, mode 0600
  node-path           the node the launcher and the background job run
  bin/browxai         the launcher
  current             a link to the version clients run
  versions/0.22.0/    one npm install per version, never changed after it is used
  staging/            installs in progress
  state.json          the previous version, failed attempts, unread notes, and the job's schedule
  previous-version    the previous version again, as one line the launcher reads
  updater-errors      runs in a row where the current version's updater failed
  notes/0.22.0.md     Upgrading notes of a version an update crossed
  journal.jsonl       one line per check, apply, rollback, gc, Upgrading note and fallback, mode 0600
  agent.log           the background job's output on macOS, mode 0600
  lock                held by the update that is running
```

## Point your MCP clients at the launcher

Every entry names the launcher by absolute path, with no arguments for a stdio
server. Keep the `env` your entries already have:

```json
{
  "mcpServers": {
    "browxai": {
      "command": "/home/you/.browxai-runtime/bin/browxai",
      "args": [],
      "env": { "BROWX_WORKSPACE": "/home/you/.browxai" }
    }
  }
}
```

An entry that runs a subcommand keeps it in `args`, for example
`["bridge", "--socket", "/path/to/socket"]`.

`install` prints these entries and writes nothing. To have it rewrite the entries you
already have, pass `--write-client-config`:

```bash
browxai runtime install --write-client-config
```

It rewrites an entry only when its command runs an installed browxai (a path ending
in `node_modules/browxai/dist/cli.js`) or `npx browxai`. The entry keeps its `env`
and any subcommand, and a source checkout's `dist/cli.js` is left alone. It reads
only the config each client uses in the current environment: `~/.cursor/mcp.json`,
Codex's `config.toml` (under `CODEX_HOME` when set), and Claude Desktop's config on
macOS. It prints the change, writes it, and keeps the old file as
`<config>.browxai-bak`. It never searches for other profile directories. To include
one, name it:

```bash
browxai runtime install --write-client-config --profile-dir ~/work-profile
```

Claude Code updates its own config file while it runs, so browxai doesn't edit it.
For each Claude Code entry to change, the active one or one in a `--profile-dir`, it
prints a `claude mcp remove` and `claude mcp add-json` pair to run, with
`CLAUDE_CONFIG_DIR` set for a profile directory.

`browxai init` run through the launcher writes the launcher path into the entries it
creates, so they follow updates too.

## Update

```bash
browxai runtime update
```

`update` asks the npm registry in your npm config for the channel's newest version
(`latest` by default, see [Channels](#channels)). When it is newer than the current one, it installs it and
switches. When it isn't, it says so and exits 0. A version the maintainers marked
deprecated on npm is skipped, and a held version (see [Held versions](#held-versions))
is named with its reason and left alone, with exit 0.

- `--check` downloads nothing and prints what `update` would do, or why the version
  is held.
- `--version V` installs that exact version, newer or older, held or not. An older
  version, a new major version and a Node engines range your node misses each print
  a warning first.
- `--allow-major` applies a new major version this once.
- `--now` skips the 24-hour wait after publish. A manual update never waits, so it
  matters only with `--auto`.
- `--auto` is the background job's mode, described below.

Servers that are already running keep the version they started with, until their
client starts them again.

## What an update checks

A release becomes current only after every step passes. A step that fails removes the
staged copy, records the failure in `state.json`, and leaves the current version as
it was.

1. **Exact install, no scripts.** npm installs the exact version into
   `staging/<version>-<pid>` with `--ignore-scripts`, so no dependency runs an install
   script, and with `--before` set to one hour after that version was published, so
   its dependencies resolve to what existed then. npm runs as the recorded `node` and
   the `npm-cli.js` next to it, so the update doesn't depend on your shell's `PATH`.
2. **Registry signatures.** `npm audit signatures` must pass for the staged install. It
   checks the npm registry signature of every installed package and the provenance
   attestation where one exists. A version that fails it is recorded in `state.json`
   as failing verification.
3. **Provenance from the release workflow.** `npm audit signatures` checks the
   signature on the provenance, not where the build ran. So the update also reads the
   version's attestations from the registry (`dist.attestations.url`, on the same
   host as the tarball) and requires its SLSA provenance to name
   `https://github.com/kalebteccom/browxai`, the workflow `.github/workflows/release.yml`
   and the tag `refs/tags/v<version>`, in the statement and in the signing
   certificate, for a subject that is this package at this version with the tarball's
   sha512. A version with no provenance, or one that names anything else, is held for
   good as failing verification, and doctor's `runtime` row fails. An attestation
   that can't be downloaded counts as an ordinary failed attempt.
4. **A short self-check.** With an empty temp workspace and none of your `BROWX_*`
   settings, the staged copy must print its own version for `--version`, answer an
   MCP handshake with that version and at least one tool, show no `doctor --json`
   row failing that passes on the current version, and run its own
   `runtime status --json`, so a release whose updater can't start never becomes
   current. No browser starts.
5. **The switch.** The checked copy moves to `versions/<version>`, and the `current`
   link is replaced in one `rename`, so a client that starts during the switch gets
   either the old version or the new one.

Afterwards `update` keeps three versions (current, previous and one more) and removes
older ones that no running process uses.

## Channels

`latest`, the default, follows the `latest` dist-tag, the version `npm install browxai`
gets. `next` is for prereleases such as `0.23.0-next.1`, which the release workflow
publishes under the `next` dist-tag. On `next`, an update takes the `next` dist-tag
when it names a newer version than `latest`, and `latest` otherwise, so a machine on a
prerelease moves on to the release that passes it, and `next` works before any
prerelease exists. Everything else is the same on both channels: the 24-hour wait for
the background job, the deprecated skip, the held versions and every check.

```bash
browxai runtime config channel next      # or BROWX_RUNTIME_CHANNEL=next
browxai runtime config channel latest    # back to releases
```

The updater never moves to an older version on its own. A machine that goes back to
`latest` while it runs a prerelease keeps it until `latest` passes it, and doctor's
`runtime` row says so. `browxai runtime update --version V` installs a release before
then.

## Held versions

A newer version is held, and neither `update` nor the background job applies it, in
these cases:

| Hold                                    | When                                                                                                                                                                                                                                                                                      | What releases it                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A new major version                     | From 1.0 on, a version with a higher major than the current one, 1.0.0 over a 0.x included. Before 1.0 a minor crosses on its own, and its Upgrading notes say what changed.                                                                                                              | `update --allow-major` once, or `runtime config major allow` for the job too             |
| A Node engines range                    | The version's `engines.node` excludes the node the runtime runs. The reason names the range, the node and its version.                                                                                                                                                                    | A node that satisfies it (`runtime install` records a new one), or `update --version V`  |
| A Playwright bump with no Google Chrome | The staged version moves `playwright-core` to another version, and the current version's `doctor` finds no Google Chrome, so sessions here launch the bundled Chromium, which the new Playwright needs to download. The updater never downloads a browser, so it removes the staged copy. | `update --version V`, then the `npx playwright-core@<version> install chromium` it names |
| A rollback                              | `rollback` left this version.                                                                                                                                                                                                                                                             | A newer version, or `update --version V`                                                 |
| Failed checks                           | 3 failed self-checks, or 1 failed signature check.                                                                                                                                                                                                                                        | A newer version, or `update --version V`, which runs every check again                   |

A held version shows in `browxai runtime status` and in the `runtime` row of
`browxai doctor` with its reason, also with auto-update off. A machine that uses
Google Chrome needs nothing for a Playwright bump.

## The background job

`install` adds a job that runs `<runtime>/bin/browxai runtime update --auto` once an
hour, as you, with no administrator rights:

- **macOS:** a launchd user agent,
  `~/Library/LaunchAgents/com.kalebtec.browxai.runtime-update.plist`, loaded with
  `launchctl bootstrap gui/<uid>`. Its output goes to `<runtime>/agent.log`.
- **Linux:** a systemd user timer and service,
  `~/.config/systemd/user/browxai-runtime-update.timer` and `.service`, enabled with
  `systemctl --user enable --now`. Without lingering, the timer runs only while you
  are logged in.
- **Windows:** no job. See [Windows](#windows).

The job doesn't read your shell's `PATH`. Its `PATH` is the directory of the node
`install` recorded, then `/usr/bin` and `/bin`, and `BROWX_RUNTIME_NODE` names that
node, so it finds the same node and npm under mise, nvm or Homebrew. If a version
manager removes that node, run `browxai runtime install` again to record another.

Each hourly run returns at once unless a check is due. When one is, `update --auto`:

| What                          | Value                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| Check interval                | 6 hours, plus 0 to 60 minutes picked at random                                                          |
| After a restart               | the first check waits 10 to 30 minutes after the first run that follows it                              |
| Registry contacts             | at most 6 in 24 hours                                                                                   |
| Applies                       | at most 2 in 24 hours                                                                                   |
| Wait after publish            | 24 hours (`cooldownHours` in `runtime.json`), so a release can be withdrawn before it spreads           |
| A failed self-check           | the version is tried again at the next check, and held after 3 failures                                 |
| A failed signature check      | the version is held at once and not tried again                                                         |
| The registry can't be reached | nothing changes, and the next contact waits 1 hour, then 2, 4 and so on up to 24 hours                  |
| Another update is running     | the run exits 0 and changes nothing (`<runtime>/lock`, stale after an hour or once its process is gone) |

The job exits 0 for all of these, so an offline machine never shows a failing job.
It exits 1 only for an internal error, which the journal records. A manual
`browxai runtime update` counts as a check too, and moves the next one 6 hours on.

### When the current version's updater fails

The job runs the updater of the current version. When that updater exits with an
internal error on three hourly runs in a row, the next run uses the previous
version's updater once, then goes back to the current one. The launcher counts the
runs in `<runtime>/updater-errors`, writes a `fallback` line to the journal, and the
`runtime` row of `browxai doctor` says so until the current version's updater
succeeds again. With the self-check that runs each release's own
`runtime status --json`, a release with a broken updater can't keep a machine from
taking the next release.

`browxai runtime status` and the `runtime` row of `browxai doctor` show the last
check, the next one, and a version that waits or is held, with the reason.
`<runtime>/journal.jsonl` keeps one line per check, apply, rollback, gc, Upgrading
note and updater fallback, with
versions, integrity hashes, reasons and timings. It records no npm config value. At
1 MB it moves to `journal.jsonl.1`, replacing the one before.

### Turn it off

- Run `browxai runtime config auto-update off`, which sets `"autoUpdate": "off"` in
  `<runtime>/runtime.json`. The job reads that file on every run.
- Or set `BROWX_RUNTIME_AUTO_UPDATE=off` in the job's own environment. The job
  doesn't read your shell's variables, so a value set in your shell profile doesn't
  reach it.
- Or remove the job: `browxai runtime install --no-agent` removes a job an earlier
  install added, and `browxai runtime uninstall` removes it with the runtime.

Off in either place wins, and a value other than `on`, `1`, `true`, `yes`, `off`, `0`,
`false` or `no` counts as off.

## Upgrading notes

Before 1.0 a minor release can change a default, and the CHANGELOG says what to do in
its Upgrading notes. The npm package carries no CHANGELOG, so each build ships the
notes as `dist/upgrading.json`. After an update switches versions, it copies the
notes of every version it crossed to `<runtime>/notes/<version>.md` and to the
journal. A release whose note is "Nothing to do." adds none.

```bash
browxai runtime notes          # notes you haven't read, and every version after yours up to current
browxai runtime notes 0.22.0   # the notes of one version
```

Until you run `browxai runtime notes`, the `runtime` row of `browxai doctor` warns
about the unread notes, and the first server that starts on the new version prints
one line to standard error naming the command. Standard error reaches only your MCP
client's log, so doctor is the place to look.

## A daemon you run yourself

A `browxai serve --socket` daemon that your own launchd job or systemd unit starts
through the launcher moves to a new version by itself. Every 5 minutes it reads
`current`, a local file read with no network. Once `current` names another version
and the daemon has had no socket client and no open session for 15 minutes, it logs
one line and exits with code 75. A launchd job with `KeepAlive` and
`SuccessfulExit` set to false, or a systemd unit with `Restart=on-failure`, starts it
again through the launcher on the new version, and a connected `browxai bridge`
reconnects. A job that doesn't restart on a non-zero exit leaves the daemon stopped.

Set `BROWX_RUNTIME_DAEMON_RESTART=off` in the daemon's environment to keep it on its
version until you restart it. The default under the launcher is `idle`, and any other
value keeps the daemon running and logs a warning. A daemon started without the
launcher never exits this way.

## Roll back

```bash
browxai runtime rollback
```

`rollback` points `current` at the previous version. It needs no network. Running it
again goes forward to the version you left.

```bash
browxai runtime rollback --to 0.21.0
```

`--to V` points `current` at any kept version (see `browxai runtime status`). A
version that isn't kept is refused with exit 1 and the list of kept ones.

The version `rollback` leaves is held as "rolled back by user", so neither `update`
nor the background job applies it again. The hold clears when a newer version is
applied, or when you name it with `browxai runtime update --version V`. Rolling back
to a held version releases its hold.

## Status and cleanup

`browxai runtime status` prints the runtime directory, the current and previous
versions, the version of the browxai you ran it with, the channel and auto-update
settings and where each came from, the background job's files, the last and next
check, a version that waits, the held versions with their reasons, the recorded
node, and every kept version with the processes that use it. `--json` prints the
same as one JSON document.

`browxai runtime gc` removes kept versions past the newest three that no running
process uses. When it can't read the process list it removes nothing.

`browxai runtime uninstall` removes the background job, the `~/.local/bin/browxai`
link when it points at this launcher, and the runtime directory. It refuses while a
server runs from it, unless you pass `--yes`, and it names the client configs that
still point at the launcher.

`--keep-versions` removes the job, the link, the launcher, `current`, the settings,
the state, the journal and the notes, and keeps `versions/` and `layout.json`.
Servers that run from a kept version keep running, so it doesn't refuse. A later
`browxai runtime install` finds the kept versions and switches to one with no
download, and `browxai runtime uninstall` removes the rest.

## `browxai doctor`

The `runtime` row reads the runtime's files and makes no network call. Run from a
runtime it shows the current version, the channel, when the last check ran, when
the next one is due, and whether auto-update is on and where that came from. It
warns about a version that waits or is held, a server older than `current`, a
`current` the maintainers deprecated, a recorded node that is gone, and auto-update
on with no background job. A held version shows with its reason (a new major
version, a Node engines range, a Playwright bump on a machine with no Google Chrome,
a rollback), also with auto-update off. It also warns about unread Upgrading notes, and about a
current version whose updater failed on its last runs or that the previous version's
updater stood in for. It fails doctor only when a version failed signature or
provenance verification, the provenance pin included. On `latest` with a prerelease
as the current version, the summary says the prerelease stays until `latest` passes
it. Run from anywhere else it says so, with the path that won't
update.

## Settings

| Setting                        | Where                                        | What it does                                                                                                                                                       |
| ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BROWX_RUNTIME_DIR`            | environment                                  | The runtime directory, an absolute path. The launcher sets it for the server it starts.                                                                            |
| `BROWX_RUNTIME_CHANNEL`        | environment, or `channel` in runtime.json    | `latest` (the default) or `next`. Any other value is refused.                                                                                                      |
| `BROWX_RUNTIME_AUTO_UPDATE`    | environment, or `autoUpdate` in runtime.json | Whether the background job applies updates. Off in either place wins, and a value other than `on`, `1`, `true`, `yes`, `off`, `0`, `false` or `no` counts as off.  |
| `cooldownHours`                | runtime.json                                 | Hours the background job waits after a release is published, 24 by default, 0 to 720. Another value keeps 24, with a warning.                                      |
| `majorPolicy`                  | runtime.json                                 | `hold` (the default) holds a new major version from 1.0 on. `allow` lets the background job and `update` apply it. Another value counts as `hold`, with a warning. |
| `BROWX_RUNTIME_NODE`           | environment                                  | The node the launcher and npm run, before the recorded one. The background job sets it to the recorded node.                                                       |
| `BROWX_RUNTIME_DAEMON_RESTART` | a daemon's environment                       | `idle` (the default under the launcher) lets a `serve --socket` daemon exit 75 to move to a new version; `off` keeps it running. Another value counts as `off`.    |

`browxai runtime config` prints each setting and where its value comes from. With a
setting it writes `runtime.json`, mode 0600:

```bash
browxai runtime config                    # print the settings
browxai runtime config auto-update off    # or on
browxai runtime config channel next       # or latest
browxai runtime config cooldown-hours 48  # 0 to 720
browxai runtime config major allow        # or hold
```

A value outside these words is a usage error and writes nothing, and a `runtime.json`
that doesn't parse is left alone. When a variable in the current environment
overrides the value you set, the command says so. `install --channel` writes the
channel too. These settings come only
from the environment and `runtime.json`. The workspace config, `set_config` and MCP
tools can't change them. The launcher also sets `BROWX_RUNTIME_VERSION` for the
server it starts, for information only.

## What the commands refuse

Every `runtime` command refuses, changes nothing and exits 2 when:

- it runs as root;
- the runtime directory or its `versions/` is a symbolic link, is writable by group or
  others, or belongs to another user;
- the runtime directory is inside the workspace, or the workspace is inside it;
- the directory has files but no `layout.json`;
- `layout.json` comes from a newer browxai (`status` still reports);
- browxai runs from the signed macOS app.

Exit codes: 0 ok, 1 a failed check or an internal error, 2 usage or a refused context,
3 the npm registry could not be reached.

## The macOS app

The signed Browxai app updates with `brew upgrade --cask browxai`, and every
`runtime` command run from it says so and exits 2. A runtime and the app can live on
the same machine: client entries name absolute paths, so each entry runs the one it
names.

## Windows

There is no launcher and no background job on Windows. Use `npx -y browxai@latest` as the client command,
which resolves the newest version on every start and needs the network to start, or
update with `npm install -g browxai@latest` and restart your MCP client.

## A link to the launcher

```bash
browxai runtime install --link
```

`--link` creates `~/.local/bin` when it is missing and links
`~/.local/bin/browxai` to the launcher, so a shell runs the runtime's browxai by
name. The launcher follows a symbolic link to itself, so the link runs the runtime
the launcher belongs to. `--link` prints each step it takes:

- a link there that already points at this launcher is left as it is;
- a file there that is anything else, a link to another place included, is left
  alone, with a warning and no link;
- when `~/.local/bin` is not on your `PATH`, it says so;
- when another `browxai` comes earlier on your `PATH`, it names it, since a shell
  runs that one. Client entries name the launcher by its full path and aren't
  affected.

`browxai runtime uninstall` removes the link only while it points at this launcher.
A link you make by hand in another directory on your `PATH` works the same way.

## Moving from a hand-made directory

When the runtime path already holds a directory that `browxai runtime` didn't create,
every command stops and prints these steps instead:

1. Unload and remove any background job that updates that directory.
2. Move the directory aside, then run `browxai runtime install`.
3. Point client entries at the launcher, with `--write-client-config` and a
   `--profile-dir` for each further config directory.
4. Remove the old directory once no process uses it.
