// Public exports. Most users want the CLI (`browxai` bin) — see cli.ts. This module
// is for embedding the MCP server programmatically or pulling in types.

export { createServer, NAME, VERSION } from "./server.js";
export type { StartOptions } from "./server.js";
export { resolveWorkspace } from "./util/workspace.js";
export type { BrowserSession, SessionOptions, SessionMode } from "./session/types.js";
