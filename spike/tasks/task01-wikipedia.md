# Spike task 01 — Wikipedia (ambiguity-light)

**Goal:** end the task on the Wikipedia article for **Anthropic**, with a screenshot of its lead paragraph (the first `<p>` after the infobox).

**Setup:** no auth. Start on a blank page; the only navigation is from inside the task.

## Steps

1. Navigate to `https://en.wikipedia.org/wiki/Web_browser`.
2. Find the page's search input and type `Anthropic`.
3. Submit the search (Enter, or click the search/submit button — there are several places search appears on this layout; that's the point).
4. From the results page, click the first result link titled *Anthropic* (a company / AI lab — not a disambiguation link, not a Wikipedia internal page).
5. Once on the Anthropic article, take a screenshot. Stop.

**Done when:** the current URL contains `/wiki/Anthropic` and you've called `screenshot`.

## What the task is probing

- "Find the search input" — there are *multiple* inputs on a Wikipedia layout (top search, sidebar search depending on skin, sometimes an in-article search). This forces the agent into ambiguity-resolution: how many `find()` / `snapshot()` re-reads does it take to commit?
- "Click the first result titled Anthropic" — search-results pages list many links with overlapping text. The candidate-ranking question is whether `find("first result anthropic")` with evidence gets it in one shot vs. raw `click(selector)` against an inspected DOM.

## Stop conditions

- Hard stop after **30 tool calls** if you haven't reached the article — don't grind. The log captures the give-up.
- If a network failure / timeout occurs, retry the last action once; if it fails twice, stop.
