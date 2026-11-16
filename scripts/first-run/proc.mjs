// Run one command, time it, keep its merged output. Every command goes through `exec "$@" 2>&1` so stdout and stderr
// stay in the order the program wrote them, and no argument is ever parsed by a shell.
import { spawnSync } from "node:child_process";

/**
 * run(command, args, { cwd, env, timeoutMs, input })
 * -> { code, ms, output, timedOut, signal }   (code is -1 when the process could not start)
 */
export function run(command, args = [], opts = {}) {
  const started = Date.now();
  const res = spawnSync("bash", ["-c", 'exec "$@" 2>&1', "_", command, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input ?? "",
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 300_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    code: res.status ?? -1,
    ms: Date.now() - started,
    output: `${res.stdout ?? ""}${res.error && !res.stdout ? String(res.error.message) : ""}`,
    timedOut: res.error?.code === "ETIMEDOUT",
    signal: res.signal ?? null,
  };
}

/** The environment every browxai command runs in: nothing from the pipeline except PATH, a throwaway HOME, telemetry off.
 *  No PLAYWRIGHT_BROWSERS_PATH: browsers land in the default place under HOME, where `browxai init` (which starts its own child with a minimal environment) looks for them too. */
export function cleanEnv(work, extra = {}) {
  const proj = `${work}/project`;
  return {
    PATH: `${proj}/node_modules/.bin:${process.env.PATH}`,
    HOME: `${work}/home`,
    TMPDIR: `${work}/tmp`,
    npm_config_cache: `${work}/npm-cache`,
    NO_UPDATE_NOTIFIER: "1",
    DO_NOT_TRACK: "1",
    ...extra,
  };
}
