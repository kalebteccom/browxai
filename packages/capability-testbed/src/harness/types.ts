// Harness contracts. The harness drives the raw MCP surface so it can exercise
// tools that are intentionally not exposed by the curated public SDK.

export interface BrowxaiResult {
  readonly content: unknown;
  readonly data?: unknown;
  readonly isError?: boolean;
}

export interface McpClientAdapter {
  callTool(name: string, args?: Record<string, unknown>): Promise<BrowxaiResult>;
  open_session(args?: Record<string, unknown>): Promise<BrowxaiResult>;
  close_session(args?: Record<string, unknown>): Promise<BrowxaiResult>;
  close_sessions(args?: Record<string, unknown>): Promise<BrowxaiResult>;
  list_sessions(args?: Record<string, unknown>): Promise<BrowxaiResult>;
  close(): Promise<void>;
}

export type Client = McpClientAdapter;

/** The 16 real capabilities + a synthetic "control" bucket for the always-on
 *  control-plane tools (open_session, batch, config, approvals). */
export type Capability =
  | "read"
  | "navigation"
  | "action"
  | "human"
  | "eval"
  | "byob-attach"
  | "file-io"
  | "network-body"
  | "clipboard"
  | "secrets"
  | "extensions"
  | "stealth"
  | "captcha"
  | "credentials"
  | "device-emulation"
  | "diagnostics"
  | "canvas"
  | "control";

export type Outcome = "pass" | "fail" | "error" | "skip" | "pending";

export interface ExerciseResult {
  readonly outcome: Outcome;
  /** What was asserted / why it failed — one line, human-readable. */
  readonly detail?: string;
  /** Structured evidence (a tool-result excerpt, the thrown error, etc.). */
  readonly evidence?: unknown;
}

export interface ExerciseCtx {
  /** browxai client with ALL capabilities enabled. */
  readonly client: Client;
  /** Session id bound for this exercise (fresh per exercise). */
  readonly session: string;
  /** Testbed server origin, e.g. http://localhost:5187. */
  readonly baseUrl: string;
  /** BROWX_WORKSPACE dir — where file-io tools may read/write. */
  readonly workspace: string;
  /** Navigate the bound session to a testbed path and settle. */
  goto(path: string): Promise<BrowxaiResult>;
  /** Call a tool by name on the bound session (session arg auto-injected). */
  call(tool: string, args?: Record<string, unknown>): Promise<BrowxaiResult>;
  /** Append a progress line to this exercise's log. */
  log(msg: string): void;
}

export type Exercise = (ctx: ExerciseCtx) => Promise<ExerciseResult>;

/** A registered map of tool name -> exercise. Each exercises/<capability>.ts
 *  module default-exports one of these. */
export type ExerciseMap = Readonly<Record<string, Exercise>>;

export interface ManifestRow {
  readonly tool: string;
  readonly capability: Capability;
  /** Testbed surface path this exercise drives (informational). */
  readonly surface?: string;
  /** What the exercise should assert. */
  readonly intent: string;
}

export interface ToolReport {
  readonly tool: string;
  readonly capability: Capability;
  readonly outcome: Outcome;
  readonly detail?: string;
  readonly evidence?: unknown;
  readonly durationMs: number;
  readonly log: readonly string[];
}

export interface FullReport {
  readonly engine: string;
  readonly headless: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly totals: Readonly<Record<Outcome, number>>;
  readonly byCapability: ReadonlyArray<{
    readonly capability: Capability;
    readonly totals: Readonly<Record<Outcome, number>>;
  }>;
  readonly tools: readonly ToolReport[];
}

/** Helper constructors for exercises. */
export const pass = (detail?: string, evidence?: unknown): ExerciseResult => ({
  outcome: "pass",
  detail,
  evidence,
});
export const fail = (detail: string, evidence?: unknown): ExerciseResult => ({
  outcome: "fail",
  detail,
  evidence,
});
export const skip = (detail: string): ExerciseResult => ({ outcome: "skip", detail });
