// Public exports. Most users want the CLI (`browxai` bin) — see cli.ts. This module
// is for embedding the MCP server programmatically or pulling in types.

// RFC 0004 P2: install the tool-metadata collector so the derived `TOOL_CAPABILITY`
// / `DEEP_TOOLS` maps populate for any package consumer (notably the SDK client's
// capability gate, which reads `TOOL_CAPABILITY` without first building a server).
// Importing this side-effecting module is the composition-root install point; the
// collection is cached, so loading it here is cheap and idempotent.
import "./tools/tool-metadata.js";

export { createServer, NAME, VERSION } from "./server.js";
export type { StartOptions } from "./server.js";
export { resolveWorkspace } from "./util/workspace.js";
export type { BrowserSession, SessionOptions, SessionMode } from "./session/types.js";

// Typed SDK surface — see src/sdk/types.ts. Importing this from
// `browxai` gives consumers a programmatic driver over the same
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
