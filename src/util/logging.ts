// stderr-only structured logger. stdout is the MCP wire — anything we write there
// corrupts the protocol. Importing `console.log` in src/ is a bug.
//
// stderr is also what the macOS app writes to its log file, so a line is
// passed through the log mask before it is written. The mask is a hook: this
// module knows nothing about secrets, and the server installs a function that
// masks registered values (`buildHost`). Until one is installed the mask
// returns its input, so a process with no server logs exactly what it is given.

export type LogLevel = "info" | "warn" | "error";

/** Rewrites the text of one log entry (message plus serialised fields). */
export type LogMask = (text: string) => string;

const identity: LogMask = (text) => text;

let mask: LogMask = identity;

/** Install the function every log entry goes through, or pass null to go back
 *  to writing entries as given. One slot per process: the last caller wins, so
 *  a process that builds two servers masks with the second one's function. */
export function setLogMask(fn: LogMask | null): void {
  mask = fn ?? identity;
}

/** What is written in place of an entry whose mask threw. The entry itself is
 *  dropped, because writing it unmasked is what the mask is there to stop. */
export const LOG_MASK_FAILED = "(log entry withheld: the log mask failed)";

function masked(text: string): string {
  try {
    return mask(text);
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
