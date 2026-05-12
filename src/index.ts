// browxai — MCP-native, model-agnostic, agentic-first browser-control server.
//
// Skeleton only. The Phase-1 surface (see PHASE-0.md and the spec/roadmap in
// kalebteccom/project-ideas → projects/agent-browser-bridge/):
//   - snapshot()                — a11y tree + stable selectors, token-efficient
//   - find(query)               — ranked candidate locators + evidence
//   - click/fill/navigate/...   — return a structured ActionResult (scoped a11y
//                                 re-snapshot + navigation/structure/network/errors)
//   - screenshot, console/network reads
//   - session lifecycle         — managed profile (default) / BYOB CDP-attach (opt-in),
//                                 the window.__browx human↔agent helper channel
//
// Nothing Claude-specific; transport is MCP over stdio. Built on playwright-core + CDP;
// deliberately NOT a wrapper over @playwright/mcp.

export const NAME = "browxai";
export const VERSION = "0.0.0";
