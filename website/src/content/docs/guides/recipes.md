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
await fill({ session: "work", ref: email[0].ref, value: "ada@example.com" });

const pw = await find({ session: "work", query: "the password field" });
await fill({ session: "work", ref: pw[0].ref, value: process.env.APP_PASSWORD });

await click({
  session: "work",
  ref: (await find({ session: "work", query: "the sign in button" }))[0].ref,
});
```

The next run with the same `profile` starts already logged in. For state that
must survive an MCP-server restart, attach to a Chrome you launched yourself;
see [Sessions and lifecycle](/concepts/sessions-and-lifecycle/).

## Fill and submit a form in one call

`fill_form` sets several fields and optionally submits, which is fewer round
trips than one `fill` per field.

```ts
await fill_form({
  fields: [
    { query: "first name", value: "Ada" },
    { query: "last name", value: "Lovelace" },
    { query: "email", value: "ada@example.com" },
  ],
  submit: true,
});
```

## Extract structured data

For reading rather than acting, `text_search`, `inspect`, and `extract` keep
the result scoped instead of dumping the page.

```ts
await navigate({ url: "https://example.com/pricing" });
const plans = await extract({ query: "each plan name and its monthly price" });
```

Pair it with the `verify_*` family when you want an assertion rather than a
value, for example `verify_text` or `verify_count`.

## Handle flaky or transient UI

Do not sleep and hope. browxai has tools for waiting on a condition and for
sampling an unstable surface.

```ts
// Wait for a specific thing to exist, with a real deadline.
await wait_for({ text: "Payment confirmed", timeoutMs: 15000 });

// Act, then sample the result a few times to see if it settled.
await act_and_sample({ action: { tool: "click", args: { ref: "e12" } } });
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
