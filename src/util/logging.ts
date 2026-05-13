// stderr-only structured logger. stdout is the MCP wire — anything we write there
// corrupts the protocol. Importing `console.log` in src/ is a bug.

export type LogLevel = "info" | "warn" | "error";

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  const tail = fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : "";
  process.stderr.write(`[${ts}] ${level} browxai: ${msg}${tail}\n`);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
