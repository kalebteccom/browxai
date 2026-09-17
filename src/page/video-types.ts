// The per-session video-recorder state, above the adapter that drives it.
//
// Split out of `video.ts` for the reason `actions-types.ts` was split out of
// `actions.ts` in RFC 0009 P1: `video.ts` imports `Page` and calls
// `page.video().saveAs()`, so it is the Playwright adapter body. The state it
// carries is plain data — four booleans, two paths, a size, a timestamp — and
// `CaptureSubstrate.prepareVideoSave` names it, so it has to live where the port
// can reach it without reaching playwright-core. `video.ts` re-exports every
// name, so existing importers are unchanged. (RFC 0009 P3.)

/** Per-session video recorder state. One per `SessionEntry`. */
export interface VideoRecorderState {
  /** True between session creation (with `recordVideo`) and `close_session`. */
  active: boolean;
  /** Workspace-absolute path the .webm will be written to on close. Reserved
   *  at session creation; the user-facing deterministic name. */
  targetPath?: string;
  /** Staging directory passed to Playwright's `recordVideo.dir`. Playwright
   *  auto-names a file inside this dir; we move/copy it to `targetPath` on
   *  session close via `page.video().saveAs(targetPath)`. */
  stagingDir?: string;
  /** Recorded video size. */
  size?: { width: number; height: number };
  /** epoch ms the recorder was wired (context creation time). */
  startedAt?: number;
  /** True once the .webm has been saved to `targetPath` on disk (i.e.
   *  `finalizeOnClose` has run). `get_video` checks this before reading. */
  finalized: boolean;
  /** True once `stop_video` has been called. The actual flush still happens
   *  on `close_session` (Playwright constraint); this just records the
   *  agent's intent so the result envelope can carry it. */
  pendingFinalize: boolean;
}

/** Configuration accepted by `open_session({recordVideo})`. */
export interface VideoStartConfig {
  /** Workspace-rooted path. Optional — defaults to
   *  `<workspace>/videos/<session-id>-<ISO>.webm` when omitted. Path traversal
   *  outside the workspace is rejected. */
  path?: string;
  /** Recorded video size. Maps to Playwright's `recordVideo.size`. */
  size?: { width: number; height: number };
}

/** Structured refusal — matches the shape `assertPdfSupported` returns so the
 *  tool layer can wrap it uniformly. */
export interface VideoRefusal {
  error: string;
  hint: string;
}
