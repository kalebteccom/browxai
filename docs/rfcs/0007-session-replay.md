# RFC 0007: session replay, an append-only capture log and an offline player

**Date:** 2026-09-11
**Status:** Draft. Design only, nothing built.
**Trigger:** Owner directive, relayed 2026-09-11: a session replay primitive and "a very capable and extendable player". `CHANGELOG.md` already records the gap: an rrweb-style replay primitive "is not shipped in this cycle ... tracked separately".

## What this is for

An agent does QA by driving a web app through browxai. A person then validates that work by watching the session back, the way Trace Viewer or a session-replay product works. The replay is the evidence a reviewer signs off on, attached to a pull request as a CI artifact.

That sets the bar. A reviewer has to trust the replay more than re-testing by hand. Two things follow. It has to be complete enough that nothing important happened off-camera, and it has to answer the obvious objection: the agent chose what to explore, so the reviewer needs to see which required paths were covered and which were not.

## What already exists

Most of the capture surface is built. This RFC is mostly about routing it into one clock and one file.

| Need                                     | Already in the repo                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Append-only per-session event log        | `src/util/diagnostics.ts`, JSONL under `$BROWX_WORKSPACE/diagnostics/<sessionId>/` |
| Action timeline with targets and results | `ActionResult` plus the recorder in `src/page/recording.ts`                        |
| Network metadata and bodies              | the action-window network tap, `network_read`, `network_body`                      |
| WebSocket lifecycle and frames           | `src/page/ws-buffer.ts`, already on CDP `Network.webSocket*`                       |
| Console and page errors                  | `src/page/console.ts`                                                              |
| Screenshots, video                       | `screenshot`, `screenshot_schedule`, `recordVideo`, `get_video`                    |
| Annotations                              | `record_annotate`                                                                  |
| Secret masking at egress                 | `SecretRegistry.applyMaskDeep`, `src/util/secrets.ts`                              |
| Network interception for replay          | `route`, `route_queue`                                                             |
| Determinism controls                     | `clock`, `seed_random`                                                             |
| Determinism verification                 | `flake_check`                                                                      |
| Workspace-rooted IO                      | `resolveWorkspacePath`                                                             |

The DOM stream is the one genuinely missing piece, plus the artifact format, the player, and the wiring that puts every source on one clock.

## The central decision: capture raw, derive views

A panel can only show what was captured or what can be recomputed from what was captured. If the recording stores what a 2026 panel wanted to display, a 2027 panel is stuck. So the recording is an **append-only, schema-versioned log of raw protocol events**, and every panel, including the DOM replay itself, is a derived view over it.

Concretely: store CDP `Network.*` and `Network.webSocket*` events close to the wire, `Runtime.consoleAPICalled` and `Runtime.exceptionThrown` as they arrive, page lifecycle, and DOM mutations. Redaction is the only thing that ever removes data. No panel-shaped summarisation at capture time, because that is the step that cannot be undone later.

This is the same discipline the diagnostics recorder already follows, and it is why that module is the foundation.

### Tier (a): raw log plus opt-in hooks

On top of raw protocol events, add framework hooks that are cheap and framework-agnostic at the capture layer:

- the React devtools global hook (`__REACT_DEVTOOLS_GLOBAL_HOOK__`) commit events
- Redux store action and state deltas, via the devtools extension protocol
- the Vue devtools hook

Each writes into the same log under its own event type. browxai ships no framework panel in v1. The point is that the data is there when someone writes one, and these hooks cost nothing when the framework is absent.

**Honest limit.** A hook that was not recorded produces no data, retroactively or otherwise. Tier (a) makes new panels work on old logs _for data the log already contains_. That is a real and useful guarantee, and it is not the same as "any future panel works on any old session".

### Tier (b): re-executable sessions

For data nobody thought to capture, the only answer is to run the session again with new instrumentation attached. That requires recording every non-deterministic input:

- network responses and WS frames, replayed through `route`
- JS and CSS assets, content-addressed by hash
- initial cookies and storage, via the existing `dump_storage_state` / `inject_storage_state` pair
- the clock and the random seed, via `clock` and `seed_random`
- viewport, user agent, locale, timezone
- the agent's action sequence, which the recorder already produces

**Fidelity limits, stated plainly.** Re-execution is reconstruction, not time travel.

- **Timing races.** Anything whose outcome depends on which of two in-flight responses lands first can resolve differently on replay. `clock` removes wall-clock dependence, not scheduler nondeterminism.
- **Service workers.** A SW that caches on first load behaves differently on a replay where the cache is cold or warm in a way the recording did not pin.
- **Anything the page derives from outside the recorded inputs**: `crypto.getRandomValues` beyond the seeded surface, live device APIs, WebRTC, real timers in a worker.
- **Asset drift.** Content-addressing fixes what the recording saw. A CDN that served a different bundle to a different region was never captured.

The mitigation is verification. `flake_check` already exists to run a flow repeatedly and report divergence. A re-executed session that fails `flake_check` is not trustworthy for retroactive analysis, and the player should say so.

**Cost.** Tier (b) is substantially more work than tier (a) and carries most of the storage. It should be a per-session opt-in tier.

## Artifact format

One file, `session-replay.browx`, a zip container:

```
manifest.json          schema version, session id, capture tiers, clock origin, integrity
events.jsonl.zst       the append-only log, one event per line, monotonic `t` in ms
assets/<sha256>        content-addressed bodies and assets, deduplicated
screenshots/<n>.webp   per-action frames
video.webm             optional, only when recordVideo was on
```

Content addressing matters more than it looks. A single-page app reloads the same bundle on every navigation; deduplicating by hash is the difference between a 40MB artifact and a 400MB one.

**Schema versioning.** `manifest.schemaVersion` is a single integer. Forward-compatibility rule: **a player must ignore event types and fields it does not recognise, and must never fail to open a log because of them.** That one rule is what lets a 2027 player open a 2026 log, and a 2026 player open a 2027 log with reduced fidelity. Breaking changes get a new event type.

## Privacy

Redaction runs at capture time, before anything reaches disk, and applies identically across every tier including WS frames.

- Values registered through `register_secret` never land in an artifact. The existing `applyMaskDeep` chokepoint is reused, so there is one masking implementation in the codebase.
- `input[type=password]` is masked by default, as is any element matching a configurable selector list.
- Network and WS bodies carry a redaction config for headers and payload paths, defaulting to dropping `authorization`, `cookie`, `set-cookie`.
- The artifact records **what** was redacted, not the value, so a reviewer can tell the difference between "nothing was there" and "something was removed".

The existing archive caveat applies and should be repeated in the tool description: an artifact carrying real session data is as sensitive as the session was.

## The player

A single self-contained HTML file that opens from disk with no server and no account. That constraint is what makes it usable as a CI artifact.

- Scrubbable timeline with action markers, assertion pass/fail, annotation spans, and jump-to-failure.
- Step list synced to the DOM replay: click a step, see the page before and after it.
- Network, WS, console and error panels, all synced to the playhead.
- Coverage view grouped by annotation label, which is how a reviewer answers "did it exercise the paths I care about".
- Playback speed and idle-skipping.

### The plugin API

The extension points have to exist in v1 even though no framework panel ships in v1, because retrofitting them later means changing the format.

```ts
registerPanel({
  id: "redux",
  title: "Redux",
  // Events this panel consumes. The host indexes by type, so a panel
  // over an event type the log does not contain renders an empty state
  // instead of failing to load.
  eventTypes: ["redux/action", "redux/state-diff"],
  mount(container, api) {
    api.onSeek((t) => {
      /* render state at t */
    });
    api.events("redux/action", { from, to });
    api.seekTo(t);
  },
});
```

A panel is a pure function of the event log and the playhead. It never reaches into the DOM replay's internals, which is what keeps the host free to change them. A component tree, props and state, and a store action log with state diffs are all expressible this way, which is the test the design has to pass.

## Tool surface

Prefer options on the existing recorder over a third recording concept:

- `start_recording({ replay: { tier, redaction, sizeCap } })`
- `end_recording()` writes the artifact and returns its path plus size
- `export_session_report` links the artifact
- `record_annotate` gains a label so spans can carry an acceptance-criterion id

Capability: replay capture reaches page content, network bodies and storage, so it belongs behind an off-by-default capability with a loud warning, in the same posture class as `network-body`. A `diagnostics`-style gate is the closest existing precedent.

## Size discipline

Uncapped capture on a long session produces an artifact nobody can open. Tiers, a configurable cap, and a warning on the result when the cap truncates. Truncation must be recorded in the manifest, because a silently short replay is worse than a refused one.

## Estimate

Reported separately for sequencing, and deliberately coarse at this stage.

| Phase | Scope                                                         | Rough size                   |
| ----- | ------------------------------------------------------------- | ---------------------------- |
| P1    | Event log, schema, artifact container, redaction, DOM capture | large                        |
| P2    | Player shell: timeline, step list, DOM replay                 | large                        |
| P3    | Network, WS, console panels, coverage view                    | medium                       |
| P4    | Plugin API, documented schema, an example panel               | medium                       |
| P5    | Tier (b) re-execution, determinism verification               | large, and the least certain |

P1 through P4 deliver the reviewer workflow the brief describes. P5 is what makes retroactive devtools real, and it is the phase most likely to surface unpleasant truths about fidelity. Sequencing P5 last means the fidelity limits are discovered against a working player.

## Open questions

## Settled: rrweb for the DOM stream, wrapped in our envelope

The DOM stream uses **rrweb** (2.1.4, MIT, on the npm registry so it satisfies the lockfile guard). Incremental mutation serialisation with shadow DOM, iframes, canvas and adopted stylesheets is the hardest part of this project and it is solved work.

It does **not** become the artifact format. An rrweb event is carried as the payload of one browxai event type:

```jsonc
{ "t": 1432, "type": "dom/rrweb", "v": 1, "payload": {/* rrweb event, verbatim */} }
```

So the envelope, the clock, the schema version and the forward-compatibility rule stay ours, every other source sits in the same log on the same clock, and the DOM recorder is swappable later without changing the format or breaking old logs. A player reads our envelope and hands `payload` to whatever replays it.

One implementation note: rrweb's recorder is a bundle injected via `addInitScript`, not a browxai page-side function literal. The `dom_export` trap does not apply, but the bundle must be injected before any page script runs or the initial full snapshot is wrong.

- Multi-tab and cross-origin iframes: the session pool from RFC 0005 gives per-tab identity, but a replay spanning tabs also needs a presentation decision.
- Playwright `trace.zip` interop is cheap to emit alongside and worth doing, but it is a second-class path and should not shape the primary format.
