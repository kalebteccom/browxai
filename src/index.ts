// Public exports. Most users want the CLI (`browxai` bin) — see cli.ts. This module
// is for embedding the MCP server programmatically or pulling in types.

export { createServer, NAME, VERSION } from "./server.js";
export type { StartOptions } from "./server.js";
export { resolveWorkspace } from "./util/workspace.js";
export type { BrowserSession, SessionOptions, SessionMode } from "./session/types.js";

// Typed SDK surface — see src/sdk/types.ts. Importing this from
// `@kalebteccom/browxai` gives consumers a programmatic driver over the same
// tool registry the MCP path exposes, with identical capability gating and
// identical egress hygiene.
export { createBrowxai, NOT_EXPOSED_ERROR, resolveEndpointPath } from "./sdk/index.js";
export type {
  BrowxaiArgs,
  BrowxaiClient,
  BrowxaiContentItem,
  BrowxaiResult,
  BrowxaiSdkOptions,
} from "./sdk/index.js";
