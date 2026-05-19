// Per-session clipboard model (capability `clipboard`, off by default).
//
// The OS clipboard is a single shared resource; concurrent browxai sessions
// must not clobber each other through it. So each session owns its OWN
// clipboard buffer (the source of truth for what *this* session copied/cut),
// and the real OS clipboard is touched **only transactionally, at the exact
// moment of an explicit copy / cut / paste shortcut command** — never polled,
// never synced in the background, and left exactly as the user left it
// between commands. We never *read* the OS clipboard into a session (that
// would import another session's or the human's content — clipboard bleed).

import { spawn } from "node:child_process";

export type ClipOp = "copy" | "cut";

export interface ClipEntry {
  text: string;
  op: ClipOp;
  ts: number;
}

/** One per SessionEntry. In-memory; nothing persisted. */
export class ClipboardBuffer {
  private entry: ClipEntry | null = null;

  set(text: string, op: ClipOp): void {
    this.entry = { text, op, ts: Date.now() };
  }
  get(): ClipEntry | null {
    return this.entry;
  }
}

/**
 * Best-effort, zero-dependency, **write-only** OS clipboard set. Fixed argv
 * (no shell, content via stdin — no injection surface). Called ONLY as part
 * of an explicit copy/cut/paste command. Degrades gracefully when the
 * platform tool is absent (e.g. CI without `xclip`): the per-session buffer
 * still works for same-session paste reasoning; the result just notes
 * `osSync:false`.
 */
export async function osClipboardWrite(text: string): Promise<{ ok: boolean; tool: string; error?: string }> {
  const plat = process.platform;
  const argv =
    plat === "darwin" ? ["pbcopy"]
    : plat === "win32" ? ["clip"]
    : ["xclip", "-selection", "clipboard"];
  return new Promise((resolve) => {
    try {
      const cp = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
      cp.on("error", (e) => resolve({ ok: false, tool: argv[0]!, error: e.message }));
      cp.on("close", (code) =>
        resolve(code === 0 ? { ok: true, tool: argv[0]! } : { ok: false, tool: argv[0]!, error: `exit ${code}` }),
      );
      cp.stdin.end(text);
    } catch (e) {
      resolve({ ok: false, tool: argv[0]!, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
