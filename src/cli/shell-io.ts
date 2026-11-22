// What `browxai call` and `browxai tools` touch of the outside world, behind one
// seam so a test can supply its own: the environment, the two output streams, and
// where arguments are read from.

import { type InputSources, readArgsFile, readStdinText } from "./shell-input.js";

export interface ShellIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Write to standard output and resolve once the text is flushed. Nothing but the
   *  JSON document goes here. */
  readonly stdout: (text: string) => Promise<void>;
  /** Write to standard error: usage, warnings, a notice that the daemon was not found. */
  readonly stderr: (text: string) => Promise<void>;
  readonly input: InputSources;
  /** A description of the first write to standard output that failed for a reason other than
   *  a closed pipe (a full disk, an I/O error), or undefined. The real process sets it. */
  readonly writeFailure?: () => string | undefined;
}

/** The streams that already have a quiet error listener. */
const quieted = new WeakSet<object>();
/** The streams whose reader closed the pipe. Later writes to them fail too, and that is the
 *  same event, so it stays quiet. */
const readerGone = new WeakSet<object>();

/** Give an output stream an error listener. Without one, Node raises a failed write as an
 *  uncaught exception and prints a stack trace. The listener swallows the event only:
 *  `writeAll` reports what failed, and the caller decides what the exit code is. */
export function quietStream(stream: NodeJS.WritableStream): void {
  if (quieted.has(stream)) return;
  quieted.add(stream);
  stream.on("error", () => undefined);
}

/** Resolve once the stream has taken the text, or has failed to. The bin exits right after
 *  the handler returns, so a pipe that has not drained would lose the end of a long result.
 *  The value is the failure, or undefined for a clean write. A closed pipe (EPIPE, a reader
 *  that exited early as `| head -c1` does) is not a failure: the command carries on and exits
 *  with the code it computed. Any other error, such as ENOSPC or EIO, is returned. */
export const writeAll = (
  stream: NodeJS.WritableStream,
  text: string,
): Promise<NodeJS.ErrnoException | undefined> =>
  new Promise((resolve) => {
    quietStream(stream);
    const done = (err?: Error | null): void => {
      stream.removeListener("error", done);
      const failure = err ? (err as NodeJS.ErrnoException) : undefined;
      if (failure?.code === "EPIPE") readerGone.add(stream);
      resolve(failure === undefined || readerGone.has(stream) ? undefined : failure);
    };
    // A failed write reaches the callback, and the error event can come first.
    stream.once("error", done);
    stream.write(text, done);
  });

/** Output over two streams. A failed write to standard output is remembered, so the caller
 *  can end with a non-zero code through {@link settle}. */
export function streamIo(
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  rest: Pick<ShellIo, "env" | "input">,
): ShellIo {
  let failure: string | undefined;
  return {
    ...rest,
    stdout: async (text) => {
      const err = await writeAll(stdout, text);
      if (err !== undefined) failure ??= err.code ?? err.message;
    },
    stderr: async (text) => {
      await writeAll(stderr, text);
    },
    writeFailure: () => failure,
  };
}

/** The exit code for a finished command. A result that could not be written to standard
 *  output is not a success: the caller would read nothing or a cut document, so a code of 0
 *  becomes 1, with a line on standard error. A code that was already non-zero stays. */
export async function settle(io: ShellIo, code: number): Promise<number> {
  const failure = io.writeFailure?.();
  if (failure === undefined) return code;
  await io.stderr(`browxai: could not write the result to standard output (${failure}).\n`);
  return code === 0 ? 1 : code;
}

/** The real process: its environment, streams and files. */
export function processIo(): ShellIo {
  return streamIo(process.stdout, process.stderr, {
    env: process.env,
    input: { readStdin: () => readStdinText(), readFile: readArgsFile },
  });
}
