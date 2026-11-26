# Server tool registry

How `register()` works in `src/server.ts`, what shape a new tool takes, and what you have to cover before it lands.

## The registry

`src/server.ts` composes the registry. The server starts, walks the tool list, and for each tool:

1. Resolves its capability requirement against the active `BROWX_CAPABILITIES` set.
2. If gated out, every call to it returns the structured `gateCheck` refusal naming the required capability. On the SDK path the client's own gate fires first, with `BROWXAI_SDK_NOT_EXPOSED`, before any wire dispatch — and a name no tool registers gets `BROWXAI_SDK_UNKNOWN_TOOL`.
3. If gated in, registers the handler with its Zod input schema, output schema, and ActionResult contract.

## ActionResult shape

Every action tool returns the universal `ActionResult` shape (see `src/page/actionresult.ts`):

- `ok: boolean`: observable success or failure.
- `navigated?: { url, type }`: set if the action triggered navigation.
- `structureChanged?: boolean`: true if the DOM tree shape changed.
- `console?: ConsoleEvent[]`: console slice captured during the action.
- `network?: NetworkEvent[]`: network slice, metadata only without `network-body`.
- `probe?: ElementProbe`: post-action probe of the target element.
- `error?: { code, message }`: structured error.
- `sessionWedged?: boolean`: wedge signal. The harness should `close_session`, then `open_session`.

A handler that returns a partial or non-conforming shape is an LSP violation that breaks the agent loop. Don't.

## Adding a tool

1. Write the Zod input and output schemas, colocated in `src/page/<tool>.ts`.
2. Pick the capability. Default-on covers read, navigation, action and human; everything else is off by default. Add to `src/util/capabilities.ts` if the tool needs a new one. The `register()` wrapper checks it before the handler runs, and holds the call in an attached session when the capability is one of `BYOB_HOLD_CAPABILITIES` (`src/tools/byob-hold.ts`). A tool under one of those that changes nothing in the browser sets `byobConfirm: false` with a one-line reason comment, and its name goes in `test/architecture/byob-hold-completeness.test.ts`. A tool under another capability whose result carries the attached browser's cookie values sets `byobConfirm: true` and is pinned in the same file (`cookies_get`, `cookies_list`, `dump_storage_state`). A handler that adds `file-io` for a workspace write calls `fileWriteGate` (`src/tools/file-write-gate.ts`). Handlers do not call `confirmByobAction`. A held tool whose handler refuses some calls from the arguments alone (`navigate` and its scheme rules) passes that check as `byobPrecheck`, so the hold returns the refusal before it asks a human.
3. Implement the handler under `src/page/<tool>.ts` for page-touching work, or `src/session/` for session scope. Page-side code is a real TypeScript function literal, so see [`../page-side-functions/pattern.md`](../page-side-functions/pattern.md) first.
4. Add the `register()` call in `src/server.ts`.
5. Add a threat-model row to `docs/threat-model.md`.
6. Write a hermetic unit test with mocked Playwright at `src/page/<tool>.test.ts`.
7. Write a keystone test at `test/<tool>.keystone.test.ts` against real Chromium. Any tool that calls `page.evaluate` or `locator.evaluate` needs one. See [`../testing/qa-patterns.md`](../testing/qa-patterns.md).
8. Assert the gate blocks when the capability is unset and hands back a structured `capability-denied`. A silent no-op fails the test.
9. Add a row to `docs/tool-reference.md`.
10. Add a CHANGELOG entry under `## Unreleased ### Added`.

## Capability composition

A tool may require several capabilities. Composition is multiplicative: miss any one of them and the tool is denied. The gate composition lives in `register()`, and handlers don't get to inline their own capability checks beyond calling the shared gate.

## What `tools/list` reports

With `toolList: "enabled"` (the default since 0.18.0), `src/util/tool-list.ts` decides per tool name using the capability declared at `register()` (the same `isToolEnabled` the call-time gate uses) and, for a plugin tool, the capability the plugin declared. With `"all"` every registered tool is listed. The filter runs in `src/transport/listing-trim.ts` on the `tools/list` response. Do not use the SDK's `RegisteredTool.disable()` for this: it also makes a call by name fail with a bare "disabled" error, and the capability refusal with its hint is what an agent needs. A tool with a new gating helper needs no change here as long as it declares its capability through `register()`.

The `toolProfile` key narrows the same listing. `createToolListing` in `src/util/tool-list.ts` applies the `toolList` mode first, then the profile: with `core`, a tool is listed when it is in the frozen `CORE_TOOLS` constant (`src/util/tool-profile.ts`), is a plugin tool, or is `tool_catalog`. A new tool is outside the core set unless someone edits that constant, and a fitness test checks every name in it against the registered tools. `tool_catalog` is registered by `src/tools/tool-catalog-tools.ts` only under `core`, after the plugin runtime, and computes its answer from the same `isListed` predicate.

## Plugin-contributed tools

Plugins register tools through `api.registerTool(...)` against the plugin runtime (see [`../plugin-runtime/lifecycle-and-namespacing.md`](../plugin-runtime/lifecycle-and-namespacing.md)). Same ActionResult shape, same capability gates, same keystone coverage, all namespaced under the plugin's declared namespace.

## Related

- [`../page-side-functions/pattern.md`](../page-side-functions/pattern.md)
- [`../page-side-functions/dom-export-trap.md`](../page-side-functions/dom-export-trap.md)
- [`../testing/qa-patterns.md`](../testing/qa-patterns.md)
- [`../architecture/capability-posture-map.md`](../architecture/capability-posture-map.md)
