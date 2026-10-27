# UI and copy rules

Rules for the documentation site (`website/`), the README and the published docs. Two scripts check most of them: `node scripts/check-design-rules.mjs` and `node scripts/check-copy-rules.mjs`. `node scripts/check-layout.mjs` checks the built site in Chromium.

## Look

- Flat. Solid surfaces and 1px borders. No gradients, glow, blur, glass or accent shadows.
- One accent, violet `#7e22ce`, the same in both themes. Tokens live in `website/src/styles/brand-tokens.css`.
- No pure `#fff` or `#000` outside the token file.
- Poppins for headings, Inter for text. Mono only for code.
- No uppercase text and no positive letter spacing outside code.
- Logo, favicon and app icons keep their own art. See `brand/README.md`.

## Layout

- Padding, margin and gap use the `--space-*` tokens.
- Tap targets are at least 44px.
- Every interactive element has a visible `:focus-visible` style.
- A `:hover` rule has an `:active` twin.
- Transitions animate `transform` and `opacity` only, and respect `prefers-reduced-motion`.
- Status and helper lines reserve their space, so nothing shifts when they appear.
- No horizontal scroll at 320px, with a long unbroken string in a heading, a table cell or a button.
- Headings use `text-wrap: balance`, paragraphs `text-wrap: pretty`.
- Both themes and every shipped locale.

## Copy

- Plain words. Cut what does not change what the reader does.
- No em dashes, en dashes or spaced hyphens used as dashes.
- No "rather than", "not just", "not merely" or "isn't about".
- No maxims as headings. Name the topic.
- Public pages show only what a user sets: documented flags, env vars and tool names. No maintainer or operator detail.
- A change to published copy updates every locale that exists.

## Checks

Run the three scripts before a push that touches the site. Allowlist entries live in `scripts/check-design-rules-allow.json` and `scripts/check-layout-allow.json`. Each one has a reason and an exact count, so a stale entry fails.
