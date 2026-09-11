# The dom_export / element_export trap

The canonical lesson capture for the bug class that page-side function discipline exists to prevent.

## The bug class

A page-side handler is implemented as a stringified arrow expression:

```ts
// WRONG
const expr = `(arg) => { return document.querySelector(arg.selector)?.outerHTML; }`;
const result = await page.evaluate(expr, { selector: "#foo" });
```

What happens at runtime:

1. `page.evaluate(expr, arg)` ships `expr` as a string to CDP.
2. CDP evaluates the string in the page. The expression evaluates to a function value, `(arg) => { ... }`.
3. CDP tries to serialize the result. Functions cannot cross the CDP boundary, so the serializer returns `undefined`.
4. The host receives `undefined`. The handler returns an empty or null result.
5. The unit test, with a mocked `page.evaluate` that calls the function directly in Node, passes. The keystone test fails.

The fix is a real function literal:

```ts
// CORRECT
const result = await page.evaluate(
  (arg: { selector: string }) => {
    return document.querySelector(arg.selector)?.outerHTML ?? null;
  },
  { selector: "#foo" },
);
```

Now `page.evaluate` serializes the function as code, ships it across CDP, the page calls it, and the **return value of the call** comes back. CDP can serialize a return value.

## Where it bit browxai

`dom_export` shipped first with a stringified expression. Adopters reported empty results, the unit tests went green, and the keystone test caught it on the second pass. `element_export` had the identical bug and took the identical fix.

## Regression gate

Every tool calling `page.evaluate` or `locator.evaluate` against real DOM has a keystone test under `test/` that exercises the real return shape. Don't loosen this gate.

## Static backstop

The repository ships an ESLint custom rule (`no-stringified-arrow-in-evaluate`) that flags stringified arrow expressions passed to `evaluate(...)`. It's a backstop; the keystone test is the source of truth.

## What the lesson leaves behind

Page-side code is a real function literal. The file starts with `/// <reference lib="dom" />` so DOM types compile. Unit tests with a mocked `evaluate` silently pass on this bug class, which is why keystone coverage is mandatory for every tool that reaches into the page.

## Related

- [`pattern.md`](pattern.md)
- [`../testing/qa-patterns.md`](../testing/qa-patterns.md)
- [`../testing/unit-vs-keystone.md`](../testing/unit-vs-keystone.md)
