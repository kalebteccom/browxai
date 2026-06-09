# Page-side function pattern

Server-owned, fixed in-page functions only. Agent-supplied JS is gated behind `eval_js` capability and is never the default path.

## The rule

A page-side function MUST be a **real TypeScript function literal** with `/// <reference lib="dom" />` at the file head. NOT a stringified arrow expression.

```ts
/// <reference lib="dom" />

// CORRECT — real function literal. Playwright passes it to CDP as a function;
// CDP evaluates it in the page and serializes the return value back.
export function exportDom(arg: ExportDomArgs): ExportDomResult {
  const root = document.querySelector(arg.selector);
  // ... real DOM work using browser globals (Document, Element, ...) ...
  return { html: root?.outerHTML ?? null };
}

// WRONG — stringified expression. Evaluates to a function VALUE, not a
// function CALL. CDP cannot serialize a function across the boundary,
// the return becomes `undefined`. Silent failure.
const wrong = `(arg) => { /* ... */ return { html: ... }; }`;
```

## Why the discipline matters

1. **CDP can't serialize functions.** Returning a function from `page.evaluate` yields `undefined` on the host side. The bug is silent.
2. **Mocked unit tests pass.** A mocked `locator.evaluate(fn)` calls `fn` in Node — works fine. Only a real Chromium keystone test catches the failure.
3. **DOM globals must type-check.** `/// <reference lib="dom" />` at the file head pulls in `Document`, `Element`, `HTMLInputElement`, etc. Without it, every reference to a DOM type fails typecheck.

## Capability boundary

Page-side functions ship with the server. Adopters cannot inject one. The only way agent-supplied JS reaches the page is via `eval_js`, which is off by default behind the `eval` capability.

## Keystone is the regression gate

Every tool calling `page.evaluate` / `locator.evaluate` MUST have a keystone test against real Chromium. Don't loosen it. See [`dom-export-trap.md`](dom-export-trap.md) for the canonical lesson and [`../testing/qa-patterns.md`](../testing/qa-patterns.md) for the test discipline.

## ESLint backstop

The repository ships an ESLint custom rule (Phase 14a) that statically catches stringified arrow expressions passed to `evaluate(...)`. The rule is a backstop; the keystone test is the source of truth.

## Related

- [`dom-export-trap.md`](dom-export-trap.md)
- [`../tool-registration/server-tool-registry.md`](../tool-registration/server-tool-registry.md)
