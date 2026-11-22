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

/** Resolve once the stream has taken the text. The bin exits right after the handler
 *  returns, so a pipe that has not drained would lose the end of a long result. */
const writeAll = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
  new Promise<void>((resolve) => {
    stream.write(text, () => resolve());
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
