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

export interface EvalJsArgs extends SessionArg, TimeoutArg {
  expr: string;
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

export interface NetworkBodyArgs extends SessionArg {
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

export interface UploadFileArgs extends SessionArg {
  ref?: string;
  selector?: string;
  named?: string;
  contextRef?: string;
  name?: string;
  mimeType?: string;
  content?: string;
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

export interface RegisterSecretArgs extends SessionArg {
  name: string;
  value: string;
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
