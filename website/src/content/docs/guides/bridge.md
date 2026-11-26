---
title: Connect MCP clients to one daemon
description: Point Claude Code, Codex, Cursor or Claude Desktop at a running browxai daemon with `browxai bridge`, so several clients share one server. Covers the macOS app and an npm install, what the clients share, what happens when the daemon stops, and the checks to run on a Mac.
---

An MCP client starts its server as a child process and talks to it over standard
input and output. Each client that starts `browxai` therefore gets its own server,
with its own sessions and its own browsers. `browxai bridge` is the command to use
when you want those clients on one long-lived server: a `browxai serve --socket`
daemon you started, or the daemon of the Browxai macOS app.

The bridge is a relay. It speaks MCP on stdio to the client and passes every
message, unchanged, to the daemon's socket. It runs no tool, holds no tool list,
adds no capability and opens no listener. The client negotiates with the daemon's
own MCP server, so it sees the daemon's version, capabilities and tools.

```text
browxai bridge [--socket PATH] [--connect-timeout MS] [--start]
```

## With the macOS app

The app runs one daemon as a login agent. Its `browxai` command, which the
Homebrew cask links onto `PATH`, already knows the daemon's socket, so the client
entry is the command and the subcommand:

```bash
claude mcp add browxai --scope user -- browxai bridge
codex mcp add browxai -- browxai bridge
```

Cursor and Claude Desktop start from the desktop and do not get your shell's
`PATH`, so their entry names the command by its absolute path inside the app, with
no `env`:

```json
{
  "mcpServers": {
    "browxai": {
      "command": "/Applications/Browxai.app/Contents/Resources/bin/browxai",
      "args": ["bridge"],
      "env": {}
    }
  }
}
```

`browxai init <workspace>` writes these for you when you run it with the app's
`browxai` command. The user-level entries for Cursor, Codex and Claude Desktop, and
the line it prints for Claude Code, name the bridge. Run from an npm install or a
source checkout, `init` writes the stdio server as before. It decides by where it
runs from and does not look for an installed app.

The workspace `.mcp.json` that `init` writes keeps its two stdio entries in both
cases, because they carry settings for that workspace (`BROWX_WORKSPACE`,
`BROWX_TEST_ATTRIBUTES`, and the attach endpoint of `browxai-attached`) that only a
stdio server reads. A project opened with that file runs its own server and does
not use the app's daemon. `init` says so when it runs from the app.

A bare `browxai` with no subcommand still starts a stdio server, from the app and
from npm alike.

## With an npm install

Start a daemon, then give the bridge its socket. There is no default path and
nothing is searched for.

```bash
mkdir -m 700 /tmp/browxai
browxai serve --socket /tmp/browxai/daemon.sock
```

```bash
claude mcp add browxai --scope user -- browxai bridge --socket /tmp/browxai/daemon.sock
```

`BROWX_SOCKET` in the entry's `env` works in place of the flag. This route works
on Linux as it does on macOS. On Windows the socket is a named pipe, which is
untested.

## What the clients share

Each client gets its own bridge process and its own connection, so request ids
and in-flight calls never mix. Everything below the connection belongs to the
daemon and is shared.

- **Sessions are one namespace.** Two clients that both leave out `session` drive
  the same `default` session. Give each client its own session ids when they
  should stay apart. `list_sessions` shows every client's sessions, and
  `close_session` can close another client's.
- **A persistent profile has one live session.** A second persistent session on
  the same profile is refused with `profile-in-use`, whichever client asks.
- **Capabilities and config are the daemon's.** The capability set is the one the
  daemon started with. `set_config` from one client changes what every client
  gets.
- **Sessions outlive the client.** When a client exits, its sessions stay open
  until `close_session`, `close_sessions` or a daemon stop.
- **Settings in the client's entry do nothing.** `BROWX_WORKSPACE`,
  `BROWX_CAPABILITIES`, `BROWX_ATTACH_CDP` and every other `BROWX_*` variable
  except `BROWX_SOCKET` configure a stdio server, and the bridge starts none. It
  names the ones it found on standard error, without their values.

The daemon's capability gate, origin rules, confirmation hooks and secret masking
apply to every call, exactly as they do for `browxai call`. A gated tool returns
the daemon's own refusal.

## When the daemon is not running

At start the bridge tries the socket every 250 ms for up to `--connect-timeout`
milliseconds, 15000 by default. That covers a client that starts at login before
the agent is up. When the time runs out it exits 3 before it answers `initialize`,
and standard error names the socket and the next step.

The bridge never runs `browxai serve` and never registers the app's login agent.

`--start` is an opt-in for the app. When no daemon answers, the bridge runs the
app's launcher once with `login-item start`, which asks launchd to start an agent
that is already registered and allowed to run, then goes back to waiting for the
socket. It starts nothing when the agent is not registered or is switched off in
System Settings, and the launcher's answer goes to standard error. Outside the app
`--start` is a usage error and the bridge exits 2.

```bash
claude mcp add browxai --scope user -- browxai bridge --start
```

## When the daemon stops mid-session

The bridge stays up, so the client does not have to restart its server.

- A call with no answer yet gets a JSON-RPC error (code `-32000`) that says the
  call may or may not have run.
- A call that arrives while there is no connection gets the same error at once
  and is not sent. Nothing is replayed.
- The bridge tries the socket again, every 250 ms at first and at most every 5
  seconds, and repeats the client's handshake on the new connection. With
  `--start` it asks the launcher once for each loss.
- If the new daemon negotiates a different protocol version or different
  capabilities, the bridge exits 3 and the client starts it again.

A restarted daemon has lost every session and every ref. Cookies and logins of a
persistent profile are on disk and are still there. Navigate and take a snapshot
again. When only the connection dropped and the daemon is the same process,
sessions and refs are intact and the next call works.

## Check the setup

`browxai doctor --verbose`, run with the app's `browxai` command, shows the
`macos-app` row. It ends with `daemon reachable` when a daemon accepts a
connection on the app's socket, and with `no daemon on the socket` and a next step
when none does. The check opens a connection and closes it, sends nothing and
waits 2 seconds at most. It never fails `doctor`. Outside the app the row is one
line and nothing is probed.

`browxai tools` with the same socket prints what the daemon lists, which is what a
bridged client sees.

## Exit codes

| Code | Meaning                                                                                                           |
| ---- | ----------------------------------------------------------------------------------------------------------------- |
| 0    | The client closed standard input or output, or the bridge got `SIGTERM` or `SIGINT`.                              |
| 1    | An internal error, or a line from the client over the 32 MiB limit.                                               |
| 2    | Usage: an unknown flag, a flag with no value, or `--start` outside the app.                                       |
| 3    | No daemon answered at start, the socket failed the owner check, or a restarted daemon negotiated different terms. |

The owner check: before it connects, the bridge requires the path to be a socket
and not a symbolic link, owned by you, with no access for group or others. That is
how `browxai serve --socket` creates it.

## Checks to run on a Mac

The app route was written without a Mac in the loop. These checks need a signed
build of the app with the current launcher and a real login session, so the
release owner runs them by hand before the app route is announced. Each line says
what to do and what to expect.

The launcher is `Browxai.app/Contents/MacOS/browxai-launcher`. The agent's label
is `com.kalebtec.browxai.agent`.

**The launcher's start command**

1. Build and sign the app from this revision, then run `browxai-launcher help`.
   Expect `login-item status|register|unregister|start` in the usage.
2. Run `login-item register`, then `login-item status`. Expect `enabled`.
3. Stop the agent cleanly with
   `launchctl kill SIGTERM gui/$(id -u)/com.kalebtec.browxai.agent`. Expect the
   daemon to exit and launchd to leave it stopped.
4. Run `login-item start`. Expect a line that begins with `started:`, exit code 0,
   and a daemon on the socket a moment later. This is the open question of the
   design: whether `launchctl kickstart` starts an agent that `SMAppService`
   registered.
5. Run `login-item start` again while the daemon runs. Expect exit code 0 and the
   same daemon process id as before.
6. Run `login-item unregister`, then `login-item start`. Expect a line that begins
   with `nothing was started`, exit code 2, and no daemon.
7. Register again, switch Browxai off in System Settings, General, Login Items &
   Extensions, then run `login-item start`. Expect `requires approval`, exit code
   2, and no daemon.

**`doctor`**

8. With the agent running, run `browxai doctor --verbose` through the app's
   command. Expect the `macos-app` row to end with `daemon reachable`.
9. Stop the agent as in step 3 and run `browxai doctor`. Expect a `⚠` for the
   install area with `no daemon on the socket` and a next step that names
   `login-item status`, and exit code 0.

**`init`**

10. Run `browxai init <workspace> --no-write` through the app's command. Expect
    the user-level entries to name `Contents/Resources/bin/browxai` with the one
    argument `bridge` and an empty `env`, the workspace `.mcp.json` snippet to
    keep its two `node` entries, and the two lines about the app's daemon.
11. Run the same `init` from an npm install. Expect the stdio entries and neither
    line.

**A client on the bridge**

12. Add the entry to Claude Code with the first command of this page, start a
    session, navigate and take a snapshot. Then run
    `browxai call list_sessions '{}'` in a terminal. Expect the session the
    client opened in the list.
13. Add the JSON entry with the absolute path to Cursor or Claude Desktop, and
    start that client from the Dock. Expect the tools to list. Note whether a
    sandboxed client can start the command and reach the socket's folder.
14. Trigger a macOS permission prompt through a bridged client. Expect the prompt
    to name Browxai and not the client or the terminal.
15. Open the same workspace with a project `.mcp.json` and a user-level entry of
    the same name, and note which one each client uses.

**`--start`**

16. Change the entry to `browxai bridge --start`, stop the agent as in step 3 and
    start the client. Expect the server to come up, and the client's server log to
    hold `asked the app's login agent to start`.
17. With a session open, stop the agent again. Expect an error for a call in
    flight, one more `asked the app's login agent to start` line, and the next
    call to work on a new session.
18. Run `browxai bridge --start` from an npm install. Expect exit code 2.

**Upgrades**

19. Run a cask upgrade with a client attached. Expect the bridge to reconnect to
    the new daemon, or to exit 3 and the client to start it again.

## Related

- [Drive browxai from a shell](/guides/shell-route/) covers `browxai call` and
  `browxai tools`, the other clients of the same daemon.
- [Run browxai in a container and in CI](/guides/containers-and-ci/) covers a
  daemon shared between containers.
- The tool reference lists every flag of `browxai bridge` and `browxai serve`.
