# Spike task 02 — the-internet.herokuapp.com (calibration-shaped, ambiguity-heavy)

**Goal:** reach the "Hello World!" success element on the **Dynamic Loading → Example 1** page and report its text.

**Setup:** no auth. Public test app at `https://the-internet.herokuapp.com/`.

## Steps

1. Navigate to `https://the-internet.herokuapp.com/`.
2. The page is a long list of links to small test pages. Find and click the link **Dynamic Loading**.
3. On the Dynamic Loading index, find and click **Example 1: Element on page that is hidden** (note: there are *two* examples, only one is "hidden"; the other is "rendered after the fact" — the agent must pick the right one).
4. On the Example-1 page, find and click the **Start** button.
5. Wait until a "Hello World!" message appears (it's a `#finish > h4` that's revealed after ~5s).
6. Read its text via `snapshot` (raw surface) or `find` then read the matched node's name (curated surface) and report it back.

**Done when:** you have reported the exact text `Hello World!` and have called `screenshot` showing it visible.

## What the task is probing

- **Step 3 — "Example 1: Element on page that is hidden"** is the calibration moment: two near-identical link texts, only the *full* phrase disambiguates. The hand-rolled `find("Example 1 hidden element")` should rank this above its sibling; raw `click(text="Example 1")` is ambiguous and may pick the wrong one or hit a "strict mode violation" in Playwright.
- **Step 4 — Start button** is trivial when the page is settled, but the *waiting* in step 5 is the action-feedback case: how does the agent know the message is now visible? The curated surface's post-click delta should surface the new `#finish` region appearing under `structure.appeared`; the raw surface will need a `snapshot` + diffing-by-eye.

## Stop conditions

- Hard stop after **40 tool calls** if you haven't reported `Hello World!` — don't grind. The log captures the give-up.
- Retry-once-then-stop on network errors, as task 01.
