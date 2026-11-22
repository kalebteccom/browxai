# browxai roadmap

> What we plan to build next, in order, and what we do not plan to build. Written against v0.17.1 on 2026-11-16 and updated for v0.19.0 on 2026-11-22. It is a plan, and an item can move or drop when evidence changes. Dates are not promised.

## What browxai is for

browxai is an MCP server that lets an AI agent drive a web page or a native app with the same tools. The agent gets a compact page view, ranked `find` results and a structured `ActionResult` after every action. Everything past reading, navigating and acting starts off, each behind its own capability with a test that proves the gate blocks. It runs on your machine, over MCP or a typed TypeScript SDK, and works with any MCP client.

## Ranked list

Ranked by value over cost, then by fit with the capability-gated posture. Size is S (days), M (a few weeks) or L (a month or more, or needs hardware we do not have in CI).

| #   | Item                                         | Size |
| --- | -------------------------------------------- | ---- |
| 1   | List only the tools whose capability is on   | S    |
| 2   | A lean core tool profile, then lazy loading  | M    |
| 3   | A shell route for agents with shell access   | M    |
| 4   | Measured numbers and a checked first run     | S    |
| 5   | SDK calls that return the tool result        | S/M  |
| 6   | Dated evidence for every engine              | M    |
| 7   | `ios-app` against a real WebDriverAgent      | L    |
| 8   | A reference deployment for containers and CI | M    |
| 9   | Replay player panels (RFC 0007, phase 4)     | M    |
| 10  | Plugin ecosystem growth                      | M    |
| 11  | An optional natural-language action layer    | L    |

### Chromium sandbox for browsers browxai launches (owner decision pending)

This sits ahead of the security items below and has no number, because it needs a decision before it needs work.

- **Status.** Browsers browxai launches itself (managed profile, incognito, the headless shell, the installed Chrome a session opens) run with Chromium's OS sandbox off. browxai never sets `chromiumSandbox`, and Playwright adds `--no-sandbox` unless it is `true`. The README, the threat model and the containers guide now say so. A Chrome you start yourself and attach to keeps its own sandbox. `src/engine/adapters/chromium.engine.test.ts` pins the current launch options.
- **Options.**
  - (a) Keep it off and documented, as now. Containers need nothing extra.
  - (b) Add an opt-in `chromiumSandbox` config key, default off.
  - (c) Turn it on by default when the process is not root and the host supports it, with a loud fallback message when it cannot, and keep `--no-sandbox` available for containers.
- **Recommendation: (c).** Most users run browxai on a laptop as their own user, where the sandbox works, and today those sessions lose the one OS-level boundary around page content. Root and unprivileged containers are the cases where Chromium refuses to start with the sandbox on, so the fallback message and an explicit way to turn it off cover them. It changes launch behavior for every default user, so it ships as a minor with a CHANGELOG note that starts with "Behavior change", and the threat-model rows change in the same PR.
- **Why it is the owner's call.** It sets the default security posture and can stop a launch from starting on some hosts. Nothing here is decided.

### 1. List only the tools whose capability is on (S, opt-in in 0.17.0, default in 0.18.0)

- **What.** `toolList` (`BROWX_TOOL_LIST`) shipped in 0.17.0 as an opt-in. With `enabled`, `tools/list` leaves out a tool when its capability is off. A call to a hidden tool still reaches the gate and returns the refusal that names the capability to grant. The owner decided to flip the default to `enabled`, and 0.18.0 does it as a documented behavior change. `toolList: all` or `BROWX_TOOL_LIST=all` brings back the full listing.
- **Measured.** Published browxai@0.17.1, `tools/list` over stdio on a Linux CI box, from the manual workflow `.woodpecker/first-run.yml`. Tokens are characters divided by 4, an estimate.

| Capabilities        | `toolList` | Tools | Characters | Tokens (est.) |
| ------------------- | ---------- | ----- | ---------- | ------------- |
| default four        | `all`      | 209   | 270,977    | about 67,700  |
| default four        | `enabled`  | 163   | 204,761    | about 51,200  |
| 21 of 23 documented | either     | 209   | 270,977    | about 67,700  |

- **Why.** The table was measured on 0.17.1, where unset meant `all`. `enabled` lists 46 fewer tools and 24 percent fewer characters for a default user. The earlier estimate was 25 to 30 percent, so the figure is now measured. With 21 of the 23 documented capabilities on, both modes list all 209 tools. The other two capabilities need a daemon socket, which the run did not have.
- **Risk.** Low. The capability set is fixed at server start, so the listing does not change mid-session and no list-changed notice is needed. A client that pinned a tool name sees it vanish until the capability is granted, so the refusal text and the troubleshooting page must still explain it. Flipping the default changes what every default user sees in `tools/list`, so that step ships as a minor with a CHANGELOG note that starts with "Behavior change".
- **Done.** The opt-in shipped with a test of the filtered listing and an unchanged refusal for a hidden tool called by name. The default flipped in 0.18.0, with tests that the default listing leaves out `eval_js`, keeps the tools of the four default capabilities, and still refuses a hidden tool called by name.
- **Next.** Nothing for this item. Item 2 narrows the same listing further.

### 2. A lean core tool profile, then lazy loading (M, opt-in shipped in 0.18.0, lazy loading open)

- **Status.** The core profile shipped in 0.18.0 as an opt-in: `toolProfile` (`BROWX_TOOL_PROFILE`), `full` by default and `core` on request. The core set is the 24 tools of RFC 0010, frozen in `src/util/tool-profile.ts`. Plugin tools stay listed, `open_session` is not in the set, and a `tool_catalog` tool names what the listing leaves out. A tool the profile omits still answers a call by name through the same gate. A test pins the core listing under 40 percent of the full one. Measured on the published 0.19.0 by `.woodpecker/first-run.yml` (tokens are characters divided by 4, an estimate): the core listing has 25 tools, the 24 core tools (46,030 characters) plus `tool_catalog` (407), 46,473 characters in all, about 11,600 tokens. That is 22.7 percent of the default `enabled` listing (163 tools, 204,946 characters) and 17.1 percent of the full list (209 tools, 270,977 characters), with 138 fewer tools than the default. One `tool_catalog` call replies with 35,285 characters (about 8,800 tokens) naming 185 tools, about 76 percent of the core listing, so `tool_catalog` takes an optional `capability` argument that returns one group of the omitted tools. Not measured yet: whether common clients can call a name that is not listed. Lazy loading and the default flip stay open.
- **What.** A config key and an environment variable to pick the tool profile, with two values, full (today) and core. The core profile lists about 25 to 35 tools: session control, `navigate`, `snapshot`, `find`, the basic actions, `wait_for`, `screenshot`, `console_read`, `network_read`, the `verify_*` family and `batch`. A profile could add named groups, such as storage. Lazy loading, where the server announces more tools on demand, comes after, and only for clients that honour list-changed notices.
- **Why.** Item 1 trims the listing by 24 percent, measured. What remains is 163 tools and 204,946 characters (measured on 0.19.0), and the core profile lists 46,473, a further cut of about 77 percent. Agents that only need to open a page and click should not carry the schemas for HAR, heap snapshots and canvas gestures. The 0.15.0 trim already took 18 percent out of the descriptions, and in the 209-tool listing the input schemas (149,630 characters) are larger than the descriptions (109,909). The largest single tools are `open_session` (12,221 characters), `click` (4,008), `emulate_usb` (3,052), `asset_export` (3,050), `emulate_bluetooth` (3,025) and `scroll` (2,989). That figure for `open_session` matches the one RFC 0010 derived (about 12,200).
- **Measured.** RFC 0010 estimated about 45,000 characters for the core listing and about 24,000 for one full `tool_catalog` reply. The first-run workflow measured 46,473 (3 percent above the estimate) and 35,285 (47 percent above), both on the published 0.19.0. The listing the profile itself produces is pinned in the budget test below.
- **Risk.** Medium. The new config key is an additive change to the stable surface. Which tools are core is a product call. The default stays full until measurements show core loses nothing, and flipping the default is a later, announced change. A profile only narrows the listing, so it never grants a capability.
- **Done.** The core profile lists under 50,000 characters (measured: 46,473, about 11,600 tokens). A fitness test fails if the core listing grows past its budget. The tool reference documents the profile and its groups. The capability-testbed drives every core tool.
- **First PR.** The core set as a frozen constant, the config key and environment variable wired to the listing filter from item 1, the budget test, and docs. The default stays full, so nothing changes for anyone who does not opt in.

### 3. A shell route for agents with shell access (M, shipped in 0.19.0)

- **Status.** Shipped in 0.19.0, as RFC 0011 specifies. `browxai tools` lists the tools a `serve --socket` daemon runs (name, capability, one line), and `browxai call TOOL [ARGS]` runs one tool against it and prints one JSON document (`isError`, `data` or `text`, `images`, `truncated`). Exit codes 0 to 4 tell a shell what happened: 0 ok, 1 the tool failed, 2 usage, 3 daemon unreachable, 4 refused by a capability gate. Arguments come inline, from standard input or from a file, so a secret never has to be in argv. The daemon's `tools/list` now carries real one-line descriptions and each tool's capability. The `driving-browxai` skill has a section for agents with shell access, and the guide is "Drive browxai from a shell".
- **What.** Two new subcommands: one prints the tool names with one-line descriptions, the other runs one tool by name with JSON arguments against a server started with `browxai serve --socket` and prints the result. A skill file teaches the loop, so an agent with shell access pays for a short skill and no tool schemas.
- **Why.** An agent with a shell can call a command line, and a short skill file takes less context than 209 schemas. The pieces existed: the socket server, the SDK's socket connection, and the `driving-browxai` skill under `harness/`. Item 2 shrinks the MCP route and this item adds a second one.
- **Risk.** Medium. Each command is a new process, so session state lives in the `serve --socket` daemon. The socket is owner-only (`0600`) and the route goes through the same handlers, so the gates, origin rules and secret masking apply unchanged. No new network listener, and the commands never start the daemon.
- **Done.** A documented page, a skill section that uses it, and a keystone test that opens a session, snapshots and clicks through the new subcommand, plus tests that a gated tool refuses through it exactly as it does over MCP.
- **Not measured yet.** The cost of one command (a Node start and an MCP handshake), the size of a typical `snapshot`, `find` and `network_read` result against the 40,000 character default cap, and two commands on one session at the same moment. The guide says to run calls on one session one at a time until that is tested.

### 4. Measured numbers and a checked first run (S, done)

- **What.** A manual workflow, `.woodpecker/first-run.yml`, installs the published package into an empty directory, follows the getting-started page, takes a first snapshot over MCP stdio and measures `tools/list`. Run against browxai@0.17.1 on a Linux CI box.
- **Measured.**
  - `tools/list`: the table under item 1. The 209-tool listing splits into descriptions 109,909 characters and input schemas 149,630.
  - Clean install: `npm install browxai` took about 6 seconds, 110 packages and 61.5 MB in `node_modules`.
  - Browser fallback download: about 313 MB, about 680 MB on disk.
  - First snapshot: about 1.2 seconds from a cold start through MCP stdio, about 0.5 seconds for the first snapshot `init` takes.
- **Why.** The README says "token-efficient" and now the repo holds a figure for the listing cost, with the command that produced it. Anyone can rerun the workflow.
- **Risk.** Low. Tokens are characters divided by 4, an estimate, and times are from one box. No claim of being faster or cheaper than another tool goes in, because there is no like-for-like method.
- **Left out.** Snapshot size on three fixed fixture pages, a test that fails when a figure grows past a budget, and a README line that links to the figures. Item 2 adds the budget test for the core listing.

### 5. SDK calls that return the tool result (S/M, shipped in 0.18.0)

- **What.** `browxai.extract()` in the SDK returned `{ content, data }`, where `data` is the tool's own result `{ ok, data, ... }`, so a script read `result.data.data.title`. The owner decided to change every tool-calling method, in place, to resolve to the tool's own result. A script reads `result.data.title`, and a failure is `{ ok: false, failure }` at the top level. There is no client option and no second method name, so the old shape is gone and cannot be switched back on.
- **The rule.** One text item resolves to its JSON parsed (an object or an array), or to the string when it is not JSON. A result with an image or several content items (an inline `screenshot`) keeps `{ content, data? }`, so the raw MCP content stays reachable. Errors are unchanged.
- **Why.** It is the first thing a script author writes, and the doubled `data` read like a mistake.
- **Risk.** Medium. The return shape of an SDK method is part of the stable surface, so this breaks scripts that read `result.data.data` or `result.content[0].text`. It ships in 0.18.0 as a documented behavior change, with a before and after snippet and an upgrade line in the changelog.
- **Status.** Shipped in 0.18.0. The change, the README example, the SDK tests and the tool-reference section ("SDK return values") landed together, after a patch release that was cut first.

### 6. Dated evidence for every engine (M)

- **What.** A table in the tool reference with, for each of the eight engines, what ran, on which version, on what date, and how to rerun it. Then close the cheapest gaps: an Android emulator run of the `android` engine and a macOS run of `safari`.
- **Why.** The cross-engine suite runs on Chromium, Firefox and WebKit. The `android` and `safari` engines are exercised by hand, and the Electron evidence is one app on one machine.
- **Risk.** Low for the table. Medium for new runs, since emulators and macOS runners are slow and flaky. A run that cannot stay green nightly stays a documented manual run.
- **Done.** Every engine row has a date within the last release and a command. Claims in the README match the table.
- **First PR.** The table, filled from the latest testbed report, with blanks marked "not run".

### 7. `ios-app` against a real WebDriverAgent (L)

- **What.** Run the `ios-app` keystone against a real WebDriverAgent on a booted iOS Simulator and record the result.
- **Why.** The `simctl` half runs against real simulators. The WebDriverAgent transport has only met a stand-in HTTP server, so the README calls it unproven. A Linux box cannot close this.
- **Needs.** A macOS machine with Xcode, a booted simulator runtime, a WebDriverAgent build signed for the simulator, and a job that rebuilds it when Xcode moves. RFC 0008 already warns that the Xcode coupling breaks on OS updates and is a standing maintenance cost.
- **Risk.** High on upkeep, low on posture: it sits behind `native-device`.
- **Done.** The keystone passes on a real WebDriverAgent with the Xcode and runtime versions recorded, and the README says so. Until then the wording stays "unproven".
- **First PR.** A runbook for the manual run: install steps, the exact command, what to attach to the release notes. Docs only.

### 8. A reference deployment for containers and CI (M, built as a guide)

- **Status.** The guide is built: "Run browxai in a container and in CI" covers the reference image, why its tag equals the `playwright-core` version, the workspace volume, what browxai does about `--no-sandbox` and shared memory, `serve --socket` shared between containers and what the socket's `0600` mode means for user ids, a CI job in GitHub Actions and plain shell, the per-call deadline, and which capabilities to leave off. Not built: the compose file, an image build with a headless snapshot smoke test on each release, and the live-view and operator-channel setup for a person who needs to watch or take over.
- **What.** Docs and a tested example, before any service: the `deploy/Dockerfile`, a compose file that runs `browxai serve --socket` with a mounted workspace, a CI recipe, and the live-view and operator-channel setup for a human who needs to watch or take over.
- **Why.** `deploy/Dockerfile` existed and the security best-practices page covers running in a container, but nothing said what one `serve --socket` server can share (one Chromium) or how to run it in CI. The guide now says both. How a person watches and takes over is still undocumented. Anyone who wants many parallel browsers needs those answers before a service would help.
- **Risk.** Medium. The capability gates are policy and the container is the boundary, and the page has to say so plainly. Nothing here adds a network listener.
- **Done.** The page, the compose file, and an image build plus a headless snapshot smoke test that runs on each release.
- **First PR.** The docs page only, from what the Dockerfile and the `serve` docs already say.

### 9. Replay player panels (M)

- **What.** RFC 0007 phase 4: a documented plugin API for player panels, and one example panel. Phase 5, re-running a session to check determinism, stays out.
- **Why.** Phases 1 to 3 shipped in v0.10.1: the `.browx` archive, the offline HTML player, secret masking at capture. Phase 4 is what lets a team add its own view without forking the player.
- **Risk.** Medium. Panels run inside a self-contained HTML file opened from disk, so a panel API has to keep the no-server, no-account property and must not give a panel network access.
- **Done.** A schema, an example panel, a test that loads it in the player, and a docs section.
- **First PR.** The panel manifest schema and its docs, with no player change.

### 10. Plugin ecosystem growth (M)

- **What.** Make the first outside plugin easy to write and easy to trust: a scaffold command for an adopter's own repo, a listing in the plugins overview, and a worked example that goes from `register(api)` to a published package.
- **Why.** Four first-party plugins ship (`example`, `figma`, `tldraw`, `excalidraw`) and the runtime has trust tiers and a lockfile. No community plugin is listed.
- **Risk.** Medium. Every plugin runs in process with full Node access, which the governance page already states. Growth must not weaken tier labels or lockfile pins.
- **Done.** One plugin from outside this repo installs through `browxai plugin install`, passes `doctor`, and appears in the index with its trust tier.
- **First PR.** A "write your first plugin in ten minutes" section in the authoring guide, checked by following it on a clean machine.

### 11. An optional natural-language action layer (L)

- **What.** A tool such as `act({ goal })` that takes a sentence and runs a short loop of `find` and actions. It would be off by default, behind its own capability, and need a model the operator configures.
- **Why.** Other tools in this space accept a task as a sentence, and browxai expects the caller's agent to loop. Today no tool calls a model: `extract` is deterministic (its `llm-assisted` mode is retired) and `find` ranks by evidence.
- **Risk.** High. It sends page text to a model provider, which is a new egress path that needs secret masking, origin rules and a threat-model row. Page text is untrusted, so the loop is a prompt-injection surface. It also pulls against the bring-your-own-vision stance in the canvas docs. This is an owner decision.
- **Done.** An accepted RFC first. Then the capability, the keystone proving the gate blocks, the threat-model row, and a published cost per task.
- **First PR.** The RFC, after the owner decides yes or no.

## Not planned

- **A hosted service, proxies or fingerprint rotation.** browxai is a local server. Item 8 documents how to run it yourself. `stealth` stays a gated posture tweak, and the supported route past a bot challenge is a person signing in with `browxai chrome login`.
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

Items 1 to 5 are shipped, and item 8 is built as a guide with the compose file and a release smoke test still open. What comes next, in this order:

- **Item 6, dated evidence for every engine.** The table first, filled from the latest testbed report, with blanks marked "not run".
- **Item 9, replay player panels.** The panel manifest schema and its docs, with no player change.
- **Item 10, plugin ecosystem growth.** The "write your first plugin" section in the authoring guide, checked by following it on a clean machine.

Two items stay parked. Item 11, the natural-language action layer, waits for the owner's yes or no on its RFC. Item 7, the real-device iOS lane, waits for a macOS machine with Xcode and a signed WebDriverAgent build, and for the owner.

See also the [tool reference](./tool-reference.md), the [threat model](./threat-model.md) and the [plugins overview](./plugins.md). Design records live in [docs/rfcs](../docs/rfcs/README.md).
