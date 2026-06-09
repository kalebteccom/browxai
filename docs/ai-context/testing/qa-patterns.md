# QA patterns

Read this before writing or reviewing tests, fixtures, mocks, or capability-gate coverage.

## Testing philosophy

Follow the Testing Trophy. For browxai, the trophy's biggest layer is **keystone**, because page-side regressions only surface against real Chromium. Unit tests support — they catch input-validation / output-shaping / capability-routing regressions. Plugin-integration tests cover the workspace plugin contract.

| Layer | What it catches | What it can't |
|---|---|---|
| Static (TypeScript, ESLint, Prettier) | Type errors, lint violations, stringified-arrow-to-evaluate (ESLint rule). | Behavior. |
| Unit | Input validation, output shaping, capability-gate routing, error paths. | Page-side function correctness. |
| Plugin-integration | Plugin manifest contract, `register(api)` flow, namespace exposure. | Real-page behavior. |
| Keystone | Real-Chromium DOM + navigation + ActionResult + capability-denial envelopes. | (Authoritative — the floor under which a tool ships.) |

Core principle: "The more your tests resemble the way browxai is used, the more confidence they can give you." The way browxai is used is: an agent drives a real Chromium. Keystone is closest to that.

## When to mock vs. use real

**Mock:**

- External network endpoints (use route_intercept or HAR fixtures).
- The wall clock (use the deterministic clock surface).
- Non-deterministic ops (PRNG).

**Use real:**

- Real Chromium for keystone.
- Real capability gate in plugin-integration tests.
- Real tool registry.
- Real `resolveWorkspacePath` against a temp `BROWX_WORKSPACE`.

Rule of thumb: if it's substrate code and it's fast, use the real thing. If it's external or slow or non-deterministic, mock it.

## Avoid testing implementation details

**Implementation details** = things adopters of browxai won't see, use, or know about.

**Do NOT test:**

- That handler A internally calls handler B.
- That a handler hits a specific Playwright method.
- That the capability gate's internal map has a particular shape.

**Do test:**

- That a tool returns the correct ActionResult for a given input.
- That an off-by-default capability returns `capability-denied` when not granted.
- That a navigation tool's `navigated` field matches the URL the page actually went to.
- That `network_body` returns the body bytes when `network-body` is granted, and metadata only when not.

Litmus test: "If I refactored the internals without changing the tool's MCP contract, would this assertion break?" If yes, it's testing implementation details.

## Capturing-mock pattern (required)

When you must verify a side effect that has no observable return value (an event captured, a network intercept fired), capture the value in the mock implementation, then assert on the captured value — not on `mock.calls`:

```ts
// Bad
expect(mockInterceptHandler).toHaveBeenCalledWith({ url: "...", body: "..." });

// Preferred — capture in mock, assert on captured value
let captured: InterceptedRequest[] = [];
const interceptHandler = vi.fn((req) => { captured.push(req); });
// ... drive the tool ...
expect(captured.length).toBe(1);
expect(captured[0]).toMatchObject({ url: expectedUrl, method: "POST" });

// Better — assert observable end state directly
expect(actionResult.network).toContainEqual(expect.objectContaining({ url: expectedUrl, status: 200 }));
```

Treat any new test that asserts on `.mock.calls` as guilty until proven innocent.

## Inverted-assertion trap

For negative cases ("should NOT raise `sessionWedged`", "should NOT include response body when `network-body` ungated"), verify the assertion direction matches the spec's intent. An accidentally-positive assertion silently masks the regression the test exists to catch.

```ts
// If the spec says "no body without network-body capability":
expect(actionResult.network?.[0]?.body).toBeUndefined();  // correct direction
expect(actionResult.network?.[0]?.body).toBeDefined();    // wrong direction — masks the bug
```

## Don't import production constants into assertions

Importing production constants into test assertions hides what's being tested and silently passes when the constant changes:

```ts
// Bad
import { CAPABILITY_DENIED_CODE } from "../util/capabilities";
expect(result.error.code).toBe(CAPABILITY_DENIED_CODE);

// Good — clear expectation, breaks if the wire-visible value changes
expect(result.error.code).toBe("capability-denied");
```

**Exception:** import constants for **inputs** (test data, fixture keys), not assertions.

## Fixture readability

- Durable constants and reusable fixture builders near the top of the test file.
- One-off scenario values inline.
- Named after the domain contract (`EXPECTED_DOM_EXPORT_SHAPE`, `DEFAULT_SNAPSHOT_REF_RANGE`) — not incidental setup (`fixture1`, `mockData`).
- Avoid giant inline objects in assertions; assign them to named expected constants when the shape is part of the contract.

```ts
const EXPECTED_CAPABILITY_DENIED = { ok: false, error: { code: "capability-denied" } };

it("returns capability-denied without eval", () => {
  expect(result).toMatchObject(EXPECTED_CAPABILITY_DENIED);
});
```

## AHA testing — avoid hasty abstractions

Balance between no abstraction (duplication) and over-abstraction (conditional logic in helpers).

- **3+ tests with identical setup** justifies a builder.
- Builders are **transparent** factory functions with an `overrides` parameter — no conditional logic.
- Inline setup for one-off cases.

```ts
// Good — transparent builder
export function buildBrowxaiForKeystone(overrides: Partial<BrowxaiOptions> = {}) {
  return createBrowxai({
    capabilities: ["read", "navigation", "action", "human"],
    headless: true,
    ...overrides,
  });
}

const browxai = await buildBrowxaiForKeystone({ capabilities: ["read", "navigation", "action", "human", "eval"] });
```

Avoid: factories with `if/else` on a `kind` parameter; >2 levels of `describe` nesting; shared `beforeEach` state that obscures what each test needs.

## browxai-specific rule — page-side functions require keystone

**Any new tool calling `page.evaluate` / `locator.evaluate` MUST have a keystone test against real Chromium.**

Unit tests with a mocked `locator.evaluate` silently pass when the page-side code is broken — the dom_export / element_export bug class. See [`../page-side-functions/dom-export-trap.md`](../page-side-functions/dom-export-trap.md).

This is not negotiable. A PR adding a page-side tool without a keystone test is incomplete, regardless of unit-test coverage.

## Capability-gate test discipline

Every off-by-default capability gets a keystone test asserting:

1. The gated tool is **not exposed** on the MCP surface when the capability is not granted.
2. Calling the tool via raw client returns a structured `capability-denied` error (not a silent no-op, not an undefined return).
3. When the capability is granted, the tool's success path returns the expected ActionResult shape.

For tools requiring multiple capabilities (e.g. `poll_eval` needs `eval` + `diagnostics`), test the matrix: each capability missing alone, both missing, both present.

## Acceptance criteria

Good acceptance criteria for a browxai feature:

- Specific and independently verifiable.
- Affirmative ("returns ActionResult with `navigated.url` matching the requested URL when navigation succeeds") not "doesn't crash."
- One requirement per bullet.
- Observable: ActionResult shape, capability-denial shape, recorder artifact shape, DOM state after action.
- Edge cases: empty input, invalid selector, ungated capability, session wedge, anti-wedge deadline expiry, secrets-masking pass-through.

## Heap / runtime-presence anti-pattern

Asserting heap counts of an interface-typed value is meaningless — interfaces compile to no runtime artifact. If the assertion needs a runtime presence, verify the asserted type has it (class, constructor, Map/Set) before approving.

## Test verification protocol

When writing or reviewing tests, verify the test is actually working. **All verification by hand** — do not install or run external testing tools.

**False positive check** (manual, inline):

- Temporarily change an expected value to a wrong value; the test must fail.
- If it still passes, the assertion isn't reaching the code under test (a mock is short-circuiting the real logic).
- Revert after confirming. Do this for 2–3 key assertions per file.

**Static checks:**

- `pnpm lint` clean on modified test files.
- `pnpm typecheck` clean.
- No `as any` or `@ts-ignore` in test code — fix the root cause.

## Related

- [`unit-vs-keystone.md`](unit-vs-keystone.md)
- [`../page-side-functions/dom-export-trap.md`](../page-side-functions/dom-export-trap.md)
- [`../agent-process/code-quality.md`](../agent-process/code-quality.md)
- [`../tool-registration/server-tool-registry.md`](../tool-registration/server-tool-registry.md)
