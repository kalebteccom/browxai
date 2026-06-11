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
2. CDP evaluates the string in the page. The expression evaluates to a **function value** — `(arg) => { ... }`.
3. CDP attempts to serialize the result. **Functions cannot cross the CDP boundary.** The serializer returns `undefined`.
4. The host receives `undefined`. The handler returns an empty / null result.
5. The unit test (with a mocked `page.evaluate` that calls the function directly in Node) passes. The keystone test fails.

The fix is a real function literal, not a string:

```ts
// CORRECT
const result = await page.evaluate(
  (arg: { selector: string }) => {
    return document.querySelector(arg.selector)?.outerHTML ?? null;
  },
  { selector: "#foo" },
);
```

Now `page.evaluate` serializes the function as code, ships it across CDP, the page calls it, and the **return value of the call** comes back — which CDP can serialize.

## Where it bit browxai

- **`dom_export`** — initial implementation passed a stringified expression. Adopters reported empty results. Unit tests passed. Keystone caught it on the second pass.
- **`element_export`** — same class. Same fix.

## Regression gate

Every tool calling `page.evaluate` / `locator.evaluate` against real DOM has a keystone test under `test/` that exercises the real return shape. Don't loosen this gate.

## Static backstop

The repository ships an ESLint custom rule (`no-stringified-arrow-in-evaluate`) that flags stringified arrow expressions passed to `evaluate(...)`. It's a backstop; the keystone test is the source of truth.

## Discipline derived from this lesson

- Page-side code is a **real function literal**, not a string.
- File starts with `/// <reference lib="dom" />` so DOM types compile.
- Unit tests with mocked `evaluate` are not sufficient coverage — they silently pass on this bug class. Keystone is mandatory.

## Related

- [`pattern.md`](pattern.md)
- [`../testing/qa-patterns.md`](../testing/qa-patterns.md)
- [`../testing/unit-vs-keystone.md`](../testing/unit-vs-keystone.md)
