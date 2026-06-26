// Coordination / session-lifecycle tool argument and result-data shapes for
// the SDK surface.
//
// One section of the `tool-types` split. Shared primitives come from
// `tool-types-shared.js` (the leaf), never from the `tool-types.js` barrel that
// re-exports this file — that back-import would be a cycle. See `tool-types.ts`
// for the authoritative header.

import type { BrowxaiResult } from "./types.js";
import type { SessionArg } from "./tool-types-shared.js";

// =============================================================================
// Coordination / session lifecycle
// =============================================================================

export interface AwaitHumanArgs extends SessionArg {
  kind?: "acknowledge" | "confirm" | "choose" | "input";
  prompt: string;
  choices?: ReadonlyArray<string>;
  timeoutMs?: number;
}
export interface AwaitHumanResultData {
  kind: string;
  value: unknown;
  timedOut: boolean;
  error?: string;
}
export type AwaitHumanResult = BrowxaiResult<AwaitHumanResultData>;

export interface NameRefArgs extends SessionArg {
  name: string;
  ref: string;
}
export interface NameRefResultData {
  ok: boolean;
  name: string;
  ref: string;
}
export type NameRefResult = BrowxaiResult<NameRefResultData>;

export type SessionMode = "persistent" | "incognito" | "attached";
/** Browser engine a session runs on. Mirrors the host `EngineKind` (kept as a
 *  local literal so the SDK surface stays free of server-internal imports). */
export type EngineKind = "chromium" | "firefox" | "webkit" | "android" | "safari";
export interface OpenSessionArgs {
  session: string;
  mode?: SessionMode;
  /** Browser engine for this session, overriding the server default. Omit to
   *  inherit it (unchanged legacy behaviour). See the `open_session` tool docs
   *  for the per-engine mode constraints. */
  engine?: EngineKind;
  profile?: string;
  device?: string;
  viewport?: { width: number; height: number };
  dialogPolicy?: string;
  storageState?: string | Record<string, unknown>;
  authState?: string;
  har?: {
    path?: string;
    mode?: "full" | "minimal";
    content?: "embed" | "attach" | "omit";
    urlFilter?: string;
  };
  hars?: ReadonlyArray<string>;
}
export interface OpenSessionResultData {
  ok: boolean;
  session?: string;
  mode?: SessionMode;
  engine?: EngineKind;
  url?: string;
  openedAt?: string;
  error?: string;
}
export type OpenSessionResult = BrowxaiResult<OpenSessionResultData>;

export interface CloseSessionArgs {
  session: string;
}
export interface CloseSessionResultData {
  ok: boolean;
  session: string;
  wasOpen: boolean;
}
export type CloseSessionResult = BrowxaiResult<CloseSessionResultData>;

export interface CloseSessionsArgs {
  prefix?: string;
  all?: boolean;
  idleMs?: number;
}
export interface CloseSessionsResultData {
  ok: boolean;
  closed?: ReadonlyArray<string>;
  count?: number;
  error?: string;
}
export type CloseSessionsResult = BrowxaiResult<CloseSessionsResultData>;

export type ListSessionsArgs = Record<string, never>;
export interface ListSessionsRow {
  id: string;
  mode: SessionMode;
  engine: EngineKind;
  url: string | null;
  pages: number | null;
  openedAt: string;
}
export interface ListSessionsResultData {
  sessions: ListSessionsRow[];
}
export type ListSessionsResult = BrowxaiResult<ListSessionsResultData>;
