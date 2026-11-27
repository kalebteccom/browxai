// `browxai runtime`: how runtime commands start other programs (npm, ps, a staged
// browxai). Always an argument list, never a shell. Tests pass a fake runner.

import { spawn } from "node:child_process";

export interface RunResult {
  /** The exit status, or null when the program didn't start or was stopped. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not start (ENOENT, EACCES) or ran past its limit. */
  error?: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type Runner = (
  file: string,
  args: readonly string[],
  opts?: RunOptions,
) => Promise<RunResult>;

/** Output past this is dropped, so a chatty program can't fill memory. */
const MAX_OUTPUT = 4 * 1024 * 1024;

export const runProgram: Runner = (file, args, opts = {}) =>
  new Promise((resolveRun) => {
    const child = spawn(file, [...args], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error: string | undefined;
    const keep = (prev: string, chunk: Buffer): string =>
      prev.length >= MAX_OUTPUT ? prev : prev + chunk.toString("utf8");
    child.stdout.on("data", (c: Buffer) => (stdout = keep(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = keep(stderr, c)));
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            error = `${file} ran past ${opts.timeoutMs} ms and was stopped`;
            child.kill("SIGKILL");
          }, opts.timeoutMs);
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun({ status: error ? null : code, stdout, stderr, ...(error ? { error } : {}) });
    };
    // A program that can't start emits `error` and may never emit `close`.
    child.on("error", (e) => {
      error = e.message;
      if (child.pid === undefined) settle(null);
    });
    child.on("close", (code) => settle(code));
  });
