# Page-side function pattern

Server-owned, fixed in-page functions only. Agent-supplied JS is gated behind the `eval_js` capability, never the default path.

## The rule

A page-side function MUST be a real TypeScript function literal with `/// <reference lib="dom" />` at the file head. A stringified arrow expression will not do.

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

CDP can't serialize functions. Return one from `page.evaluate` and the host side gets `undefined`, a silent failure that a mocked unit test won't catch, because a mocked `locator.evaluate(fn)` calls `fn` in Node, where it works fine. Only a real Chromium keystone test catches it.

DOM globals also have to type-check. `/// <reference lib="dom" />` at the file head pulls in `Document`, `Element`, `HTMLInputElement` and the rest of them. Without it, every reference to a DOM type fails typecheck.

## Capability boundary

Page-side functions ship with the server, and adopters cannot inject one. Agent-supplied JS reaches the page only through `eval_js`, off by default behind the `eval` capability.

## Keystone is the regression gate

Every tool calling `page.evaluate` or `locator.evaluate` MUST have a keystone test against real Chromium. Don't loosen it.

See [`dom-export-trap.md`](dom-export-trap.md) for the canonical lesson and [`../testing/qa-patterns.md`](../testing/qa-patterns.md) for the test discipline.

## ESLint backstop

An ESLint custom rule (`no-stringified-arrow-in-evaluate`) statically catches stringified arrows passed to `evaluate(...)`. The rule is a backstop; the keystone test is the source of truth.

## Related

- [`dom-export-trap.md`](dom-export-trap.md)
- [`../tool-registration/server-tool-registry.md`](../tool-registration/server-tool-registry.md)
