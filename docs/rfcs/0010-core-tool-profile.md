# RFC 0010: A core tool profile

**Date:** 2026-11-16
**Status:** Accepted, built opt-in. The maintainer approved the 24-tool core set without `open_session`, the default staying `full`, and plugin tools staying listed. The discovery tool is `tool_catalog`, as proposed below.
**Trigger:** The roadmap entry for a lean core tool profile. The `toolList` setting shipped in 0.17.0 and cut the listing by what the server cannot run. This RFC is about cutting what a client is unlikely to need.

## What this is for

An agent that opens a page, reads it, clicks and fills a form uses about two dozen of browxai's tools. Every MCP client that connects pays for all 209 of them in `tools/list`, whether or not the agent ever calls them. A core profile is a named subset of the tools, listed by default only when a client or a config asks for it, so that agent pays for the two dozen.

The profile changes what the server lists. It does not change what the server can run, and it never grants a capability.

## The problem, measured

Figures from the CHANGELOG and the docs, then my own estimates, which are marked as such.

- `tools/list` holds 209 tools, 269,340 characters, about 67,000 tokens (CHANGELOG, "`tools/list` is about 18 percent smaller"). That is 0.249 tokens per character, and I use that ratio for every token figure below.
- Before that trim the listing was 328,777 characters (about 82,000 tokens). The shared `session`, `timeoutMs`, `mode`, `contextRef`, `ref` and `coords` descriptions were already shortened, so the remaining lever is the number of tools.
- `toolList` set to `enabled` leaves out each tool whose capability is off (tool reference, `toolList` section). Under the four default capabilities that is the default-off tools. No exact figure is published. My count of the registration source puts the default-capability tools at about 76 percent of the measured text (145 of the 188 tools I could read), so I estimate an `enabled` listing at 200,000 to 215,000 characters, or 50,000 to 53,000 tokens. The first implementation PR should replace that with a measured number.
- One tool is a large share by itself. `open_session` is about 11,640 characters of source, 4.3 percent of the whole listing, because it carries the mode, engine, profile and policy options.

So a default user pays about 67,000 tokens, an `enabled` user about 51,000, and an agent that needs a dozen tools still carries the other hundred and ninety-odd.

## How I measured the candidate

No server was started and nothing was built. A small script read each registration under `src/tools/` and counted the characters of its description and input schema, plus the shared fragments it spreads in (`SESSION_ARG`, `TIMEOUT_ARG`, `ACTION_OPTS`, `REF_OR_SELECTOR` in `src/tools/schemas.ts`, which add 138, 414, 846 and 1,712 characters once nested spreads are resolved). Whitespace was collapsed.

The script found 188 of the 209 registrations. The other 21 register inside loops (the `mouse_*`, `touch_*`, `localstorage_*`, `sessionstorage_*`, `emulate_*` and `profile_*` tools), and none of them is a core candidate. The 188 measured tools sum to 232,135 source characters. I filled the 21 at the measured average of 1,235 each, which gives 258,065. The real listing is 269,340, so source characters undercount the wire size by 4.4 percent (the JSON structure around each field). I scaled every figure below by 1.044.

This is an estimate. The ratio assumes the JSON overhead and the 21 unmeasured tools spread evenly, and neither is checked. It is good enough to rank options and to see whether a set lands near a budget. It is not a budget.

## The candidate core set

Twenty-four tools, all in the four default capabilities (`read`, `navigation`, `action`, `human`) or in session control, so none of them needs a capability change to be useful.

| Group    | Tools                                                                                                                                                             | Source chars |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Navigate | `navigate` (1,432), `go_back` (1,086)                                                                                                                             | 2,518        |
| Observe  | `snapshot` (2,710), `find` (2,544), `text_search` (1,318), `inspect` (1,908), `extract` (2,453), `screenshot` (3,026), `console_read` (622), `network_read` (694) | 15,275       |
| Act      | `click` (3,893), `fill` (2,364), `fill_form` (1,902), `select` (2,150), `hover` (2,024), `press` (2,150), `scroll` (2,903), `wait_for` (2,672)                    | 20,058       |
| Verify   | `verify_text` (691), `verify_visible` (514), `verify_count` (884)                                                                                                 | 2,089        |
| Session  | `close_session` (642), `list_sessions` (259)                                                                                                                      | 901          |
| Compose  | `batch` (1,800)                                                                                                                                                   | 1,800        |
| Total    | 24 tools                                                                                                                                                          | 42,641       |

Why these. The loop an agent runs is observe, locate, act, verify, and each step has a tool here. `snapshot`, `find` and `text_search` read and locate. `click`, `fill`, `fill_form`, `select`, `hover`, `press` and `scroll` are the actions a page needs. `wait_for` bounds a wait. `console_read` and `network_read` are how an agent finds out why an action did nothing. `screenshot` is the one tool that returns pixels. The three `verify_*` tools turn an assertion into a single cheap call. `batch` reaches the 73 tools marked batchable in one round trip, so an agent in core still runs a sequence without a listed schema for each step. `inspect` and `extract` read an element or structured data without needing `eval_js`.

Why not the rest. `open_session` is the biggest single choice and it is covered below. The other tools in the default capabilities are either rarer (`double_click`, `shortcut`, `choose_option`, `go_forward`, `set_viewport`, the other three `verify_*`, the `act_and_*` family) or a different job (storage, cookies, routes, recording, perf). Each of those is one explicit request away.

### The arithmetic

- 42,641 source characters for the 24 tools.
- Plus a discovery tool (next section). I estimate 900 characters for it, between the 515 of `get_config` and what a name filter and a detail flag add. That is a guess.
- 43,541 characters, times 1.044, is about 45,400 characters, or about 11,300 tokens.
- That is 17 percent of today's 269,340 and about 22 percent of the `enabled` estimate.

### Whether `open_session` is core

The request for this RFC listed session open and close. With `open_session` the set is 25 tools and about 57,600 characters (14,300 tokens), which is above the roadmap's target of under 50,000 characters. Without it the set is about 45,400.

I left it out of the candidate. Its own description says that any tool with a `session` argument creates that id on first use, so an agent that wants a second isolated session passes a different id and gets one. `open_session` is for the options: `mode`, `engine`, `profile` and the policies. An agent that needs those is already off the common path and can ask for the full profile. This is the first thing the maintainer might overrule, and the cost of overruling it is about 12,200 characters.

## How it composes with `toolList`

`toolList` and the profile are two filters on one question, "does `tools/list` report this tool". The server already answers it in one place: `isToolListed` in `src/server.ts`, which the stdio listing trim and the `serve --socket` list handler both call. The profile joins that predicate. A tool is listed when it passes the `toolList` mode first, then is in the active profile.

- `toolList` set to `all` with the core profile lists the core tools, including any whose capability is off. A call to one of those still returns the capability refusal.
- `toolList` set to `enabled` with the core profile lists the core tools whose capability is on. With the default capabilities that is all 24.
- The full profile changes nothing. It is today's behaviour.

The profile is read once at server start, like capabilities and `toolList`, so the listing does not change while the server runs and no `tools/list_changed` notice is sent. A profile only removes tools from the listing. A tool outside the profile still answers a call by name, with the same handler and the same gate it has today.

## Reaching the full set

Nothing may become undiscoverable, so the core profile ships with two ways to reach the rest.

1. **A config or environment setting picks the full profile.** The operator of a client sets it in that client's MCP entry, so one machine can carry a lean entry for everyday work and a full entry for a heavy session. A client's `initialize` call carries its name, and the server could pick a profile from it. I propose against that. The same server would list different tools to different clients with no setting anyone can read.
2. **A discovery tool lists everything outside the active listing.** It takes an optional name filter and an optional detail flag. By default it returns each tool's name, one-line description and the capability it needs, and whether that capability is on. With the detail flag set and one name, it returns that tool's full description and input schema. The one-line descriptions come from the first sentence of each description, which averages about 101 characters, so a call that lists all 185 tools outside the core costs about 24,000 characters (6,000 tokens) with the name and capability on each row, paid only when an agent asks. The discovery tool is listed in the core profile only. In the full profile every tool is already listed.

A client whose model can only call tools that appeared in `tools/list` cannot use a name the discovery tool shows it. I could not verify which clients behave that way. For those the discovery tool says which setting to change and that a restart is needed, which is the same instruction the capability refusal gives today. `batch` helps for the 73 batchable tools. A generic call-by-name tool would close the gap for the rest, and I leave it out because it is a second way to reach a gated tool that needs its own threat-model row. See the open questions.

## Failure modes

- **The agent cannot find a tool it needs.** The likeliest cases are `set_viewport`, `go_forward`, `double_click`, `choose_option`, `upload_file` and the storage tools. Mitigations: the discovery tool's description says in its first sentence that more tools exist and how to list them. The `driving-browxai` skill gets one paragraph on it. The refusal text for a missing capability is unchanged.
- **The agent calls a tool that is outside the listing, and the client refuses to send it.** Covered above. The error the agent sees comes from the client, not from browxai, so browxai cannot make that message better. The skill paragraph has to cover it.
- **The agent loops on the discovery tool.** Each reply names the setting to change, so a second call does not give new information. A test pins that the reply names the setting.
- **A tool is core in the constant and gone in the source.** A fitness test compares the frozen core list against the registered tool names and fails on a name that does not exist.
- **The core set grows by drift.** A budget test pins the listing size of the core profile, and a change to the constant needs an edit to that test.
- **Plugin tools.** A plugin the operator installed and enabled on purpose should not disappear because the profile is core. I propose plugin tools stay listed under every profile, and the profile applies to core tools only. This is a decision for the maintainer.
- **A saved config and the environment disagree.** Same behaviour as `toolList`: a saved value overrides the environment variable, `get_config` with the resolved scope reports the live value, and a pending-restart flag shows when the saved one differs.

## Compatibility and semver

- The default stays `full`, so `tools/list` is byte for byte what it is today for anyone who sets nothing.
- The new config key, its environment variable and the discovery tool are additive. The stable surface covers tool names, documented shapes and documented config keys, so this is a minor release with a CHANGELOG entry and a tool reference row. The discovery tool is new and appears only under the core profile, so no default user sees a new name.
- A profile does not touch the default capability set, `ActionResult`, any tool's input or output shape, or the refusal text.
- Flipping the default to `core` would change what every default user sees in `tools/list`, and a pinned tool name would vanish from their client. Under the repository's semver rule that needs a minor release, a CHANGELOG entry and a deprecation note, so it would be announced one release ahead and would not ship together with the opt-in.
- Anything that reads a retired value follows the existing `RETIRED_*` pattern. Nothing in this RFC retires a value.
- `browxai doctor` gets a row for the profile next to the `tool-list` row.

## Alternatives considered

- **Do nothing after `toolList`.** About 51,000 tokens remain for a default user. The cut from `enabled` is 24 percent and the cut from core is about 83 percent. Rejected, because the large win is in the number of tools.
- **Capability groups as profiles** (a storage group, a network group, a recording group) that an operator adds to core. Good for the second step, and it needs a stable grouping of 209 tools that nobody has agreed on. I would add groups after a release of core, driven by which tools people ask for.
- **Lazy loading with `tools/list_changed`.** The server starts with core and announces more tools on demand. It serves clients that honour the notice and does nothing for those that do not. The roadmap puts it after this profile, and I keep it there.
- **A smaller default and no profile name.** Remove tools from the default listing outright. Breaks the frozen surface for everyone, and gives nobody a way back. Rejected.
- **Shorten the descriptions further.** The trim already took 18 percent. `open_session` shows what is left: 11,640 characters of options that the schema needs. A second trim is worth doing and is independent of this RFC.
- **A profile chosen per call on `open_session`.** The listing is read once for the whole server, so a per-session setting has nothing to apply to.

## The decision needed

The maintainer has three decisions, and I give a recommended answer to each.

1. **Which tools are core.** Recommended: the 24 above, without `open_session`, plus the discovery tool. About 45,400 characters, about 11,300 tokens, under the roadmap target of 50,000. Variants to consider: add `open_session` (57,600), add the other three `verify_*` tools (about 2,500 more), drop `inspect` and `extract` (about 4,600 fewer).
2. **Whether the default flips.** Recommended: no. Ship the profile opt-in with the default `full`. Revisit once the measured-numbers page exists and the profile has been out for a release. If it flips, it is a separate minor release with the notice described above.
3. **Whether plugin tools stay listed under the core profile.** Recommended: yes, they stay listed.

## Honest limits

- The 45,400 figure is derived from source text and a single scale factor. The implementation PR should measure the listing itself, state both numbers, and pin the real one in the budget test.
- I did not check which MCP clients let a model call a tool that was not in `tools/list`. That decides how useful the discovery tool is on its own. A short test against two or three common clients before the release would answer it.
- Token counts use the repository's own ratio (about 0.249 tokens per character). Another tokenizer will give a different figure.
- A smaller listing saves context. It does not make a call faster, and it does not reduce what the agent can do on a full-profile server.
- No claim here compares browxai with another tool.

## Open questions

- Does a generic call-by-name tool belong in core, so that a client which can only send listed names still reaches the 136 tools `batch` cannot? If yes it needs a threat-model row and a keystone test that it applies the same capability gate and the same batch inner-name check as a direct call.
- Should the discovery tool also be available under the full profile, so one skill paragraph works everywhere? It would add about 900 characters to the listing everyone has today.
- Should an environment variable accept a list of tool names for a custom profile? It is more flexible and gives up the frozen, tested set that makes the budget test possible.
- Should the profile apply to the SDK's socket and in-process transports? The socket list handler already calls `isToolListed`, so it follows by default. The in-process transport has no `tools/list` of its own.

## Proposed names

The build uses these names.

```text
Config key:            toolProfile, values full (default) and core
Environment variable:  BROWX_TOOL_PROFILE
Discovery tool:        tool_catalog
```

## References

- [Roadmap](../roadmap.md): the core profile entry and the target of under 50,000 characters.
- [Tool reference](../tool-reference.md): the `toolList` section and the stability and semver policy.
- CHANGELOG, 0.17.0 (`toolList`) and the `tools/list` size trim.
- `src/util/tool-list.ts`, `src/transport/listing-trim.ts` and `src/server.ts`: where the listing predicate lives.
- [RFC 0011](0011-shell-route.md): the second route for agents with a shell, which sidesteps the listing.
