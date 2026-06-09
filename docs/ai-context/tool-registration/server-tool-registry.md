# Server tool registry

How `register()` works in `src/server.ts`, what shape a new tool takes, and what coverage is required before it lands.

## The registry

`src/server.ts` is registry composition. The server starts, iterates the tool list, and for each tool:

1. Resolves its capability requirement against the active `BROWX_CAPABILITIES` set.
2. If gated out, the tool is **not exposed** on the MCP surface. Calling it via raw client returns `BROWXAI_SDK_NOT_EXPOSED` before any wire dispatch.
3. If gated in, the handler is registered with its Zod input schema, output schema, and ActionResult contract.

## ActionResult shape

Every action tool returns the universal `ActionResult` shape (see `src/page/actionresult.ts`):

- `ok: boolean` — observable success / failure.
- `navigated?: { url, type }` — set if the action triggered navigation.
- `structureChanged?: boolean` — true if the DOM tree shape changed.
- `console?: ConsoleEvent[]` — console slice captured during the action.
- `network?: NetworkEvent[]` — network slice (metadata only without `network-body`).
- `probe?: ElementProbe` — post-action probe of the target element.
- `error?: { code, message }` — structured error.
- `sessionWedged?: boolean` — wedge signal; the harness should `close_session` + `open_session`.

A handler that returns a partial / non-conforming shape is an LSP violation that breaks the agent loop. Don't.

## Adding a tool

1. **Schema.** Zod schema for input + output, colocated in `src/page/<tool>.ts`.
2. **Capability.** Decide: default-on (read / navigation / action / human) or off-by-default (rest). Add to `src/util/capabilities.ts` if a new capability is required.
3. **Handler.** Implement under `src/page/<tool>.ts` (page-touching) or `src/session/` (session-scope). Real TypeScript function literals for any page-side code — see [`../page-side-functions/pattern.md`](../page-side-functions/pattern.md).
4. **Registry.** Add the `register()` call in `src/server.ts`.
5. **Threat-model row.** `docs/threat-model.md`.
6. **Unit test.** `src/page/<tool>.test.ts` — hermetic, mocked Playwright.
7. **Keystone test.** `test/<tool>.keystone.test.ts` — real Chromium. **Required** for any tool calling `page.evaluate` / `locator.evaluate`. See [`../testing/qa-patterns.md`](../testing/qa-patterns.md).
8. **Capability-gate test.** Assert the gate blocks when capability unset (returns structured `capability-denied`, not silent no-op).
9. **`docs/tool-reference.md`** row.
10. **CHANGELOG entry** under `## Unreleased ### Added`.

## Capability composition

A tool may require multiple capabilities. Composition is multiplicative — missing any required capability denies the tool. The gate composition lives in `register()`; **do not inline capability checks in the handler** beyond calling the shared gate.

## Plugin-contributed tools

Plugins register tools via `api.registerTool(...)` against the plugin runtime (see [`../plugin-runtime/lifecycle-and-namespacing.md`](../plugin-runtime/lifecycle-and-namespacing.md)). Same ActionResult shape, same capability gates, same keystone coverage expectations — namespaced under the plugin's declared namespace.

## Related

- [`../page-side-functions/pattern.md`](../page-side-functions/pattern.md)
- [`../page-side-functions/dom-export-trap.md`](../page-side-functions/dom-export-trap.md)
- [`../testing/qa-patterns.md`](../testing/qa-patterns.md)
- [`../architecture/capability-posture-map.md`](../architecture/capability-posture-map.md)
