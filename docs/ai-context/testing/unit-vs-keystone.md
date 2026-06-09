# Unit, plugin-integration, keystone — three test layers

browxai has three test layers. Pick the right one — picking wrong silently passes broken page-side code or fails to exercise the contract.

## Unit tests (`*.test.ts` colocated with handlers)

- Run on `pnpm test`.
- Hermetic: mocked Playwright (`page.evaluate`, `locator.evaluate`, network, console).
- **Fast, but blind to page-side bugs.** A unit test with a mocked `locator.evaluate` calls the page-side function directly in Node. That works fine even when the function is a broken stringified expression. The dom_export / element_export class silently passes here.
- Use unit tests for: input validation, output shaping, capability-gate routing, ActionResult construction, error-path branching, deadline composition.

## Plugin-integration tests (`packages/plugins/<name>/test/`)

- Run on `pnpm --filter <plugin> test` or as part of `pnpm -r test`.
- Real plugin runtime + mocked host app.
- Use plugin-integration tests for: manifest contract conformance, `register(api)` flow, capability composition with the substrate, namespace exposure.

## Keystone tests (`test/*.keystone.test.ts`)

- Run on `pnpm test:keystone`.
- Real headless Chromium. Real page navigation. Real DOM.
- **Mandatory for any tool calling `page.evaluate` / `locator.evaluate`.**
- Use keystone tests for: page-side function regression, end-to-end flow against a fixture page, ActionResult shape against real navigation / structure-change signals, capability-gate denial path (asserting `capability-denied` envelope shape).

## The decision rule

- Pure logic, no page touch → **unit**.
- Plugin runtime contract → **plugin-integration**.
- Anything that runs in the browser → **keystone**, no exceptions.

Picking unit-only for a page-side handler is how dom_export shipped broken. Don't repeat the lesson.

## Related

- [`qa-patterns.md`](qa-patterns.md)
- [`../page-side-functions/dom-export-trap.md`](../page-side-functions/dom-export-trap.md)
