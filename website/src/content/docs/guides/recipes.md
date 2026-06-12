---
title: Recipes
description: "Concrete patterns for common agent flows: logging in, extracting data, handling flaky UI, running sessions in parallel, and testing a mobile breakpoint."
---

These are small, real patterns built from the documented tool surface. Each
one assumes browxai is already wired into your MCP client; see
[Getting started](/getting-started/) if not.

## Log in once, resume later

Use a `persistent` session so the cookie jar survives across runs.

```ts
await open_session({ session: "work", mode: "persistent", profile: "acme" });
await navigate({ session: "work", url: "https://app.example.com/login" });

const email = await find({ session: "work", query: "the email field" });
await fill({ session: "work", ref: email.candidates[0].ref, value: "ada@example.com" });

const pw = await find({ session: "work", query: "the password field" });
await fill({ session: "work", ref: pw.candidates[0].ref, value: process.env.APP_PASSWORD });

const signIn = await find({ session: "work", query: "the sign in button" });
await click({ session: "work", ref: signIn.candidates[0].ref });
```

The next run with the same `profile` starts already logged in. For state that
must survive an MCP-server restart, attach to a Chrome you launched yourself;
see [Sessions and lifecycle](/concepts/sessions-and-lifecycle/).

## Fill and submit a form in one call

`fill_form` sets several fields and optionally clicks a submit target, which is
fewer round trips than one `fill` per field. Each field targets a `ref`,
`selector`, or `named` ref. Resolution is atomic: if any target misses, nothing
is typed and the result names the missing field.

```ts
await fill_form({
  fields: [
    { selector: '[data-testid="first-name"]', value: "Ada" },
    { selector: '[data-testid="last-name"]', value: "Lovelace" },
    { selector: '[data-testid="email"]', value: "ada@example.com" },
  ],
  submit: { selector: '[data-testid="save"]' },
});
```

## Extract structured data

For reading rather than acting, `text_search`, `inspect`, and `extract` keep
the result scoped instead of dumping the page. `extract` is schema-driven: each
property name doubles as the query, and arrays take a `collection` selector for
the repeated container.

```ts
await navigate({ url: "https://example.com/pricing" });
const res = await extract({
  schema: {
    type: "object",
    properties: {
      plans: {
        type: "array",
        "x-browx-source": { collection: ".plan-card" },
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "number" },
          },
        },
      },
    },
  },
});
// res.data = { plans: [{ name: "Starter", price: 9 }, ...] }
// res.evidence.partialMisses names anything the schema asked for but missed.
```

Pair it with the `verify_*` family when you want an assertion rather than a
value, for example `verify_text` or `verify_count`.

## Handle flaky or transient UI

Do not sleep and hope. browxai has tools for waiting on a condition and for
sampling an unstable surface.

```ts
// Wait for a specific thing to exist, with a real deadline.
await wait_for({ text: "Payment confirmed", timeoutMs: 15000 });

// Act and trace a metric across the transition, in one call.
const res = await act_and_sample({
  action: { tool: "click", args: { ref: "e12" } },
  metric: "scrollHeight",
  durationMs: 2000,
});
// res.action is the click's ActionResult; res.sample.summary shows
// whether (and when) the metric moved during the window.
```

`wait_for`'s `timeoutMs` is both its maximum wait and its deadline. If a
session keeps timing out, the fix is to discard it (`close_session` then
`open_session`), not to keep raising the timeout.

## Run flows in parallel

Give each agent or each flow its own `session` id. Different ids are isolated
browser contexts, so they cannot stomp each other, even logged in as different
users of the same app.

```ts
await open_session({ session: "agentA-checkout", mode: "incognito" });
await open_session({ session: "agentB-checkout", mode: "incognito" });
// drive both independently by session id ...

// reap one agent's sessions when it is done
await close_sessions({ prefix: "agentA-" });
```

## Test a mobile breakpoint

```ts
await open_session({ session: "mobile", device: "iPhone 14" });
await navigate({ session: "mobile", url: "https://example.com" });

// resize mid-session to check a breakpoint; the result shows what re-rendered
await set_viewport({ session: "mobile", width: 768, height: 1024 });
```

For the full set of tools and their exact inputs and outputs, see the
[tool reference](/reference/tool-reference/).
