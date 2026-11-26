# RFC 0013: A stdio-to-socket bridge for MCP clients

**Date:** 2026-11-26
**Status:** Accepted. Decisions D1 to D12 are signed off with their recommended defaults. Slice S1 is built: the daemon listing of D2, the relay and the `browxai bridge` subcommand without `--start`, and the socket check of D10, which also covers `browxai call`, `browxai tools` and the SDK's socket transport. Slice S2 is written: the `init` branch for a run from the app, the `macos-app` reachability detail, the launcher's `login-item start` command and `--start`. Slice S3 is written: the guide, the threat-model rows, the skill note, the README line and the pointer in RFC 0012. Nothing in S2 has run on a Mac. The guide holds the checks the owner runs there.
**Trigger:** Open question 5 of [RFC 0012](0012-signed-macos-app.md): whether to build the stdio bridge so MCP clients can use the app's daemon.

## The problem

Claude Code, Codex, Cursor and Claude Desktop start an MCP server as a child process and talk to it over its standard input and output. The signed macOS app of RFC 0012 runs one long-lived server on a Unix socket as a login agent, so permission grants attach to one stable identity and every caller shares one session registry.

The two do not meet. A client that starts `browxai` gets a new server process with its own registry and its own browsers. That process is a child of the client, so macOS attributes its permission prompts to the client or to the terminal. The app's daemon serves the shell route, the SDK, the operator channel and live view, and no MCP client reaches it.

This RFC specifies a bridge: a CLI mode that speaks MCP over stdio to the client and relays every message to the daemon's socket.

## What exists today

I read the files named in each line. Version numbers for the MCP SDK are from the copy installed in the checkout, 1.30.0. `package.json` asks for `^1.32.2`, so slice 1 reads the same facts again from the resolved version.

- **The daemon** (`src/cli/serve.ts`). `browxai serve --socket PATH` listens on a Unix socket or a Windows named pipe. Each accepted connection gets its own MCP server object from `createClientServer` (`src/cli/serve-client.ts`). All of them call the handler maps of one `createServer` result, so there is one session registry, one config store and one capability set.
- **The socket** (`src/cli/serve-socket.ts`). Created with the umask set to `0177`, so the file is mode `0600` from the start. A leftover socket at the path is removed. Anything else there stops the start with exit 2. A named pipe is listened on as given, with no file mode.
- **The framing** (`src/transport/socket-transport.ts`). Newline-delimited JSON through the SDK's `ReadBuffer` and `serializeMessage`, the same framing as stdio. A line over 32 MiB makes the receiving end destroy the connection. When this RFC was written, `SocketTransport` built its `ReadBuffer` with no size option, and the SDK caps that buffer at 10 MiB by default, so a line between 10 and 32 MiB failed in the data handler. Slice S1 set the buffer's cap from the line limit, so 32 MiB is the limit that applies.
- **What the daemon answers.** `initialize` and `ping` come from the SDK. `tools/list` and `tools/call` come from `createClientServer`. The declared capabilities are `{ tools: {} }`, with no `listChanged`.
- **The daemon's listing** (`src/cli/serve-listing.ts`). Each entry has the first sentence of the tool's description (140 characters at most), an open input schema (`{ type: "object", additionalProperties: true }`) and the tool's capability in `_meta` under `browxai/capability`. A plugin tool is listed with a fixed line. The listing follows `toolList` and `toolProfile`.
- **The stdio server's listing** (`src/server.ts`, `src/transport/listing-trim.ts`). The stdio server uses the SDK's high-level `McpServer`, so each entry has the full description and the real input schema. The SDK's `McpServer` declares `tools.listChanged: true` when a tool is registered. I found no call to `sendToolListChanged` in `src/`.
- **Calls.** The daemon's `tools/call` handler looks the tool up by own property name, prefers the wire handler (which masks registered secrets in thrown errors) and passes only `arguments`. The capability gate runs inside the handler. A tool that is not listed is still callable by name and returns its refusal.
- **Sessions** (`src/session/registry.ts`). The registry is a map in the daemon's memory. A tool call with no `session` uses the id `default`, created on first use. Closing a connection only drops that connection's server object (`serve.ts`), so no session closes when a client leaves. Shutdown closes every session.
- **The socket client** (`src/sdk/transport-socket.ts`, `src/cli/shell-connect.ts`). `connectSocketClient` opens the socket and does the handshake for the SDK and for `browxai call` and `browxai tools`. The socket path comes from `--socket` or `BROWX_SOCKET`. Nothing searches for a socket.
- **The app** (`macos/launcher/main.swift`, `macos/wrappers/browxai`). The launcher's `run` starts the daemon on `--socket`, then `BROWX_SOCKET`, then `~/Library/Application Support/Browxai/run/browxai.sock`, in a directory it creates at mode `0700`. Its `cli` command runs the bundled CLI and sets `BROWX_SOCKET` to that default when the variable is empty. The `Resources/bin/browxai` wrapper, which the cask links onto `PATH`, calls `cli`. The launcher has `login-item status|register|unregister` and no command that starts a stopped agent.
- **The agent plist** (`macos/launchagent.plist.in`). `KeepAlive` with `SuccessfulExit` false and a `ThrottleInterval` of 10 seconds. The daemon exits 0 on `SIGTERM` and `SIGINT` (`serve.ts`), so launchd restarts it after a crash and leaves it stopped after a clean stop.
- **`init`** (`src/cli/init.ts`, `src/cli/init-clients.ts`). It writes `<workspace>/.mcp.json` with two entries, `browxai` and `browxai-attached`, each `node dist/cli.js` with `BROWX_WORKSPACE` and `BROWX_TEST_ATTRIBUTES` in `env`. It adds one entry to the user-level config of Cursor, Codex and Claude Desktop, and prints a `claude mcp add-json` line for Claude Code.
- **`doctor`** (`src/cli/doctor-macos-app.ts`). The `macos-app` row decides whether Node runs from inside the app by checking that `process.execPath` sits under a `.app/Contents/` directory whose `Info.plist` holds `com.kalebtec.browxai`.

## The command

The name is a proposal, so it sits in a block.

```text
browxai bridge [--socket PATH] [--connect-timeout MS] [--start]
```

- It speaks MCP on standard input and output and holds one connection to the daemon for its whole life. One client process means one bridge process and one daemon connection.
- It registers through `registerCommand` in `src/cli/register-commands.ts`, like every other subcommand.
- It takes no tool arguments, no session flag and no capability flag. Nothing secret is ever on its command line.
- Run in a terminal, it prints the same kind of hint the stdio server prints: this is an MCP server on stdio and there is nothing to type.

### Finding the socket

1. `--socket PATH`.
2. `BROWX_SOCKET`.
3. Nothing else. With neither, the bridge exits 3 with the sentence `browxai call` already prints for a missing path.

The app's default path needs no new code in the bridge. The launcher's `cli` command already sets `BROWX_SOCKET` to the app's socket when the variable is empty, so the `browxai` command on `PATH` from the app reaches the app's daemon with no flag. An npm install has no default and needs the flag or the variable. The value accepts a plain path, a pipe name, or the SDK's `unix://` and `pipe://` forms, through the existing `socketPathOf`.

Before connecting to a Unix socket the bridge checks the path with `lstat`: it must be a socket and its owner must be the current user. Otherwise the bridge exits 3 and names the reason. A client's tool arguments would otherwise go to whatever process another user put at a shared path.

### When the daemon is not running

At start the bridge tries the socket every 250 ms for up to `--connect-timeout` milliseconds, 15,000 by default. The agent's `ThrottleInterval` is 10 seconds, so 15 covers a daemon that launchd is about to restart, and a client that starts at login before the agent is up. When the time runs out the bridge writes one sentence to standard error and exits 3 before it answers `initialize`. The sentence names the socket path and the next step: for the app, the launcher's `login-item status` command, and for an npm install, `browxai serve --socket PATH`.

The bridge never runs `serve`, never starts a Node daemon of its own and never registers the login item.

`--start` is opt-in. It works only when the bridge runs from inside the app (the same test the `macos-app` row uses). It runs the app's own launcher once, with a new launcher command that asks launchd to start the registered agent, then goes back to waiting for the socket.

```text
browxai-launcher login-item start
```

Slice S2 added that command to the launcher. It calls `launchctl kickstart` for the label `com.kalebtec.browxai.agent` in the user's `gui` domain. It checks the agent's `SMAppService` status first, and starts nothing when the agent is not registered or is switched off in System Settings, and says so with exit 2. On a macOS without `SMAppService` it goes to `kickstart` directly. Outside the app, `--start` exits 2. Whether `kickstart` starts an agent that `SMAppService` registered is unverified until run on a Mac.

## The relay

The core is a function over two MCP `Transport` objects: the client side and a way to open the daemon side. In production the client side is the SDK's `StdioServerTransport` and the daemon side is `SocketTransport`. Tests pass the SDK's `InMemoryTransport.createLinkedPair()`.

The bridge is a relay. It runs no MCP server and no MCP client of its own, holds no tool table and applies no gate.

### `initialize`, versions and capabilities

The client's `initialize` request goes to the daemon unchanged and the daemon's result comes back unchanged. The client therefore negotiates the protocol version with the daemon's SDK, and sees the daemon's `serverInfo` and capabilities. The bridge keeps a copy of the `initialize` request, the `initialized` notification and the result, for the reconnect case below. It logs the daemon's version to standard error.

`listChanged` passes as the daemon declares it. Today the daemon declares `{ tools: {} }`, so a client behind the bridge sees no `listChanged`, where the stdio server shows `true`. The bridge adds nothing and removes nothing. If the daemon later declares `listChanged` and sends `notifications/tools/list_changed`, the relay carries both with no change.

A bridge from one install and a daemon from another can differ in version. The relay does not read tool names or results, so a version difference changes nothing in the bridge. The client sees the daemon's version.

### The tool listing is the one gap the relay cannot close

A model behind the bridge would get one-line descriptions and no argument schemas, because that is what the daemon lists. The same model on the stdio server gets full descriptions and real schemas. A relay that rewrote `tools/list` from its own install's table would show the wrong tools when the two versions differ, would miss plugin tools and would ignore the daemon's `toolList` and `toolProfile`.

The fix belongs in the daemon: `listedTool` sends the full description and the real input schema, built from the registration record the way `browxai tools NAME` builds it, and keeps the capability in `_meta`. `browxai tools` then cuts the first sentence itself with `summaryOf`. Two things to settle in the build:

- The comment in `serve-listing.ts` says a closed schema would strip arguments on this path. I read `serve-client.ts` as using the SDK's low-level `Server`, which does not validate `tools/call` arguments against a listed schema. A test that sends an argument the schema does not name confirms it before the schema changes.
- A plugin tool's description and schema stay inside the plugin runtime today, so a plugin tool would still list with a fixed line and an open schema. Carrying them out is a follow-up.

This is decision D2. Without it the bridge works and is a worse MCP server than the stdio one.

### Request ids and ordering

Ids pass through unchanged in both directions. The daemon keeps a separate MCP server object per connection, so the id space belongs to this one client and there is nothing to map. Each direction has one first-in, first-out queue: a message is written only after the one before it was accepted by the stream. The daemon's SDK starts each request as it arrives, so responses can come back in a different order from the requests, exactly as they do from the stdio server.

The bridge reads two fields of each message, `id` and `method`, to keep a set of the client's requests that have no response yet. It uses the set only when the daemon connection is lost.

### Notifications, cancellation and progress

Notifications pass unchanged in both directions.

- **Cancellation.** `notifications/cancelled` goes to the daemon, and the bridge removes that id from its set. In the daemon the SDK then sends no response for that request. The tool itself keeps running to its own deadline, because `createClientServer` passes only the arguments to the handler and not the abort signal. That is the daemon's behaviour today for every socket client.
- **Progress.** A `progressToken` in a request's `_meta` reaches the daemon. The daemon sends no progress notifications today, since no handler receives the SDK's notification sender. If it starts to, the relay carries them.
- **Requests from the server.** The daemon declares no capability that would make it send a request to the client. The relay would carry one, and its response back, if that changes.

### Backpressure and the line limit

`StdioServerTransport.send` resolves when standard output drains, and `SocketTransport.send` resolves when the socket write completes. The queue waits on each, which gives backpressure on the writing side. On the reading side the bridge pauses the source stream when a queue holds more than 64 MiB and resumes it when the queue is empty. Memory is then bounded at about two full lines per direction.

Both sides use the 32 MiB line limit.

- A line from the daemon over the limit closes the daemon connection, as `SocketTransport` does today. The bridge handles it as a lost connection (below), and the error names the limit.
- A line from the client over the limit ends the bridge with exit 1 and a sentence on standard error that names the limit. The bridge cannot answer the request, because a line it did not finish reading has no id it can read.

### Half-close

- **The client closes standard input.** The SDK's stdio transport does not watch for the end of input, so the bridge listens for it. It stops reading, gives responses already on their way 2 seconds to reach standard output, closes the socket and exits 0. No session is closed.
- **Standard output closes or a write to it fails.** The client is gone. The bridge closes the socket and exits 0.
- **`SIGTERM` or `SIGINT`.** The same, exit 0.
- **The daemon closes the socket.** A lost connection.

### A lost daemon connection

The bridge stays alive, so the client does not have to restart its server.

1. Every request in the set gets a JSON-RPC error response with the SDK's connection-closed code. The message says the daemon connection was lost and that the call may or may not have run.
2. A request that arrives while there is no connection gets the same error at once. Nothing is queued for later: a click replayed against a new daemon would run against a session that no longer exists.
3. The bridge tries the socket again, every 250 ms at first and at most every 5 seconds. With `--start` it asks the launcher once per loss.
4. On a new connection it sends the saved `initialize` request and `initialized` notification, and keeps the response to itself. Requests that arrive during those few milliseconds wait in the queue.
5. If the new result's protocol version or capabilities differ from what the client was told, the bridge writes the reason to standard error and exits 3. The client's own restart then negotiates again. A different `serverInfo.version` alone is logged and the bridge carries on.

**What the client sees after a daemon restart.** The session registry was in the old process, so every session is gone and every ref is stale. A call that names an old session id creates a new, empty session with that id, because ids are created on first use. Cookies and logins of a persistent profile are on disk in the workspace and are still there. The record of which session names held an `ask-human` policy lives for the server process (`src/session/registry.ts`), so a restarted daemon has lost it. The agent has to navigate and take a snapshot again. A daemon upgrade can change the tool list, and with no `listChanged` the client learns that only on its next `tools/list`.

**What the client sees when only the connection dropped.** The daemon is the same process, so sessions and refs are intact and the next call works.

## Per-client isolation

Each client gets its own bridge process, its own daemon connection and its own MCP server object in the daemon. Request ids, the `initialize` state and in-flight requests never mix between clients.

Everything below the server object is shared, and that is the daemon working as built:

- **Session ids are one namespace.** Two clients that both leave out `session` drive the same `default` session, where two stdio servers today each have their own. A client that names its sessions is isolated from one that uses other names. `list_sessions` shows every client's sessions, and `close_session` can close another client's.
- **A persistent profile has one live session.** A second persistent session on the same profile is refused with `profile-in-use`, whichever client asks.
- **Config and capabilities are the daemon's.** `set_config` from one client changes what every client gets. The capability set is the one the daemon started with.
- **Sessions outlive the client.** When a client exits, its sessions stay open in the daemon until `close_session`, `close_sessions` or a daemon stop. On the stdio server they end with the process.
- **Per-client environment does nothing.** `BROWX_WORKSPACE`, `BROWX_CAPABILITIES`, `BROWX_TEST_ATTRIBUTES`, `BROWX_ATTACH_CDP`, `BROWX_ENGINE` and `--engine` in a client's config entry configure a stdio server. The bridge starts no server, so they have no effect. When the bridge finds any `BROWX_*` variable other than `BROWX_SOCKET` in its environment, it writes one line to standard error that lists the names, never the values, and says the daemon's settings apply.

Decisions D3 and D4 cover the shared `default` session and the sessions left open.

## Security

- **Same user only.** The daemon's socket is mode `0600`, and the app keeps it in a directory at mode `0700`. The bridge checks the socket's owner before it connects. On Windows a named pipe has no file mode in `serve-socket.ts`, and the bridge skips the owner check there.
- **No new listener.** The bridge opens no socket of its own and no TCP port.
- **No new capability.** The bridge runs no tool. Every call goes through the daemon's handler, so the capability gate, origin rules, confirm hooks and the operator channel apply as they do for any socket client. A gated tool returns the daemon's own refusal with its `requiredCapability` and hint.
- **The same masking.** The daemon masks registered secrets before a result reaches the socket, and the relay does not touch results.
- **No secrets in argv.** The flags are a path, a number and a switch. Tool arguments, including a `register_secret` value, travel on standard input as MCP frames, which is how a stdio MCP client already sends them.
- **Nothing written to disk.** The bridge keeps no state file and no log file.
- **What the bridge does not bound.** Any process running as the user can already connect to the socket. The bridge gives an MCP client the reach `browxai call` already gives a shell.
- **The identity point.** The bridge is a child of the client, and it does no work that macOS protects: it reads standard input and writes to a socket in the user's own Application Support folder. The daemon launches the browsers and tools, under the app's identity. Whether a sandboxed client app can start the wrapper or reach that folder is unverified.

## Logging

Standard output carries MCP frames and nothing else. Every message for a person goes to standard error through the existing logger (`src/util/logging.ts`, which writes to standard error only). The bridge logs the socket path, connect and disconnect events, the daemon's version, each dropped line and the names of ignored variables. It never logs a frame, a tool name with its arguments, or a variable's value.

## Exit codes

They follow the shell route.

| Code | Meaning                                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0    | The client closed standard input or output, or the bridge got `SIGTERM` or `SIGINT`.                                             |
| 1    | An internal error, or a line from the client over the 32 MiB limit.                                                              |
| 2    | Usage: an unknown flag, a flag with no value, `--start` outside the app.                                                         |
| 3    | The daemon could not be reached at start, the socket failed the owner check, or a reconnected daemon negotiated different terms. |

## Installing it in a client

With the app installed, the cask links the app's `browxai` wrapper onto `PATH`, and the wrapper supplies the socket path. The client entry is the wrapper plus the subcommand:

```text
claude mcp add browxai --scope user -- browxai bridge
codex mcp add browxai -- browxai bridge
```

For Cursor and Claude Desktop the entry is a JSON block with the absolute path of the wrapper as `command` and the subcommand as the one argument, and no `env`. The path is absolute because a client started from the desktop does not get the shell's `PATH`, which `init` already accounts for. A cask upgrade replaces the app at the same path, so the entry stays valid.

With an npm install the same subcommand works against a daemon the user started, with `--socket PATH` in the arguments.

A bare `browxai` with no subcommand keeps starting the stdio server, from the app and from npm alike.

## What `init` writes

`init` decides by where it runs from, with the test the `macos-app` row uses. It does not look for an installed app from an npm install.

- **Run from npm or a checkout.** No change. Every entry is the stdio server, as today.
- **Run from the app.** The user-level entry for Cursor, Codex and Claude Desktop, and the printed Claude Code line, name the bridge: the wrapper's absolute path, the subcommand, and an empty `env`. `init` says in one line that these entries use the app's daemon and its settings.
- **The workspace `.mcp.json`.** Unchanged in both cases: the two stdio entries with the per-workspace `BROWX_WORKSPACE` and `BROWX_TEST_ATTRIBUTES`. The `browxai-attached` entry needs `BROWX_ATTACH_CDP` and its own capability list, which only a stdio server reads. `init` prints that a project opened with this file runs its own server and does not use the app's daemon.

The last point has a cost. In a client that prefers the project file over the user entry, a workspace that `init` set up keeps the stdio server. The other choice is in decision D8.

The headless check at the end of `init` starts a stdio server from `dist/cli.js` and stays as it is. It does not need the daemon.

## What `doctor` reports

The `macos-app` row keeps its rules: macOS only, informational, never a failure. When browxai runs from the app, the row adds whether a daemon answers on the app's socket: a connection that opens and closes, with no handshake and a 2 second bound. The detail gains `daemon reachable` or `no daemon on the socket`, and the second one carries a next step that names `login-item status`. Outside the app the row's one line does not change. `doctor` does not read client config files to see which command they name.

## Windows and Linux

- **What exists.** `serve --socket` accepts a Windows named pipe (`isPipePath` in `serve-socket.ts`), and the SDK transport accepts `pipe://`. On Linux the Unix socket path works as on macOS.
- **What the bridge does there.** It works with an explicit `--socket` or `BROWX_SOCKET` against a daemon the user started. There is no default path, because there is no app.
- **Out of scope.** A login service for Linux (a systemd user unit) or Windows, `--start` on either, access control on a Windows pipe, and any test on Windows. RFC 0011 left the pipe untested for the shell route, and that has not changed.

## Testing plan

1. **Unit, the relay.** Two `InMemoryTransport` pairs stand for the client and the daemon. Cases: a request and its response pass with the id unchanged, notifications pass both ways, a cancel removes the id from the set, order holds in each direction, a slow writer pauses the reader, a lost daemon side answers every open request once and no cancelled one, a request during the loss is answered at once, a reconnect replays the saved handshake and hides its response, changed capabilities end the relay.
2. **Unit, the command.** Argument parsing, the socket order, the owner check against a temporary directory, the ignored-variable line with no values in it, each exit code.
3. **Hermetic, a real daemon and a real child.** `startServeForTests` on a temporary socket and the built CLI started as a stdio child with the bridge subcommand, driven by the SDK's stdio client. It asserts the `initialize` result equals what a direct socket client gets, and that `tools/list` matches.
4. **Keystone, real Chromium.** The same setup opens a session, navigates, takes a snapshot and clicks through the bridge. It calls one gated tool with the capability off and compares the refusal, field by field, with the one a direct socket client gets and with the one the stdio server returns.
5. **Daemon restart.** With a call in flight the daemon shuts down. The test asserts the in-flight call gets the error, a call during the gap gets the error, a daemon started again on the same path is picked up, the next call works, and a ref from before the restart fails as stale.
6. **Limits.** One line over 32 MiB in each direction, and one of 11 MiB, to record what the SDK's own buffer cap does.
7. **On a Mac, by hand.** The app's wrapper as the command in Claude Code, a cask upgrade with a client attached, and `--start` against a stopped agent.

## Semver

The subcommand is additive: no existing command, flag, tool name, input or output shape, or `ActionResult` field changes, and the default capability set stays the same. It ships in a minor release.

Decision D2 changes what `tools/list` returns from a `serve --socket` daemon: longer descriptions and real schemas where it sends one line and an open schema today. That listing is not part of the frozen surface in `docs/tool-reference.md`, and it changed once already in 0.19.0. It gets a CHANGELOG entry and an upgrade note.

## Alternatives considered

- **Make the app the stdio server**, so a client's entry runs the launcher's `cli` command with no arguments. It needs no new code and it works today. The server it starts is a second process with its own registry and browsers, and it is a child of the client, so macOS attributes its prompts to the client by the rule RFC 0012 describes. Two clients mean two servers on the same default profile. It keeps the bundled Node and loses both things the app is for.
- **A streamable HTTP transport on the daemon.** Clients that speak HTTP could connect with no bridge. It needs a loopback TCP listener, which any local process and any web page can reach, so it needs its own authentication and origin checks, a threat-model row and a capability. RFC 0011 rejected a loopback listener for the same reason. Client support for a local HTTP server with a token also differs from client to client.
- **`socat` or `nc` as the client's command.** No code in this repository. The wire is the same newline-delimited JSON, so it works until the daemon restarts, and then the client holds a dead server. It gives no clear error when the daemon is absent, no owner check, no reconnect, and it is one more program to install. It is a fine way to test the daemon by hand.
- **The bridge as an MCP server with its own tool table,** which calls the daemon through the SDK client. It could list full schemas with no daemon change. It would list its own install's tools, miss plugin tools, ignore the daemon's `toolList` and `toolProfile`, and need the SDK's client-side gate handled the way RFC 0011 had to. A relay has none of those problems.
- **A bare `browxai` that bridges by itself when it finds the app's daemon.** One less word in the client config. It changes what the default command does depending on machine state, and a client entry that carries `BROWX_WORKSPACE` would change meaning with no edit. Rejected.

## Failure modes

| What happens                                            | What the client sees                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| No socket path                                          | The server exits 3 at start. Standard error names `--socket` and `BROWX_SOCKET`.                              |
| No daemon within the connect time                       | The server exits 3 at start. Standard error names the path and the next step.                                 |
| The path is not a socket, or another user owns it       | The server exits 3 at start with the reason.                                                                  |
| The login agent is switched off, with `--start`         | The launcher says so, and the server exits 3 when the connect time runs out.                                  |
| The daemon crashes with a call in flight                | An error response for that call. launchd restarts the daemon after about 10 seconds and later calls work.     |
| The daemon is stopped cleanly                           | Error responses until someone starts it. With `--start` the bridge asks the launcher once.                    |
| A cask upgrade replaces the app while a client is open  | As a restart. If the new daemon negotiates different terms the server exits 3 and the client starts it again. |
| The bridge's own files are replaced by the upgrade      | The running bridge keeps the code it loaded. The next start uses the new files.                               |
| A reply over 32 MiB                                     | An error response that names the limit. The session is intact.                                                |
| A request over 32 MiB                                   | The server exits 1.                                                                                           |
| A line from the client that is not valid JSON-RPC       | The line is dropped and the drop is logged. No response, since it has no id the bridge can trust.             |
| Two clients leave out `session`                         | Both drive the `default` session.                                                                             |
| The client exits                                        | Its sessions stay open in the daemon.                                                                         |
| A client entry carries `BROWX_CAPABILITIES`             | It has no effect. Standard error names the variable.                                                          |
| A tool waits on a person longer than the client's limit | The client gives up on the request, as it does on the stdio server. The tool keeps waiting in the daemon.     |

## Decisions for the reviewer

Each has a recommended default. A sign-off with no comment accepts the defaults.

| #   | Decision                                                            | Recommended default                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Build the bridge, and its name.                                     | Build it, as the subcommand in the block above. A relay over the `Transport` interface, with no tool table.                                                                                                                                            |
| D2  | How a client behind the bridge gets full descriptions and schemas.  | Change the daemon's listing to send them to every socket client, and have `browxai tools` cut the first sentence itself. First PR of slice 1. Plugin tool schemas stay a follow-up.                                                                    |
| D3  | The shared `default` session between clients.                       | Keep one namespace in this RFC and document it in the tool reference and the skill. A default session per connection is a daemon change with its own RFC amendment, because `browxai call` opens a new connection per command and must keep `default`. |
| D4  | Sessions when a client disconnects.                                 | Leave them open. The daemon cannot tell which connection a session belongs to, and `close_sessions` already selects by prefix and idle time.                                                                                                           |
| D5  | The daemon is absent at start.                                      | Wait up to 15 seconds, then exit 3 before answering `initialize`.                                                                                                                                                                                      |
| D6  | The daemon is lost mid-session.                                     | Stay alive, fail open and new requests, reconnect and replay the handshake. Exit 3 only when the negotiated version or capabilities changed.                                                                                                           |
| D7  | `--start`.                                                          | Opt-in, app only, through a new launcher command that kickstarts the registered agent. It never registers the agent and never runs `serve`. Ships with slice 2.                                                                                        |
| D8  | What `init` writes when run from the app.                           | The bridge for user-level entries. The workspace `.mcp.json` keeps its stdio entries, with a printed line that says so. The other choice writes the bridge there too and drops per-workspace settings.                                                 |
| D9  | `BROWX_*` settings in a bridge entry.                               | Ignore them and name them on standard error. Do not forward them to the daemon.                                                                                                                                                                        |
| D10 | The owner check on the socket before connecting.                    | Yes for the bridge. At sign-off the check was extended to `browxai call`, `browxai tools` and the SDK, and it also refuses a symbolic link and a socket open to group or others.                                                                       |
| D11 | The `macos-app` row gains daemon reachability.                      | Yes, informational only.                                                                                                                                                                                                                               |
| D12 | The abort signal and progress in the daemon's `tools/call` handler. | Out of scope here. The relay carries both already.                                                                                                                                                                                                     |

## Could not verify

- Every SDK fact above was read from version 1.30.0 in `node_modules`, and `package.json` asks for `^1.32.2`. That covers the `McpServer` `listChanged` declaration, the dropped response after a cancel, the `StdioServerTransport` `maxBufferSize` option and its lack of an end-of-input handler, and `InMemoryTransport`.
- Resolved in S1: the SDK's 10 MiB `ReadBuffer` default did apply inside `SocketTransport` before the 32 MiB check, and `append` threw inside the socket's data handler. The buffer's cap now follows the line limit and the handler closes the connection on any error.
- Resolved in S1: the low-level `Server` leaves `tools/call` arguments alone when the listing carries a closed schema. `src/cli/serve-client.test.ts` holds the check.
- Nothing was run on a Mac: `launchctl kickstart` on an agent that `SMAppService` registered, a client app starting the wrapper by absolute path, a sandboxed client reaching the socket folder, and what a cask upgrade does to an open bridge.
- Which config scope each client prefers when a project file and a user entry share a name. I did not check it per client.
- Nothing on Windows.
- Two calls on one session at the same moment, which RFC 0011 also left open. Two clients on `default` make it more likely.

## Slices

Each is one small PR, in this order. Nothing starts before sign-off.

1. **S1, the bridge core and its tests.** First the daemon listing change of D2, as its own PR with the shell route's tests updated. Then the relay, the subcommand, the usage text, and tests 1 to 6. CHANGELOG entry and the tool reference line land with the code, per the docs-impact rule.
2. **S2, `init`, `doctor` and the launcher.** The `init` branch for a run from the app, the `macos-app` reachability detail, and the launcher's start command with `--start`. The Swift change needs a new app build, so the owner verifies it on a Mac.
3. **S3, docs.** A guide page for connecting an MCP client to the app's daemon, the threat-model row for the bridge, the shared-session note in the `driving-browxai` skill, the README line, and RFC 0012's "How MCP clients connect" section updated to point here.

## References

- [RFC 0012](0012-signed-macos-app.md): the app, the login agent, the launcher and open question 5.
- [RFC 0011](0011-shell-route.md): the shell route, whose exit codes and socket rules the bridge follows.
- `src/cli/serve.ts`, `src/cli/serve-client.ts`, `src/cli/serve-listing.ts`, `src/cli/serve-socket.ts`: the daemon.
- `src/transport/socket-transport.ts`, `src/transport/listing-trim.ts`, `src/sdk/transport-socket.ts`, `src/cli/shell-connect.ts`: the framing and the socket client.
- `src/session/registry.ts`: the session registry and the `default` id.
- `src/cli/init.ts`, `src/cli/init-clients.ts`, `src/cli/doctor-macos-app.ts`: what S2 changes.
- `macos/launcher/main.swift`, `macos/wrappers/browxai`, `macos/launchagent.plist.in`: the app side.
