# browxai roadmap

> What we plan to build next, in order, and what we do not plan to build. Written against v0.16.0 on 2026-11-16. It is a plan, and an item can move or drop when evidence changes. Dates are not promised.

## What browxai is for

browxai is an MCP server that lets an AI agent drive a web page or a native app with the same tools. The agent gets a compact page view, ranked `find` results and a structured `ActionResult` after every action. Everything past reading, navigating and acting starts off, each behind its own capability with a test that proves the gate blocks. It runs on your machine, over MCP or a typed TypeScript SDK, and works with any MCP client.

## Ranked list

Ranked by value over cost, then by fit with the capability-gated posture. Size is S (days), M (a few weeks) or L (a month or more, or needs hardware we do not have in CI).

| #   | Item                                          | Size |
| --- | --------------------------------------------- | ---- |
| 1   | List only the tools whose capability is on    | S    |
| 2   | A lean `core` tool profile, then lazy loading | M    |
| 3   | A shell route: `browxai call`                 | M    |
| 4   | Measured numbers and a checked first run      | S    |
| 5   | Dated evidence for every engine               | M    |
| 6   | `ios-app` against a real WebDriverAgent       | L    |
| 7   | A reference deployment for containers and CI  | M    |
| 8   | Replay player panels (RFC 0007, phase 4)      | M    |
| 9   | Plugin ecosystem growth                       | M    |
| 10  | An optional natural-language action layer     | L    |

### 1. List only the tools whose capability is on (S)

- **What.** `tools/list` leaves out a tool when its capability is off. A call to a hidden tool still reaches the gate and returns the refusal that names the capability to grant.
- **Why.** Today every core tool is registered with the MCP SDK whatever the capability set. Nothing disables a tool or filters the listing, and the refusal `tool "x" is disabled` only happens at call time. The listing is 269,340 characters (about 67,000 tokens) for 209 tools. A count of the registrations puts roughly 150 of the 209 in the four default capabilities or in session control, so a default user pays for about 55 tools they cannot call. Expect a cut of 25 to 30 percent. The first PR measures the exact figure. Plugin tools are already left out when their capability is off.
- **Risk.** Low. The capability set is fixed at server start, so the listing does not change mid-session and no list-changed notice is needed. A client that pinned a tool name sees it vanish until the capability is granted, so the refusal text and the troubleshooting page must still explain it. This changes what default users see in `tools/list`, so it ships as a minor with a CHANGELOG note.
- **Done.** With the default capabilities `tools/list` holds no `eval_js`, and with `eval` granted it holds it. A test pins the default listing size. The refusal for a hidden tool called by name is unchanged.
- **First PR.** A listing filter that reads each tool's declared capability, plus the two tests above and a CHANGELOG line. The existing `tools/list` trimming transport or the host registration seam is the place to decide where it lives.

### 2. A lean `core` tool profile, then lazy loading (M)

- **What.** A config key and `BROWX_TOOL_PROFILE` with two values, `full` (today) and `core`. `core` lists about 25 to 35 tools: session control, `navigate`, `snapshot`, `find`, the basic actions, `wait_for`, `screenshot`, `console_read`, `network_read`, the `verify_*` family and `batch`. A profile can add named groups, for example `core,+storage`. Lazy loading, where the server announces more tools on demand, comes after, and only for clients that honour list-changed notices.
- **Why.** Item 1 trims the listing by a quarter. The rest is the number of tools. Agents that only need to open a page and click should not carry the schemas for HAR, heap snapshots and canvas gestures. The 0.15.0 trim already took 18 percent out of the descriptions, so the remaining lever is fewer tools.
- **Risk.** Medium. A new config key is an additive change to the stable surface. Which tools are core is a product call. Default stays `full` until measurements show `core` loses nothing, and flipping the default is a later, announced change. A profile only narrows the listing, so it never grants a capability.
- **Done.** `core` lists under 50,000 characters (about 12,000 tokens, a target to confirm). A fitness test fails if the core listing grows past its budget. The tool reference documents the profile and its groups. The capability-testbed drives every core tool.
- **First PR.** The core set as a frozen constant, the config key and env var wired to the listing filter from item 1, the budget test, and docs. Default stays `full`, so nothing changes for anyone who does not opt in.

### 3. A shell route: `browxai call` (M)

- **What.** `browxai tools` prints the tool names and one-line descriptions. `browxai call <tool> '<json>'` runs one tool against a server started with `browxai serve --socket` and prints the result. A skill file teaches the loop, so an agent with shell access pays for a short skill and no tool schemas.
- **Why.** An agent with a shell can call a command line, and a short skill file takes less context than 209 schemas. The pieces exist: the socket server, the typed SDK `callTool` surface, and the `driving-browxai` skill under `harness/`. Item 2 shrinks the MCP route and this item adds a second one.
- **Risk.** Medium. Each command is a new process, so session state has to live in the `serve --socket` daemon. The socket is owner-only (`0600`) and the route goes through the same handlers, so the gates, origin rules and secret masking apply unchanged. No new network listener.
- **Done.** A documented page, a skill that uses it, and a keystone test that opens a session, snapshots and clicks through `browxai call`, plus one that shows a gated tool refusing.
- **First PR.** An RFC with the command shape, the output format and how a session id travels between calls. No code until it is accepted.

### 4. Measured numbers and a checked first run (S)

- **What.** One docs page with three figures that anyone can reproduce: `tools/list` size per profile, snapshot size on three fixed fixture pages, and the time from `npm install -g browxai` to the first snapshot on a clean container. A script prints them.
- **Why.** The README says "token-efficient" and the repo holds no comparison, only the 0.15.0 listing figures. The testbed report shows 196 of 196 tools passing, which is a coverage number and says nothing about cost. Install friction is the other open question: a global install, a client entry and, for attach, a capability edit and a restart (the 0.14.0 upgrade notes).
- **Risk.** Low. A number may look worse than the README wording, and the wording changes if it does. No claim of being faster or cheaper than another tool goes in, because there is no like-for-like method.
- **Done.** The page, the script, a test that fails when a figure grows past its budget, and a README line that links to it.
- **First PR.** The script, with output for the default and `full` listings. Profiles join once item 2 lands.

### 5. Dated evidence for every engine (M)

- **What.** A table in the tool reference with, for each of the eight engines, what ran, on which version, on what date, and how to rerun it. Then close the cheapest gaps: an Android emulator run of the `android` engine and a macOS run of `safari`.
- **Why.** The cross-engine suite runs on Chromium, Firefox and WebKit. The `android` and `safari` engines are exercised by hand, and the Electron evidence is one app on one machine.
- **Risk.** Low for the table. Medium for new runs, since emulators and macOS runners are slow and flaky. A run that cannot stay green nightly stays a documented manual run.
- **Done.** Every engine row has a date within the last release and a command. Claims in the README match the table.
- **First PR.** The table, filled from the latest testbed report, with blanks marked "not run".

### 6. `ios-app` against a real WebDriverAgent (L)

- **What.** Run the `ios-app` keystone against a real WebDriverAgent on a booted iOS Simulator and record the result.
- **Why.** The `simctl` half runs against real simulators. The WebDriverAgent transport has only met a stand-in HTTP server, so the README calls it unproven. A Linux box cannot close this.
- **Needs.** A macOS machine with Xcode, a booted simulator runtime, a WebDriverAgent build signed for the simulator, and a job that rebuilds it when Xcode moves. RFC 0008 already warns that the Xcode coupling breaks on OS updates and is a standing maintenance cost.
- **Risk.** High on upkeep, low on posture: it sits behind `native-device`.
- **Done.** The keystone passes on a real WebDriverAgent with the Xcode and runtime versions recorded, and the README says so. Until then the wording stays "unproven".
- **First PR.** A runbook for the manual run: install steps, the exact command, what to attach to the release notes. Docs only.

### 7. A reference deployment for containers and CI (M)

- **What.** Docs and a tested example, before any service: the `deploy/Dockerfile`, a compose file that runs `browxai serve --socket` with a mounted workspace, a CI recipe, and the live-view and operator-channel setup for a human who needs to watch or take over.
- **Why.** `deploy/Dockerfile` exists and the security best-practices page covers running in a container. Nothing yet says what one `serve --socket` server can share (one Chromium), how to run it in CI, or how a person watches and takes over. Anyone who wants many parallel browsers needs those answers before a service would help.
- **Risk.** Medium. The capability gates are policy and the container is the boundary, and the page has to say so plainly. Nothing here adds a network listener.
- **Done.** The page, the compose file, and an image build plus a headless snapshot smoke test that runs on each release.
- **First PR.** The docs page only, from what the Dockerfile and the `serve` docs already say.

### 8. Replay player panels (M)

- **What.** RFC 0007 phase 4: a documented plugin API for player panels, and one example panel. Phase 5, re-running a session to check determinism, stays out.
- **Why.** Phases 1 to 3 shipped in v0.10.1: the `.browx` archive, the offline HTML player, secret masking at capture. Phase 4 is what lets a team add its own view without forking the player.
- **Risk.** Medium. Panels run inside a self-contained HTML file opened from disk, so a panel API has to keep the no-server, no-account property and must not give a panel network access.
- **Done.** A schema, an example panel, a test that loads it in the player, and a docs section.
- **First PR.** The panel manifest schema and its docs, with no player change.

### 9. Plugin ecosystem growth (M)

- **What.** Make the first outside plugin easy to write and easy to trust: a scaffold command for an adopter's own repo, a listing in the plugins overview, and a worked example that goes from `register(api)` to a published package.
- **Why.** Four first-party plugins ship (`example`, `figma`, `tldraw`, `excalidraw`) and the runtime has trust tiers and a lockfile. No community plugin is listed.
- **Risk.** Medium. Every plugin runs in process with full Node access, which the governance page already states. Growth must not weaken tier labels or lockfile pins.
- **Done.** One plugin from outside this repo installs through `browxai plugin install`, passes `doctor`, and appears in the index with its trust tier.
- **First PR.** A "write your first plugin in ten minutes" section in the authoring guide, checked by following it on a clean machine.

### 10. An optional natural-language action layer (L)

- **What.** A tool such as `act({ goal })` that takes a sentence and runs a short loop of `find` and actions. It would be off by default, behind its own capability, and need a model the operator configures.
- **Why.** Other tools in this space accept a task as a sentence, and browxai expects the caller's agent to loop. Today no tool calls a model: `extract` is deterministic (its `llm-assisted` mode is retired) and `find` ranks by evidence.
- **Risk.** High. It sends page text to a model provider, which is a new egress path that needs secret masking, origin rules and a threat-model row. Page text is untrusted, so the loop is a prompt-injection surface. It also pulls against the bring-your-own-vision stance in the canvas docs. This is an owner decision.
- **Done.** An accepted RFC first. Then the capability, the keystone proving the gate blocks, the threat-model row, and a published cost per task.
- **First PR.** The RFC, after the owner decides yes or no.

## Not planned

- **A hosted service, proxies or fingerprint rotation.** browxai is a local server. Item 7 documents how to run it yourself. `stealth` stays a gated posture tweak, and the supported route past a bot challenge is a person signing in with `browxai chrome login`.
- **Real-device iOS or Android app lanes, and native desktop automation** (Cocoa, Win32, GTK). Devices need code signing and hardware, and a native desktop app has no CDP endpoint. Electron is in scope because it is Chromium.
- **A bundled vision or OCR model.** Canvas work stays pixels, gestures and adapter plugins. Understanding the pixels is the host agent's job.
- **SDKs in other languages.** MCP already serves any client for tools. We revisit when someone needs scripts in another language and asks.
- **Cross-engine parity.** Chromium has the full surface. The other engines run a curated subset and refuse the CDP-deep tools by name, and that stays.
- **Comparative speed or token claims.** We publish our own measured numbers (item 4) and make no claim against other tools without a method others can rerun.

## How we decide

1. Value over cost: rank by what an adopter gains per week of work, and write the evidence into the item, either a repo fact or a named gap.
2. Gate: anything that widens what an agent can reach is off by default behind a capability, with a threat-model row.
3. Keystone: behaviour is proven against real Chromium (or the real engine), including the path where the gate blocks.
4. Docs-impact: the tool reference, the threat model and the CHANGELOG change in the same PR as the behaviour.
5. Semver: the stable surface (tool names, documented shapes, `ActionResult`, the default capability set) changes only in a minor with a deprecation note. Anything behind an off-by-default capability is experimental.

## Next release

Build these three first, in this order. Items 1 and 2 cut the tool-list cost and item 4 measures it.

- **Item 1, list only the tools whose capability is on.** Smallest change with a visible effect for every default user.
- **Item 2, a lean `core` tool profile.** The larger cut, opt-in until the numbers say otherwise.
- **Item 4, measured numbers and a checked first run.** Gives items 1 and 2 a number and backs the README with something a reader can rerun.

Item 3, the shell route, starts as an RFC in the same cycle so its design is settled before any code.

See also the [tool reference](./tool-reference.md), the [threat model](./threat-model.md) and the [plugins overview](./plugins.md). Design records live in [docs/rfcs](../docs/rfcs/README.md).
