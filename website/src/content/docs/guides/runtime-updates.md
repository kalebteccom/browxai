---
title: Keep browxai current with a runtime
description: Install browxai into a runtime directory you own, point MCP clients at one launcher path, and update, check and roll back releases with `browxai runtime`. Covers what an update verifies, the settings, what the commands refuse, and moving from a hand-made directory.
---

An MCP client starts browxai from the path in its config. When that path names one
version's `dist/cli.js`, the client keeps running that version until someone edits
the config. `browxai runtime` fixes that. It keeps each release side by side in a
directory you own, and gives every client one launcher path that never changes. An
update installs the new release next to the old one, checks it, and only then points
the launcher at it. The next time a client starts browxai, it gets the new version.

```text
browxai runtime install  [--dir PATH] [--channel latest|next] [--write-client-config] [--profile-dir DIR]...
browxai runtime update   [--check] [--version V] [--now]
browxai runtime status   [--json]
browxai runtime rollback
browxai runtime gc
browxai runtime uninstall [--yes]
```

There is no background check yet. A runtime changes only when you run
`browxai runtime install` or `browxai runtime update`.

## Install a runtime

Run it with any browxai, from a global install, `npx` or a checkout:

```bash
npx -y browxai runtime install
```

`install` creates the runtime directory (`~/.browxai-runtime` unless `--dir` or
`BROWX_RUNTIME_DIR` names another), records the absolute path of the `node` it runs
on, writes the launcher at `<runtime>/bin/browxai`, then installs the newest release
of the channel the way `update` does. It ends by printing the client entries to use.
When that first install fails a check, it exits 1 and leaves no current version.

The directory looks like this:

```text
~/.browxai-runtime/
  layout.json         marks a directory browxai manages
  runtime.json        your settings (channel), mode 0600
  node-path           the node the launcher runs
  bin/browxai         the launcher
  current             a link to the version clients run
  versions/0.22.0/    one npm install per version, never changed after it is used
  staging/            installs in progress
  state.json          the previous version and failed attempts
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
(`latest` by default). When it is newer than the current one, it installs it and
switches. When it isn't, it says so and exits 0. A version the maintainers marked
deprecated on npm is skipped.

- `--check` downloads nothing and prints what `update` would do.
- `--version V` installs that exact version, newer or older. An older one prints a
  warning first.
- `--now` is accepted and changes nothing: a manual update never waits.

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
3. **A short self-check.** With an empty temp workspace and none of your `BROWX_*`
   settings, the staged copy must print its own version for `--version`, answer an
   MCP handshake with that version and at least one tool, and show no `doctor --json`
   row failing that passes on the current version. No browser starts.
4. **The switch.** The checked copy moves to `versions/<version>`, and the `current`
   link is replaced in one `rename`, so a client that starts during the switch gets
   either the old version or the new one.

Afterwards `update` keeps three versions (current, previous and one more) and removes
older ones that no running process uses.

## Roll back

```bash
browxai runtime rollback
```

`rollback` points `current` at the previous version. It needs no network. Running it
again goes forward to the version you left.

## Status and cleanup

`browxai runtime status` prints the runtime directory, the current and previous
versions, the version of the browxai you ran it with, the channel and auto-update
settings and where each came from, the recorded node, and every kept version with
the processes that use it. `--json` prints the same as one JSON document.

`browxai runtime gc` removes kept versions past the newest three that no running
process uses. When it can't read the process list it removes nothing.

`browxai runtime uninstall` removes the runtime directory. It refuses while a server
runs from it, unless you pass `--yes`, and it names the client configs that still
point at the launcher.

## Settings

| Setting                     | Where                                        | What it does                                                                                                                                          |
| --------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BROWX_RUNTIME_DIR`         | environment                                  | The runtime directory, an absolute path. The launcher sets it for the server it starts.                                                               |
| `BROWX_RUNTIME_CHANNEL`     | environment, or `channel` in runtime.json    | `latest` (the default) or `next`. Any other value is refused.                                                                                         |
| `BROWX_RUNTIME_AUTO_UPDATE` | environment, or `autoUpdate` in runtime.json | Read now and shown by `status`. Off in either place wins, and a value other than `on`, `1`, `true`, `yes`, `off`, `0`, `false` or `no` counts as off. |
| `BROWX_RUNTIME_NODE`        | environment                                  | The node the launcher and npm run, before the recorded one.                                                                                           |

`install --channel` writes the channel to `runtime.json`. These settings come only
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

There is no launcher on Windows. Use `npx -y browxai@latest` as the client command,
which resolves the newest version on every start and needs the network to start, or
update with `npm install -g browxai@latest` and restart your MCP client.

## Moving from a hand-made directory

When the runtime path already holds a directory that `browxai runtime` didn't create,
every command stops and prints these steps instead:

1. Unload and remove any background job that updates that directory.
2. Move the directory aside, then run `browxai runtime install`.
3. Point client entries at the launcher, with `--write-client-config` and a
   `--profile-dir` for each further config directory.
4. Remove the old directory once no process uses it.
