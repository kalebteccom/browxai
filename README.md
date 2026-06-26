<p align="center">
  <a href="https://browxai.com"><img src="brand/browxai-glass-aurora-1024.png" width="116" alt="browxai" /></a>
</p>

<h1 align="center">browxai</h1>

<p align="center"><strong>A browser, built for agents.</strong><br/>
<a href="https://browxai.com">browxai.com</a> · <a href="brand/">brand kit</a></p>

**Give your AI agent a real browser it can navigate, read, and act on — over the Model Context Protocol or a typed TypeScript SDK.**

browxai is a browser-control server designed for agents, not for human programmers. Point any MCP client (Claude Code, Codex, Pi, …) or a single TypeScript script at it, and your agent gets a compact, safe set of tools — navigate, find, click, fill, read, screenshot — that return small, structured results instead of raw DOM dumps. It works with any model, drives five browser engines, and keeps the dangerous powers off until you turn them on.

## What your agent can do with it

- **Drive a live web app.** Have a coding agent `navigate` to a page, `find` a control by natural-language query, `fill` a form, `click`, and verify the outcome from a structured `ActionResult` — without burning tokens on a full DOM dump.
- **Work inside an authenticated session.** Open a `persistent` or `attached` (bring-your-own-browser) session so the agent operates inside a real, logged-in profile and can automate multi-step flows that need the existing cookies.
- **Extract structured data from a script.** From one autonomous TypeScript file: `createBrowxai()` → `navigate()` → `extract({ schema })` → `close()`, with the same safety gates as the MCP path.
- **Run cross-engine checks.** Drive the identical tool surface on Chromium, Firefox, WebKit, real Chrome-on-Android, or real Safari — pick the engine per session and validate a flow beyond just Chromium.
- **Run in CI without wedging.** Stand the server up headless in a pipeline; every call has a hard anti-wedge deadline, so a stuck page never hangs the run.
- **Share one browser across agents.** Run `browxai serve --socket` and attach multiple SDK clients to one long-running server (one Chromium) — e.g. an orchestrating agent plus a helper script.

## Why browxai

- **Model-agnostic** — works with any MCP client (Claude, Codex, …); not locked to one model.
- **Engine-agnostic** — the same tools drive Chromium / Firefox / WebKit / Android Chrome / Safari, each over the protocol that fits it (CDP, WebDriver BiDi, safaridriver). Pick with `--engine` / `BROWX_ENGINE`; the default is Chromium.
- **Token-efficient** — `snapshot()` returns a compact accessibility tree with stable element refs, not a DOM dump; results are scoped, paginated, and budgeted.
- **Safe by default** — capability-gated tools, an origin allow/blocklist, confirmation hooks, and a hard per-call deadline. The dangerous surface (arbitrary JS, full response bodies, OS clipboard, network mocking, attaching to your real Chrome) is off until you opt in.
- **Owns the full session lifecycle** — managed profiles, BYOB attach, and authenticated, headed, or headless sessions — rather than wrapping someone else's automation API.

## Stability

browxai follows semver. The public tool surface — tool names, documented input/output shapes, the `ActionResult` shape, and the default capability set — is frozen and semver-governed, so you can adopt it freely and pin your version. Anything behind an off-by-default capability is explicitly experimental and not covered by the stability guarantee. See the [Stability and semver](https://browxai.com/reference/tool-reference/#stability-and-semver) policy.

## Install

```bash
npm install -g browxai
npx playwright-core install chromium    # one-time, ~150 MB
```

Wire it into an MCP client (stdio transport) — e.g. in an `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "browxai": { "command": "browxai" },
  },
}
```

That's it — your agent now has a browser. For drop-in setup per harness, see [Harness setup](#harness-setup) below.

## SDK (programmatic surface)

To author a single TypeScript script and run it autonomously, browxai ships a typed SDK. Same tool registry, same capability gates, same egress hygiene — different transport.

```ts
import { createBrowxai } from "browxai";

const browxai = await createBrowxai(); // in-process, single-script
await browxai.navigate({ url: "https://example.com" });
const { data } = await browxai.extract({
  schema: { title: "string" },
});
await browxai.close();
```

Three transports:

- **In-process** (default) — single Node process; the SDK drives the server in-process. `close()` shuts the embedded server.
- **Stdio child** (`transport: "stdio-child"`) — spawns the `browxai` bin as a subprocess and speaks MCP-over-stdio. `close()` ends the child.
- **Socket-attached** (`endpoint: "unix:///tmp/foo.sock"`) — connects to a long-running `browxai serve --socket /tmp/foo.sock` process. Multiple clients can attach to ONE server (e.g. a parent agent plus a child script sharing one Chromium). `close()` ends only the local connection.

The same safety gates apply as on the MCP path. Tools that broaden the security posture (`eval_js`, `network_body`, `register_secret`, `upload_file`, …) are **off by default** and only appear once their capability is named in `createBrowxai({ capabilities })`. Calling a non-exposed tool — even via `client.callTool("eval_js", …)` — fails with a `BROWXAI_SDK_NOT_EXPOSED` error before anything hits the wire.

## Harness setup

Ready-to-use setup for the common agent harnesses — MCP-server registration plus a portable "driving browxai well" Agent Skill — lives in **[`harness/`](harness/)**: [Claude Code](harness/adapters/claude-code/), [Codex](harness/adapters/codex/), [Pi](harness/adapters/pi/).

## The surface

- **`snapshot`** — compact accessibility tree + DOM-walk pass; every node gets a stable `[ref=eN]`.
- **`find`** — natural-language query → ranked candidate locators with `selectorHint`, `stability`, a visible-rect `bbox`, and an `actionable` verdict.
- **action tools** (`click` / `fill` / `navigate` / `select` / `wait_for` / …) — each returns a structured `ActionResult`: what navigated, what structure changed, a console/network slice, and a post-action element probe.
- **read tools** — `text_search`, `inspect`, `console_read`, `network_read`, `ws_read`, `screenshot`.
- **sessions** — isolated per-session contexts (own cookie jar / refs); `persistent`, `incognito`, or `attached` (BYOB) modes; MCP-driven config.
- **capabilities** — `read`, `navigation`, `action`, `human` on by default; `eval`, `network-body`, `clipboard`, `file-io`, `byob-attach`, `secrets`, `extensions`, … are explicit opt-ins.

The full per-tool reference, the security model, and the stability policy are on the **[documentation site](https://browxai.com/)**.

## For contributors

```bash
corepack enable && pnpm install
pnpm install-browser     # Chromium for playwright-core
pnpm typecheck && pnpm test
pnpm build               # builds dist/ — the `browxai` bin is dist/cli.js
pnpm test:keystone       # headless end-to-end keystone (real Chromium)
pnpm docs:dev            # the documentation site, locally
```

Project docs:

- [CONTRIBUTING.md](CONTRIBUTING.md) — contributor workflow + DCO.
- [AGENTS.md](AGENTS.md) — operating rules for AI-harness contributors.
- [SECURITY.md](SECURITY.md) — vulnerability reporting + disclosure policy.
- [MAINTAINERS.md](MAINTAINERS.md) — maintainer roster + responsibilities.
- [RELEASING.md](RELEASING.md) — release ritual + OIDC publish flow.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Contributor Covenant adoption.

## License

Code is MIT — see [LICENSE](LICENSE).

The **browxai name and logo are trademarks of Kalebtec** and are not
covered by the MIT License. The brand assets under [`brand/`](brand/)
are all-rights-reserved (see [`brand/LICENSE`](brand/LICENSE)). See
[TRADEMARKS.md](TRADEMARKS.md) for the full brand policy and what
nominative use is allowed.
