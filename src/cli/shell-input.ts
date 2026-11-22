// Turns the argument source `browxai call` was given (inline text, standard input or
// a file) into a JSON object. Error messages never carry the text itself: the
// arguments can hold a token or a password, and a message would print it.

import { readFileSync, statSync } from "node:fs";
import type { Parsed } from "./shell-args.js";

/** The most argument bytes read from standard input or a file. The daemon refuses a
 *  message line past 32 MiB, so a larger input could never be sent. */
export const MAX_ARGS_BYTES = 16 * 1024 * 1024;

/** The tool whose arguments carry a raw secret. It takes them from standard input
 *  or a file only, because a command line shows up in process listings and shell
 *  history. */
export const SECRET_TOOLS: readonly string[] = ["register_secret"];

export interface InputSources {
  /** Read all of standard input as text. */
  readonly readStdin: () => Promise<string>;
  /** Read a file as text. Throws when it cannot be read. */
  readonly readFile: (path: string) => string;
}

/** Read a file as text. The size is checked before anything is read, and only a regular
 *  file is read, so a device, a pipe or a huge file never gets loaded. Throws for
 *  anything else, a file over {@link MAX_ARGS_BYTES} included. */
export function readArgsFile(path: string): string {
  const info = statSync(path);
  if (!info.isFile()) throw new Error("not a regular file");
  if (info.size > MAX_ARGS_BYTES) throw new Error("too large");
  const bytes = readFileSync(path);
  // The file can grow between the check and the read.
  if (bytes.length > MAX_ARGS_BYTES) throw new Error("too large");
  return bytes.toString("utf8");
}

/** Read standard input as text, stopping with an error past {@link MAX_ARGS_BYTES}. */
export async function readStdinText(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  // cap: stops at MAX_ARGS_BYTES, so a pipe that never ends cannot grow memory without limit.
  for await (const chunk of stream) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_ARGS_BYTES) throw new Error("too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Where a parse error sits, as `line L column C`, or undefined when the engine gave no
 *  position. Only the offset is read from the engine's message, never its text. */
function errorPosition(text: string, error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : "";
  const offset = /position (\d+)/.exec(message)?.[1];
  if (offset === undefined) return undefined;
  const before = text.slice(0, Number(offset));
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  return `line ${line} column ${column}`;
}

/** Parse the text as one JSON object. A blank text is an empty object. */
export function parseArgsObject(text: string): Parsed<Record<string, unknown>> {
  if (text.trim() === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const at = errorPosition(text, error);
    return {
      ok: false,
      message: `the arguments are not valid JSON${at === undefined ? "" : ` (${at})`}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "the arguments must be one JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export interface ArgsSource {
  readonly tool: string;
  readonly argsText: string | undefined;
  readonly argsFile: string | undefined;
}

/** Resolve the arguments object from whichever source was given: the inline text,
 *  `-` for standard input, or `--args-file`. No source means an empty object. */
export async function resolveArgs(
  source: ArgsSource,
  io: InputSources,
): Promise<Parsed<Record<string, unknown>>> {
  const { tool, argsText, argsFile } = source;
  const inline = argsText !== undefined && argsText !== "-";
  if (inline && SECRET_TOOLS.includes(tool)) {
    return {
      ok: false,
      message:
        `${tool} takes a raw secret, and anything on the command line shows up in process listings ` +
        "and shell history. Pass the arguments on standard input (`-`) or with --args-file.",
    };
  }
  let text = "";
  try {
    if (argsText === "-") text = await io.readStdin();
    else if (argsFile !== undefined) text = io.readFile(argsFile);
    else if (argsText !== undefined) text = argsText;
  } catch {
    const from = argsText === "-" ? "standard input" : `the file ${argsFile ?? ""}`;
    return {
      ok: false,
      message: `could not read the arguments from ${from} (missing, unreadable, not a regular file, or over 16 MiB)`,
    };
  }
  return parseArgsObject(text);
}
