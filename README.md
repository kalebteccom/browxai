# browxai

> **PRIVATE** for now. MIT-licensed and built OSS-clean, but the repo is not public yet —
> public release is a gated decision (see the roadmap's Phase 3 trigger). Do not share.

An **MCP-native, model-agnostic, agentic-first** browser-control server for AI agents —
Playwright/CDP under the hood, with a curated, token-efficient surface aiming for
Anthropic Claude-in-Chrome-grade usefulness without being Claude-locked, and headless/CI-capable.

Deliberately **not** a wrapper over Microsoft's `@playwright/mcp` — browxai owns its own
Playwright/CDP transport so it can own the BYOB / persistent-profile / CDP-attach /
authenticated-session lifecycle and shape an agent-first surface MS's dev-first design won't give.

Code-name during incubation: `agent-browser-bridge` (the portfolio-folder slug).

## The surface (Phase 1 target)

- **`snapshot()`** — accessibility tree + key interactive elements with stable selectors; compact, token-efficient (scoped/paginated/prioritised, not a DOM dump).
- **`find(query)`** — natural-language element description → ranked candidate locators with evidence (role/text/test-id/bounding box/screenshot crop/position).
- **action primitives** (`click` / `fill` / `navigate` / …) — return a structured `ActionResult`: a scoped accessibility re-snapshot of what changed (a `MutationObserver` is the change-detector only), plus always-on `navigation` (from/to/kind), `structure` (appeared/removed/new tabs), `console.errors` + `pageErrors`, and a per-element confirmation; network summarised by default. Per-call `mode` (`scoped_snapshot` | `tree_diff` | `full` | `none`) and a token budget.
- **vision** — screenshots, optionally cropped to an element.
- **console + network reads** — over CDP.
- **session lifecycle** — managed dedicated profile (default), CDP-attach to a human-launched Chrome (BYOB — off by default, behind an explicit "I-accept-the-risks" flag + loud warning), the `window.__browx` human↔agent helper channel (`signal`/`proceed`/`abort`/`done` + a server-side `awaitHuman({kind, prompt, choices?, timeoutMs?})` + a `pick_element` overlay) over a CDP binding, headed / headless modes. CDP bound to loopback only; page content treated as untrusted.

## Where the design lives

The **canonical spec, roadmap, and design research** are in the `project-ideas` portfolio
repo, under `projects/agent-browser-bridge/` — `spec.md` (what & why), `roadmap.md` (phases),
`research-open-questions.md` (the `ActionResult` shape, the `__browx` API, the phased security
posture, the public-release trigger), `progress.md` (history). This repo is the *implementation*;
treat the portfolio docs as the source of truth and keep them in sync when implementation forces
a design change.

Current status: **Phase 0 — discovery & validation.** See [`PHASE-0.md`](PHASE-0.md).

## Consumer #1

`automated-site-documentation-bot` (site-docs) — its discovery/calibration stage will drive
through browxai in place of Claude-in-Chrome, including a session bearing real `httpOnly` auth
cookies. That's the dogfood + validation harness for the MVP.

## Layout

```
src/            the MCP server (skeleton; Phase 1)
.github/        CI (typecheck + test on Node 20 / pnpm)
.claude/        commit-guard hooks (single-line conventional subjects ≤72 chars, no AI trailers)
PHASE-0.md      the Phase-0 plan + live build status
```

## Develop

```bash
corepack enable && pnpm install
pnpm typecheck && pnpm test
pnpm build
```

## License

MIT — see [`LICENSE`](LICENSE).
