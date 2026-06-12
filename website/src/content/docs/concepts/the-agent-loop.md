---
title: The agent loop
description: How navigate, snapshot, find, and act fit together, and how the ActionResult closes the loop so an agent learns the consequence of each step.
---

Most agent flows are the same four moves in a cycle: go somewhere, read the
page, locate a target, act on it. browxai is shaped around that cycle.

<div class="browx-diagram not-content">
  <div class="browx-loop" role="img" aria-label="The agent loop runs as a cycle: navigate to a URL, snapshot the page into refs, find the target, act on it, then the ActionResult feeds the next pass. The four steps repeat.">
    <svg class="browx-loop-arcs" viewBox="0 0 320 320" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <marker id="al-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--sl-color-text-accent)" />
        </marker>
        <linearGradient id="al-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="var(--browx-aurora-bright)" />
          <stop offset="1" stop-color="var(--browx-violet-600)" />
        </linearGradient>
      </defs>
      <circle class="bx-ring-glow" cx="160" cy="160" r="118" />
      <path class="bx-arc" style="stroke:url(#al-ring)" d="M196 54 A118 118 0 0 1 266 124" marker-end="url(#al-arrow)" />
      <path class="bx-arc" style="stroke:url(#al-ring)" d="M266 196 A118 118 0 0 1 196 266" marker-end="url(#al-arrow)" />
      <path class="bx-arc" style="stroke:url(#al-ring)" d="M124 266 A118 118 0 0 1 54 196" marker-end="url(#al-arrow)" />
      <path class="bx-arc" style="stroke:url(#al-ring)" d="M54 124 A118 118 0 0 1 124 54" marker-end="url(#al-arrow)" />
    </svg>
    <span class="bx-hub" aria-hidden="true">ActionResult<small>closes the loop</small></span>
    <div class="bx-step bx-step--n" aria-hidden="true"><span class="bx-step-k">navigate</span><span class="bx-step-d">go to a URL</span></div>
    <div class="bx-step bx-step--e" aria-hidden="true"><span class="bx-step-k">snapshot</span><span class="bx-step-d">read the page as refs</span></div>
    <div class="bx-step bx-step--s" aria-hidden="true"><span class="bx-step-k">find</span><span class="bx-step-d">locate a target</span></div>
    <div class="bx-step bx-step--w" aria-hidden="true"><span class="bx-step-k">act</span><span class="bx-step-d">click, fill, verify</span></div>
  </div>
</div>

## navigate

`navigate({ url })` loads a URL and returns an `ActionResult`. Like every
browser-touching tool, it accepts an optional `session` id (default
`"default"`); see [Sessions and lifecycle](/concepts/sessions-and-lifecycle/).

If an origin allow list is set, an off-allowlist navigation routes through the
confirmation hook or proceeds with a warning, depending on your config.

## snapshot

`snapshot()` reads the page as a compact accessibility tree plus a DOM-walk.
Every node carries a stable `[ref=eN]` handle that you act on later. It is not
a DOM dump: the result is scoped, paginated, and token-budgeted so it stays
small enough for a model to reason over.

```text
form "Sign in" [ref=e3]
  textbox "Email"    [ref=e4]  actionable
  textbox "Password" [ref=e5]  actionable
  button  "Continue" [ref=e6]  actionable
```

## find

When you know what you want but not its ref, `find({ query })` takes a
plain-language description and returns ranked candidates with evidence: a
`stability` flag (`high` / `medium` / `low`), an `actionable` verdict, and a
visible-rect `bbox`. It hands back ranked options with reasons, not a single
guess you have to trust blind.

```ts
const res = await find({ query: "the Continue button" });
// res.candidates[0] = {
//   ref: "e6", role: "button", name: "Continue",
//   stability: "high", selectorHint: '[data-testid="continue"]',
//   actionable: true, bbox: { x: 412, y: 318, width: 96, height: 36 },
// }
```

## act

Action tools work by `ref` (or by selector, named ref, or coordinates):
`click`, `fill`, `fill_form`, `press`, `select`, `hover`, `scroll`, and more.
Each returns an `ActionResult`.

```ts
await fill({ ref: "e4", value: "ada@example.com" });
await fill({ ref: "e5", value: "correct horse battery staple" });
await click({ ref: "e6" });
```

## The ActionResult closes the loop

The reason the loop works without constant re-snapshotting is the
`ActionResult`. Every action returns a structured summary of its consequences:

- `navigation`: whether the URL changed, and how.
- `structure`: which nodes appeared or were removed, and any new tabs.
- a post-action snapshot delta when structure changed.
- a `console` and `network` slice from the action window.
- `dialogs`, `permissionRequests`, `notifications`, and `fsPickerRequests`
  fired during the call, each independent of success.

The agent reads the result and decides the next move. It does not have to take
a fresh snapshot after every click to find out what happened.

## Verifying

For checks rather than changes, use the read tools: `text_search`, `inspect`,
the `verify_*` family (`verify_visible`, `verify_text`, `verify_value`,
`verify_count`, `verify_attribute`, `verify_predicate`), and `console_read` /
`network_read`.

For flaky or transient UI, reach for `wait_for`, `sample`, and
`act_and_sample`. The [recipes](/guides/recipes/) page has concrete patterns,
and [agent guidance](/guides/agent-guidance/) maps the common footguns to the
tool that avoids each one.

A reminder that carries through the whole surface: page text is untrusted. An
agent must not treat text inside a snapshot or a find result as instructions to
itself.
