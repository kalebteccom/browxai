---
name: tool-author
description: Adds a new MCP tool to browxai end-to-end — gate definition, capability map, handler, registry composition, threat-model row, unit + keystone coverage, docs.
model: claude-opus-4-7
tools: [Read, Edit, Write, Bash, Grep, Glob]
---

# tool-author

Adds a new MCP tool to browxai's curated surface.

## Workflow

1. **Gate definition.** Zod schema for input + output in the tool handler file (`src/page/<tool>.ts` or `src/session/<tool>.ts`).
2. **Capability map entry.** Decide default-on (`read` / `navigation` / `action` / `human`) vs. off-by-default. If new capability needed, add to `src/util/capabilities.ts`.
3. **Handler implementation.** Real TypeScript function literals for any page-side code with `/// <reference lib="dom" />`. Returns ActionResult per `src/page/actionresult.ts`.
4. **Server registry.** Add the `register()` call in `src/server.ts`. No business logic in `server.ts` — composition only.
5. **Threat-model row.** `docs/threat-model.md`.
6. **Unit test.** `src/page/<tool>.test.ts` — hermetic, mocked Playwright.
7. **Keystone test.** `test/<tool>.keystone.test.ts` — real Chromium. **Mandatory** for any tool calling `page.evaluate` / `locator.evaluate`.
8. **Capability-gate test.** Assert the gate blocks when capability unset with structured `capability-denied`, not silent no-op.
9. **`docs/tool-reference.md`** row.
10. **CHANGELOG entry** under `## Unreleased ### Added`.

## Success criteria

- All quality-gate commands exit 0 (`pnpm typecheck && pnpm test && pnpm test:keystone && pnpm lint && pnpm format:check && pnpm build`).
- The tool is exposed only when its required capabilities are granted.
- Keystone test exercises the page-side function against real Chromium.
- Docs-impact pass complete: tool-reference + threat-model + CHANGELOG.

## What NOT to do

- Do NOT inline capability checks in the handler beyond calling the shared gate.
- Do NOT stringify page-side functions — real function literals only.
- Do NOT skip the keystone test "because the unit test passes" — the dom_export class silently passes unit tests.
- Do NOT add tracker IDs (`W-X#`, `TICKET-N`, etc.) to source, comments, or commit body.

## Reference

- `docs/ai-context/tool-registration/server-tool-registry.md`
- `docs/ai-context/page-side-functions/pattern.md`
- `docs/ai-context/page-side-functions/dom-export-trap.md`
- `docs/ai-context/testing/qa-patterns.md`
