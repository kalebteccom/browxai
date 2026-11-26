// stderr-only structured logger. stdout is the MCP wire — anything we write there
// corrupts the protocol. Importing `console.log` in src/ is a bug.
//
// stderr is also what the macOS app writes to its log file, so a line is
// passed through the log masks before it is written. A mask is a hook: this
// module knows nothing about secrets, and each server adds a function that
// masks its registered values (`installLogMask`). With no mask added an entry
// is written exactly as given.

export type LogLevel = "info" | "warn" | "error";

/** Rewrites the text of one log entry (message plus serialised fields). */
export type LogMask = (text: string) => string;

const masks = new Set<LogMask>();

/** Add a function every log entry goes through, and get back the call that
 *  removes it. Masks compose: an entry passes through all of them, in the
 *  order they were added, so two servers in one process each keep their own
 *  and neither replaces the other's. A server removes its mask at shutdown. */
export function addLogMask(fn: LogMask): () => void {
  masks.add(fn);
  return () => {
    masks.delete(fn);
  };
}

/** Remove every mask. For tests that need the logger back in its first state. */
export function clearLogMasks(): void {
  masks.clear();
}

/** What is written in place of an entry when one of its masks threw. The entry itself is
 *  dropped, because writing it unmasked is what the mask is there to stop. */
export const LOG_MASK_FAILED = "(log entry withheld: the log mask failed)";

function masked(text: string): string {
  try {
    let out = text;
    for (const mask of masks) out = mask(out);
    return out;
  } catch {
    return LOG_MASK_FAILED;
  }
}

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const tail = fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
  // Message and fields are masked as one text, and the timestamp and level
  // are left out of it so a short registered value cannot rewrite them.
  process.stderr.write(`[${ts}] ${level} browxai: ${masked(`${msg}${tail}`)}\n`);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
