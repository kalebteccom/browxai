# UI and copy rules

Rules for the documentation site (`website/`), the README and the published docs. Two scripts check most of them: `node scripts/check-design-rules.mjs` and `node scripts/check-copy-rules.mjs`. `node scripts/check-layout.mjs` checks the built site in Chromium.

## Look

- Flat. Solid surfaces and 1px borders. No gradients, glow, blur, glass or accent shadows.
- One accent, violet `#7e22ce`, the same in both themes. Tokens live in `website/src/styles/brand-tokens.css`.
- No pure `#fff` or `#000` outside the token file.
- Poppins for headings, the system font stack for text (no Inter). Mono only for code.
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

## Design engineering checks

Fourteen rows a reviewer can verify. Cite the row id in a PR or review. The ids match the shared Kalebtec playbook, so the same id means the same check in every product. Where a script already covers a row, the Enforce column names it. Everything marked review has no script yet.

| ID  | Check                                                                                                                                                                   | Enforce                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| M1  | Each new animation has a one-word purpose (feedback, spatial, state, jarring-change, explanation) and a frequency tier in the PR. None is decoration.                   | review                                                          |
| M2  | An action opened by keyboard, or fired 100-plus times a day, plays no transition. Sampled with the keyboard path, zero running transitions.                             | review, `check-layout.mjs` transition check                     |
| M4  | No `scale(0)` start. Entrances begin at 0.95 or higher with opacity, or without scale.                                                                                  | review                                                          |
| M6  | Every stylesheet with motion has a `prefers-reduced-motion` block, a substitution and not a deletion. JS motion honours it.                                             | `check-design-rules.mjs` `layout-transition` (CSS only)         |
| M12 | With JS blocked and with reduced motion, no content is hidden or below full opacity. No server-rendered `opacity: 0`.                                                   | review                                                          |
| L3  | No visible empty hole. Every reserved slot equals the loaded size. CLS under 0.1.                                                                                       | `check-layout.mjs` stability check, review                      |
| I2  | Every drag, swipe or hold action has a tap or click path and a keyboard path.                                                                                           | review                                                          |
| I3  | While the pointer is down the element follows it 1:1 with no transition, no framework state per move, and `transform` set on the element, not on a parent CSS variable. | review                                                          |
| I4  | Release dismisses on distance or velocity. Snap-back takes 200ms or less. Resistance past the edge.                                                                     | review                                                          |
| A2  | No `div` or `span` carries a click handler without being a real control.                                                                                                | review                                                          |
| A3  | No `outline: none` without a `:focus-visible` replacement in the same rule or file. Programmatic focus on `main[tabindex="-1"]` is the one exception.                   | review                                                          |
| A4  | The viewport meta tag never sets `user-scalable=no` or `maximum-scale`.                                                                                                 | review                                                          |
| S4  | No page is mostly a repeated icon-title-text card grid. Two identical grids on one page is the limit, and each section has its own composition.                         | review                                                          |
| S7  | No banned word, stock line, template residue or virtue word about ourselves. Two-fragment and number-pair headings are capped at one.                                   | `check-copy-rules.mjs` `banned-word`, `contrast-closer`; review |

- Press feedback stays translate-only on bordered or shadowed surfaces. `scale(0.97)` is allowed only on borderless, shadowless pressables.
- Drag release may overshoot by at most 2 percent on a sheet or carousel. Zero overshoot everywhere else.
- `--ease-press` is for finger press only.
- M2 covers every keyboard-triggered surface that exists: the search dialog, the mobile nav, any menu.
- Rows M4, A3 and A4 become script rules once the guards are ported to this stack. Until then they are checked by eye and by `check-layout.mjs`. The rule ids stay the same when that happens.

### Verifying a UI change

1. Build the site and serve `website/dist`. One browser at a time.
2. Capture each touched page, plus the home page, at 390 by 844 and 1280 by 800, in light and dark, in every shipped locale. Add 320 when the change touches width-sensitive layout.
3. Wait for fonts and images, so no frame is mid-animation. Run `overflow_detect` or `node scripts/check-layout.mjs`, and read each capture against the rows the change touches.
4. For motion rows, sample at normal speed and again with reduced motion on. For gestures, drive real touch input. A mouse or trackpad run does not count as a touch test.
5. A view, width, theme, locale or tool that was not run is named as unchecked, never reported as checked.
6. Keep captures in a scratch directory outside the repo. Do not commit images.

### PR line

Every PR description carries exactly one of these lines:

```
ui-rules checked: yes, <what was checked>
ui-rules checked: n/a docs only
```

`<what was checked>` names pages, widths, themes, locales and row groups. Follow it with `unchecked: <list>` for anything the matrix above left out. Example: `ui-rules checked: yes, /getting-started/ and the home page at 390 and 1280, light and dark, overflow clean, reduced motion on, M1 to M6 and L3; unchecked: 320, touch input`. A UI or copy PR without the line is sent back.

## Checks

Run the three scripts before a push that touches the site. Allowlist entries live in `scripts/check-design-rules-allow.json` and `scripts/check-layout-allow.json`. Each one has a reason and an exact count, so a stale entry fails.
