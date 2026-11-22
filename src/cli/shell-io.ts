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
}

/** The streams that already have a quiet error listener. */
const quieted = new WeakSet<object>();

/** Swallow errors on an output stream. A reader that exits early (`| head -c1`) closes the
 *  pipe, and the next write fails with EPIPE. Without a listener Node raises that as an
 *  uncaught exception and prints a stack trace. The command has computed its exit code by
 *  then, so it carries on and exits with that code. */
export function quietStream(stream: NodeJS.WritableStream): void {
  if (quieted.has(stream)) return;
  quieted.add(stream);
  stream.on("error", () => undefined);
}

/** Resolve once the stream has taken the text, or has failed to (a closed pipe). The bin
 *  exits right after the handler returns, so a pipe that has not drained would lose the
 *  end of a long result. */
export const writeAll = (stream: NodeJS.WritableStream, text: string): Promise<void> =>
  new Promise<void>((resolve) => {
    quietStream(stream);
    const done = (): void => {
      stream.removeListener("error", done);
      resolve();
    };
    // A failed write reaches the callback, and the error event can come first.
    stream.once("error", done);
    stream.write(text, done);
  });

/** The real process: its environment, streams and files. */
export function processIo(): ShellIo {
  return {
    env: process.env,
    stdout: (text) => writeAll(process.stdout, text),
    stderr: (text) => writeAll(process.stderr, text),
    input: { readStdin: () => readStdinText(), readFile: readArgsFile },
  };
}
