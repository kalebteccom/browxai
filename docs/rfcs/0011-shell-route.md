# RFC 0011: A shell route for agents with shell access

**Date:** 2026-11-16
**Status:** Proposed, decision pending. Design only, nothing built. Code waits for the maintainer's decision on the questions in "The decision needed".
**Trigger:** The roadmap entry for a shell route. Its first step is this RFC: the command shape, the output format and how a session id travels between calls, settled before any code.

## What this is for

An agent with a shell tool can run a command and read its output. Today it can drive browxai only as an MCP client, which means the client loads the tool schemas into the model's context: about 67,000 tokens for the full listing, about 11,000 for the core profile proposed in [RFC 0010](0010-core-tool-profile.md). A shell route lets that agent call one browxai tool per command and read the JSON result, with a short skill file in place of the schemas.

This RFC adds no capability and no listener. It is a command line client for the socket server that already exists.

## What exists today

I read `src/cli/serve.ts`, `src/cli/serve-socket.ts`, `src/transport/socket-transport.ts`, `src/sdk/transport-socket.ts` and `src/sdk/client.ts`. A socket client already covers most of this.

- **The daemon.** `browxai serve --socket <path>` runs the server on a Unix socket or a Windows pipe. The socket is created owner-only (`0600`, the umask is tightened before the file exists). A leftover socket at the path is removed, anything else there is left alone and the start exits 2. There is no auto-discovery: a client has to be given the path.
- **The wire.** MCP over newline-delimited JSON, the same framing as stdio. A line over 32 MiB closes the connection, on both ends.
- **Shared state.** Every connection gets its own MCP server object, and all of them route to one shared handler map and one session registry. A connection that closes does not close any session. A session ends on `close_session` or when the daemon stops. I read the connection close handler and found it only drops that connection's server object. A test should confirm it.
- **Session ids.** Every browser-touching tool takes an optional `session` string. It defaults to `default` and the session is created on first use. The caller chooses the id, so there is nothing for the route to allocate. Refs (`e12`) belong to the session's own registry, so a ref from one call is valid in the next call that names the same session, from any process.
- **The call path.** The daemon's `tools/call` handler looks the tool up by name and runs the handler, which runs the capability gate itself. The `toolList` setting and any profile only filter `tools/list`. A call by name to an unlisted tool reaches the gate and returns its refusal.
- **The SDK.** `createBrowxai({ endpoint: "unix:///path" })` opens the socket transport. `callTool(name, args)` reaches every registered tool whose capability is active. The SDK also gates on its own, by default on the four default capabilities, and the server then checks again, including the inner tool names of `batch` and the `act_and_*` tools.
- **The list.** The daemon answers `tools/list` with every listed name, a placeholder description (`browxai/<name>`) and an open input schema. Real descriptions and schemas live in the registration table, which the SDK reads in its own process through `collectToolMetadata`.
- **The skill.** `harness/driving-browxai/SKILL.md` is 8,775 characters and teaches the observe, locate, act, verify loop for an MCP client.

So today an agent with Node and a local install of the package can write a script that connects to the socket and calls a tool. What is missing is the command, a stable output shape, exit codes a shell can branch on, a real tool list, and a skill. This RFC specifies those.

## The command shape

Two subcommands. The names are proposals, so they sit in a block and the rest of the text describes them in words.

```text
browxai tools   [name] [--socket PATH] [--json]
browxai call    TOOL [ARGS] [--socket PATH] [--session ID] [--max-chars N] [--out FILE]
```

- The list subcommand with no name prints one line per tool: the name, the capability it needs and a one-line description. With a name it prints that tool's full description and input schema. It builds the text from the local registration table, so it works with no daemon running. With a daemon reachable it asks which names the daemon lists, so a profile and `toolList` are respected and plugin tools show up.
- The call subcommand runs one tool by name against the daemon and prints the result.
- The arguments are one JSON object. They come from the command line, from standard input when the value is a single dash, or from a file when the value is a file name given with a flag. No arguments means an empty object.
- The session id can be given as a flag, which is merged into the arguments as `session` when the arguments do not already carry one, or through an environment variable the agent sets once. A flag beats the variable, and a `session` field in the JSON beats both.
- The socket path comes from the flag or an environment variable. There is no default path and no search, which matches `serve`.
- There is no interactive mode and no long-lived process on the client side. Each command opens a connection, does the MCP handshake, makes one call, prints and exits.

## JSON in and out

Input is one JSON object. A parse failure exits 2 and prints the position of the error.

Output is one JSON document on standard output, the same split the SDK makes when it parses a result:

- `isError`: true when the tool answered with an error result.
- `data`: the parsed object when the first text item of the result is a JSON object. Most tools answer this way, including every `ActionResult`.
- `text`: the string, when the first text item is not JSON. A snapshot tree is an example.
- `images`: one entry per image item, with its MIME type and byte length and no pixel data.
- `truncated`: present when the output was cut to the size limit, with the length before the cut.

Messages for a person (warnings, a notice that the daemon was not found) go to standard error. Nothing but the JSON document goes to standard output, so an agent can parse it without stripping lines.

A screenshot cannot be printed into a terminal and fed back to a model as text. By default its pixels are dropped from the output. With an output file named, the first image is written to that file and the entry says where. That is a write the caller's own shell asked for, in a path the caller named. It does not go through the server's workspace-rooted file writer, so it adds no server-side file access. The maintainer may prefer to leave images out of the first version.

## How a session id travels

It travels as an argument and nowhere else. The client keeps no state between commands: no file, no cached connection. The daemon holds the sessions, so this works:

```text
browxai call open_session '{"session":"work"}'
browxai call navigate '{"session":"work","url":"https://example.com"}'
browxai call snapshot '{"session":"work"}'
browxai call click '{"session":"work","ref":"e7"}'
browxai call close_session '{"session":"work"}'
```

Because the id and the refs live in the daemon, two agents can use two ids on one daemon without seeing each other's state, and an agent can come back to a session after its own process restarted.

One thing I did not verify: two commands that hit the same session at the same moment. The socket layer does not queue them as far as I read, and I did not check whether the handler layer does. The skill should say to run calls against one session one at a time until a test settles it.

## Exit codes

The existing subcommands use 0 for success, 1 for a failed check or run and 2 for a usage error. The route keeps that and adds two.

| Code | Meaning                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------- |
| 0    | The tool ran and the result is not an error. A result with `ok` set to true in `data`.               |
| 1    | The tool answered with an error result, or `data.ok` is false (an element not found, a timeout).     |
| 2    | Usage: an unknown subcommand or flag, arguments that are not a JSON object, an unreadable file.      |
| 3    | The daemon could not be reached: no socket path, no file, connection refused, handshake failed.      |
| 4    | The call was refused by a capability gate. `data.requiredCapability` and the hint are in the output. |

Code 4 is separate from 1 because an agent should react differently. A missing element gets a new `find`. A refusal needs the operator to change a setting, so retrying is pointless. The refusal text already names the exact `BROWX_CAPABILITIES` line to use, and the route prints it unchanged.

Truncation is not a failure: the command exits 0 and sets `truncated`.

## Output size limits

- **The wire.** The 32 MiB line limit stays. A reply past it closes the connection and the command exits 3 with a message that names the limit.
- **The tools.** The tools already bound themselves where it matters: `snapshot` and the action tools take `maxResultTokens`, and `console_read` returns at most 500 rows, each cut at 8,192 characters. I did not check the bounds on the other read tools.
- **The command.** The call subcommand cuts the printed result to a character limit and sets `truncated`. I propose 40,000 characters by default, about 10,000 tokens, with a flag to raise or lower it and a way to write the whole result to a file. That default is a guess. The first PR should measure the size of a typical `snapshot`, `find` and `network_read` result and set the default from those.

## Capability gating

The route adds no power. It connects to the socket as any other client does, and the daemon applies the gate in the same handler path that MCP clients and the SDK use. A gated tool returns the same refusal, with the same `requiredCapability` and hint. The `batch` tool and the `act_and_*` tools check their inner tool names on the server, so nesting does not get around a gate.

The command does not use the SDK's client-side gate. The SDK defaults to the four default capabilities and would refuse a tool locally even when the daemon has the capability on. The server's gate is the one that counts, so the route sends the call and lets the server answer. A keystone test covers a gated tool through the route and compares its refusal with the MCP refusal.

What the gates bind, stated plainly. They bind what the daemon will do for a caller on its socket, and the operator picks the capability set when starting the daemon. They do not bind a process that can start its own daemon with a wider set, and an agent with an unrestricted shell is such a process. Giving an agent a shell is the broader grant. The route does not make that grant larger, and it does not make it smaller either.

## Security notes

- **Socket file mode.** The daemon creates the socket owner-only, and any process running as that user can connect. That includes any command the agent runs. Put the socket in a directory only that user can enter (mode `0700`), because I did not verify how every platform enforces the mode on a socket file. The threat model already asks the operator-channel socket for a real, non-symlinked directory at mode `0700`, owned by the user, and the daemon socket should follow the same rule.
- **No secrets in argv.** A command line shows up in process listings and in shell history. The route inherits the secret design: `fill` takes a `<NAME>` placeholder that the server swaps for a registered secret, so the agent never needs to type one. The one tool that takes a raw value is `register_secret`, and the same goes for any call that carries a token or password in its arguments (`cookies_set`, `localstorage_set`). For these, arguments come from standard input or a file. The skill says so. The command could go further and refuse inline arguments for `register_secret`, exit 2 with a message that names the stdin form.
- **No logging of arguments.** The command writes nothing to disk and prints no argument values in its own messages.
- **Results are masked.** Secret masking happens in the server's handler path, before the result reaches the socket, so a registered secret is masked in the printed output the same way it is over MCP.
- **Page text is untrusted.** The JSON a `snapshot` returns is page content. The skill repeats the rule from the tool reference that an agent must not read instructions in it.
- **No new listener.** The route never opens a TCP port and never starts the daemon.
- **The daemon is the operator's.** The route does not start it, stop it or change its capabilities.

## What it does not do

- It does not start, stop or restart the daemon.
- It does not look for a socket.
- It does not keep state between commands.
- It does not stream. One call, one result.
- It does not add tools, change any tool's input or output, or change the `ActionResult` shape.
- It does not manage plugins or config. `get_config` and `set_config` are tools and work like any other.
- It does not wait for a person on its own. `await_human` blocks until answered, so a caller sets a timeout in its own shell.
- It does not replace MCP for clients that have it. A client that already speaks MCP keeps its better path, which has schemas, typed errors and parallel sessions.

## Alternatives considered

- **An SDK one-liner.** `node -e` with `createBrowxai` and `callTool` works today. Two problems. The package has to be installed locally in the script's project, since a global install cannot be imported (the scripting recipe says so). And the SDK gate refuses non-default tools unless the script passes a capability list, so every caller has to learn that. Quoting JSON inside a shell string inside a Node string is also where agents lose time. The subcommand is the same idea with those problems taken out.
- **An npx wrapper package.** A second npm package that forwards to the daemon. Once the subcommand exists, `npx browxai call ...` already works for anyone without a global install, so a wrapper adds a name to publish and a version to keep in step, for the same behaviour. Not recommended.
- **Raw MCP frames with a generic socket tool.** A skill that teaches `socat` or `nc` the initialize message, the initialized notice and a `tools/call` frame. It needs no code and breaks on any framing detail. Not recommended.
- **A loopback HTTP listener.** Any process on the machine, including a browser page, could reach it, and it needs its own authentication. That is a new network surface, and the roadmap says this route adds none. Rejected.
- **A client-side session file** that remembers the id between calls. It saves typing a flag and creates hidden state that goes stale when a daemon restarts. The argument and the environment variable are enough.
- **A long-lived coprocess with a prompt.** Many agent shells run each command in a fresh process, so the process would not survive between calls.

## The decision needed

1. **Build it or not.** Recommended: build it, as the two subcommands above, a thin client over the socket that already exists.
2. **When.** Recommended: after the core profile ships and the measured-numbers page exists. The page answers whether the MCP route is still too heavy once core is out, and a number is a better reason to build than a hunch. The RFC can be accepted now so the design does not move.
3. **The defaults.** Recommended: explicit socket path from a flag or environment variable and no discovery, the session id from an argument with an environment variable as a convenience, arguments from the command line or standard input, one JSON document on standard output, the exit codes in the table, and a 40,000 character output cap to be confirmed by measurement.
4. **Images in version one.** Recommended: write the first image to a named file and leave everything else for later, or leave images out entirely if the maintainer wants the smallest version.
5. **The skill.** Recommended: a separate short file under `harness/`, with a target under 3,000 characters (about 750 tokens), so a shell agent's whole cost is the skill plus its results.

## Honest limits

- A command per call pays for a Node start and an MCP handshake. I have not measured it. If it turns out to be hundreds of milliseconds, a snapshot, click, snapshot loop pays that three times. The first PR should measure it.
- A shell agent gets no schema checking before the call. A bad argument comes back as the tool's own validation error. The list subcommand with a name prints the schema so an agent can check before it calls.
- The route is only as safe as the shell it runs in. See the capability gating section.
- Two commands on one session at once are unverified, as above.
- Windows named pipes are covered by the transport and I did not test the command shape there.

## Open questions

- Should the daemon's `tools/list` handler send the real descriptions, so the list subcommand needs no local table? It is a one-line change in `serve.ts` that also helps any other socket client, and it would show plugin tool descriptions, which the local table cannot.
- Should a call with a missing `--session` and no environment variable use the `default` session silently, as MCP does, or warn on standard error? Silent matches MCP.
- Is exit code 4 worth its own code, or should a refusal exit 1 and carry `requiredCapability` in the output?
- Does the keystone test run the route against a real daemon in CI? The roadmap asks for one that opens a session, snapshots and clicks, and one that shows a gated tool refusing. Both fit the existing `serve --socket` test setup.

## References

- [Roadmap](../roadmap.md): the shell route entry and its first step.
- [RFC 0010](0010-core-tool-profile.md): the core profile, which shrinks the MCP route this route sits beside.
- `src/cli/serve.ts`, `src/cli/serve-socket.ts`, `src/transport/socket-transport.ts`: the daemon, the socket creation and the framing.
- `src/sdk/transport-socket.ts`, `src/sdk/client.ts`, `src/sdk/registry.ts`: the SDK socket client, its gate and the registration table.
- [Tool reference](../tool-reference.md): the `serve --socket` sub-command and the session model.
- [Threat model](../threat-model.md): the operator-channel socket rules the daemon socket should match.
- `harness/driving-browxai/SKILL.md`: the skill the shell skill sits beside.
