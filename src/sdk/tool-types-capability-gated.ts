// Capability-gated tool argument and result-data shapes — typed for `callTool`
// callers; not exposed as per-tool methods on `BrowxaiClient`.
//
// One section of the `tool-types` split. Shared primitives come from
// `tool-types-shared.js` (the leaf), never from the `tool-types.js` barrel that
// re-exports this file — that back-import would be a cycle. The runtime
// capability gate that fronts these tools lives unchanged in the client /
// registry seam; these are the *types only*. See `tool-types.ts` for the
// authoritative header.

import type { BrowxaiResult } from "./types.js";
import type { SessionArg, TimeoutArg } from "./tool-types-shared.js";

// =============================================================================
// Capability-gated tools — typed for `callTool` callers; not exposed as
// per-tool methods on `BrowxaiClient`.
// =============================================================================

/** `eval_js` needs the `eval` capability (off by default). Last resort: prefer
 *  `inspect`, `find`, `extract` and the action tools. */
export interface EvalJsArgs extends SessionArg, TimeoutArg {
  /** JS expression for the page's main frame. Wrap statements in `(() => { … })()`. */
  expr: string;
  /** `"json"` returns the value (JSON-serialisable); `"void"` discards it. */
  returnType?: "json" | "void";
}
export interface EvalJsOk {
  ok: true;
  value?: unknown;
  returnType?: "void";
  warning?: string;
}
export interface EvalJsFail {
  ok: false;
  error: string;
  warning?: string;
}
export type EvalJsResultData = EvalJsOk | EvalJsFail;
export type EvalJsResult = BrowxaiResult<EvalJsResultData>;

/** `network_body` needs the `network-body` capability (off by default). The body is
 *  capped at 256 KB. */
export interface NetworkBodyArgs extends SessionArg {
  /** Request id from `network_read` or `ActionResult.network.requests[].requestId`. */
  requestId: string;
}
export interface NetworkBodyResultData {
  ok: boolean;
  body?: string;
  base64Encoded?: boolean;
  truncated?: boolean;
  error?: string;
}
export type NetworkBodyResult = BrowxaiResult<NetworkBodyResultData>;

/** `upload_file` needs the `file-io` capability (off by default). Pass exactly one
 *  of `content` and `path`. */
export interface UploadFileArgs extends SessionArg {
  ref?: string;
  selector?: string;
  named?: string;
  contextRef?: string;
  name?: string;
  mimeType?: string;
  /** Base64 file content. Mutually exclusive with `path`. */
  content?: string;
  /** Workspace-rooted path, resolved through symlinks. Mutually exclusive with `content`. */
  path?: string;
}
export interface UploadFileResultData {
  ok: boolean;
  mode?: "content" | "path";
  name?: string;
  bytes?: number;
  mimeType?: string;
  target?: string;
  fileCount?: number;
  error?: string;
}
export type UploadFileResult = BrowxaiResult<UploadFileResultData>;

/** `register_secret` needs the `secrets` capability (off by default). */
export interface RegisterSecretArgs extends SessionArg {
  /** Uppercase identifier matching `/^[A-Z][A-Z0-9_]*$/`; the page-visible alias is `<NAME>`. */
  name: string;
  /** The real value. Held in memory for this session only. */
  value: string;
  /** Origin the value may be typed into, such as `https://app.example.com` or
   *  `http://localhost:3000`; a bare host means https. Matches scheme, host and port
   *  exactly. Omit for any origin. */
  scope?: string;
}
export interface RegisterSecretResultData {
  ok: boolean;
  registered?: string;
  scope?: string | null;
  names?: ReadonlyArray<string>;
  error?: string;
  tokensEstimate?: number;
}
export type RegisterSecretResult = BrowxaiResult<RegisterSecretResultData>;
