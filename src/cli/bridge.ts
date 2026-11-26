// `browxai bridge`: an MCP server on standard input and output that relays every message
// to a running `browxai serve --socket` daemon. An MCP client starts its server as a
// child process and talks to it over stdio, so this is how such a client reaches a
// daemon that other clients, the SDK and the shell route share: one session registry,
// one config store, one capability set.
//
// The command starts no server of its own, runs no tool, opens no listener and writes
// nothing to disk. Standard output carries MCP frames and nothing else. Everything for a
// person goes to standard error, and no frame, tool argument or variable value is ever
// written there.

import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectOwnSocket, SocketGuardError } from "../transport/socket-guard.js";
import { MAX_SOCKET_MESSAGE_BYTES, SocketTransport } from "../transport/socket-transport.js";
import { log } from "../util/logging.js";
import { BridgeRelay, RelayFatalError, type DaemonLink } from "./bridge-relay.js";
import {
  agentStarter,
  runningAppLauncher,
  type AgentStarter,
  type LauncherRunner,
} from "./bridge-start.js";
import { parseBridgeArgs, SOCKET_ENV } from "./shell-args.js";
import { NO_SOCKET, socketPathOf } from "./shell-connect.js";
import { EXIT } from "./shell-result.js";

/** Printed for `browxai bridge --help` (exit 0, from `cli.ts`) and to standard error
 *  when the arguments are wrong (exit 2). */
export const BRIDGE_USAGE =
  "usage: browxai bridge [--socket PATH] [--connect-timeout MS] [--start]\n" +
  "  An MCP server on standard input and output that relays every message to a\n" +
  "  running `browxai serve --socket` daemon. Use it as the command of an MCP\n" +
  "  client's server entry, so the client drives the daemon's sessions and\n" +
  "  several clients share one daemon. It starts no server and runs no tool:\n" +
  "  the daemon's tools, capabilities and settings apply. BROWX_* settings in\n" +
  "  the client's entry, other than BROWX_SOCKET, do nothing.\n" +
  "\n" +
  "  --socket PATH         the daemon's socket, or set BROWX_SOCKET. No default,\n" +
  "                        and nothing is searched for. The socket must be owned\n" +
  "                        by you and closed to other users.\n" +
  "  --connect-timeout MS  how long to wait at start for the daemon to answer\n" +
  "                        (default 15000, 0 tries once)\n" +
  "  --start               from the Browxai app only: when no daemon answers,\n" +
  "                        ask the app's launcher once to start its login\n" +
  "                        agent. It starts an agent that is registered and\n" +
  "                        allowed to run, and registers nothing. Anywhere\n" +
  "                        else it is a usage error.\n" +
  "\n" +
  "  If the daemon stops, open calls get an error and the bridge connects again\n" +
  "  when it is back. Sessions of a restarted daemon are gone.\n" +
  "\n" +
  "  Exit codes: 0 the client closed or the bridge was stopped, 1 internal error\n" +
  "  or a line from the client over 32 MiB, 2 usage, 3 daemon unreachable, the\n" +
  "  socket is not yours, or a restarted daemon negotiated different terms.\n" +
  "\n" +
  "  Example:\n" +
  "    browxai bridge --socket /tmp/b.sock\n";

/** How often the socket is tried while waiting for the daemon at start. */
const CONNECT_RETRY_MS = 250;
/** How long responses on their way get to reach the client after it closes its input. */
const DRAIN_MS = 2_000;
/** Room in the client-side read buffer past the longest line, for the chunk that
 *  arrives while a full line is still buffered. */
const CLIENT_BUFFER_SLACK_BYTES = 1024 * 1024;

/** What the command touches of the outside world, so a test can supply its own. */
export interface BridgeIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdin: Readable & { isTTY?: boolean };
  readonly stdout: Writable;
  /** Write one line for a person to standard error. */
  readonly stderr: (text: string) => void;
  /** Call `stop` when the process is told to stop (SIGTERM, SIGINT). */
  readonly onStop: (stop: () => void) => void;
  /** Open a checked connection to the daemon's socket. */
  readonly connect?: (path: string) => Promise<DaemonLink>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** The launcher of the Browxai app this process runs from, or undefined outside it. */
  readonly appLauncher?: () => string | undefined;
  /** Run the launcher. Used by `--start` only. */
  readonly runLauncher?: LauncherRunner;
}

function processBridgeIo(): BridgeIo {
  return {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: (text) => void process.stderr.write(text),
    onStop: (stop) => {
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    },
  };
}

/** Connect to the daemon at `path`, after the owner check, as a relay link. */
export async function openDaemonLink(path: string): Promise<DaemonLink> {
  const socket = await connectOwnSocket(path);
  return {
    transport: new SocketTransport(socket),
    pause: () => void socket.pause(),
    resume: () => void socket.resume(),
  };
}

/** The `BROWX_*` settings in the environment that a bridge ignores, by name. */
export function ignoredSettings(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((name) => name.startsWith("BROWX_") && name !== SOCKET_ENV && env[name] !== undefined)
    .sort();
}

const errnoOf = (err: unknown): string | undefined =>
  err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;

type FirstLink =
  { readonly link: DaemonLink } | { readonly code: number; readonly message?: string };

/** Try the socket every 250 ms until a daemon answers, the time runs out, or the
 *  process is told to stop. A socket that fails the owner check ends the wait at once. */
async function waitForDaemon(
  path: string,
  timeoutMs: number,
  io: BridgeIo,
  stopped: () => boolean,
  starter: AgentStarter | undefined,
): Promise<FirstLink> {
  const connect = io.connect ?? openDaemonLink;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = io.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let last = "nothing is there";
  // cap: ends at `deadline`; every pass that fails waits CONNECT_RETRY_MS.
  for (;;) {
    try {
      return { link: await connect(path) };
    } catch (err) {
      if (err instanceof SocketGuardError) {
        return { code: EXIT.unreachable, message: `browxai bridge: ${err.message}\n` };
      }
      last = errnoOf(err) === "ENOENT" ? "nothing is there" : (errnoOf(err) ?? "it did not open");
    }
    if (stopped()) return { code: EXIT.ok };
    await starter?.ask();
    if (now() + CONNECT_RETRY_MS > deadline) break;
    await sleep(CONNECT_RETRY_MS);
    if (stopped()) return { code: EXIT.ok };
  }
  return {
    code: EXIT.unreachable,
    message:
      `browxai bridge: no daemon answered on ${path} within ${timeoutMs} ms (${last}). ` +
      "With the Browxai app, check its login agent with the launcher's `login-item status` command. " +
      `With an npm install, start one with \`browxai serve --socket ${path}\`.\n`,
  };
}

const START_OUTSIDE_APP =
  "--start works only when browxai runs from the Browxai app, which has a login agent to start. " +
  "Start a daemon yourself with `browxai serve --socket PATH`.";

const TTY_HINT =
  "browxai bridge: this is an MCP server on stdio. It waits for an MCP client to connect, so there is nothing to type here.\n" +
  '  Add it to your client\'s MCP config (command: "browxai", arguments: "bridge"). Ctrl+C quits.\n';

/** Say what a person starting the bridge needs to know, on standard error. */
function announce(io: BridgeIo): void {
  const ignored = ignoredSettings(io.env);
  if (ignored.length > 0) {
    io.stderr(
      `browxai bridge: ignoring ${ignored.join(", ")}. The bridge starts no server, so the daemon's own settings apply.\n`,
    );
  }
  if (io.stdin.isTTY) io.stderr(TTY_HINT);
}

/** Relay between the client on stdio and the daemon until one side ends it. */
async function relay(
  path: string,
  first: DaemonLink,
  io: BridgeIo,
  starter: AgentStarter | undefined,
): Promise<number> {
  const connect = io.connect ?? openDaemonLink;
  const bridge = new BridgeRelay({
    client: new StdioServerTransport(io.stdin, io.stdout, {
      maxBufferSize: MAX_SOCKET_MESSAGE_BYTES + CLIENT_BUFFER_SLACK_BYTES,
    }),
    clientFlow: { pause: () => void io.stdin.pause(), resume: () => void io.stdin.resume() },
    openDaemon: async () => {
      let link: DaemonLink;
      try {
        link = await connect(path);
      } catch (err) {
        if (err instanceof SocketGuardError) {
          throw new RelayFatalError(`browxai bridge: ${err.message}`);
        }
        // The daemon is not back. With `--start` the launcher is asked once per loss.
        await starter?.ask();
        throw err;
      }
      starter?.reset();
      return link;
    },
    log: (message, fields) => log.info(`bridge: ${message}`, fields),
    sleep: io.sleep,
    clientLineLimit: "32 MiB",
  });
  // The SDK's stdio transport does not watch for the end of input.
  const inputEnded = (): void => void bridge.drain(DRAIN_MS);
  io.stdin.once("end", inputEnded);
  io.stdin.once("close", inputEnded);
  // A failed write to standard output means the client is gone.
  io.stdout.on("error", () => void bridge.close());
  io.onStop(() => void bridge.close());
  await bridge.start(first);
  const end = await bridge.done;
  if (end.message !== undefined) io.stderr(`${end.message}\n`);
  return end.code;
}

/** The handler for `browxai bridge`. Returns the exit code. */
export async function runBridge(rest: string[], io: BridgeIo = processBridgeIo()): Promise<number> {
  const parsed = parseBridgeArgs(rest, io.env);
  if (!parsed.ok) {
    io.stderr(`browxai bridge: ${parsed.message}\n${BRIDGE_USAGE}`);
    return EXIT.usage;
  }
  let starter: AgentStarter | undefined;
  if (parsed.value.start) {
    const launcher = (io.appLauncher ?? runningAppLauncher)();
    if (launcher === undefined) {
      io.stderr(`browxai bridge: ${START_OUTSIDE_APP}\n${BRIDGE_USAGE}`);
      return EXIT.usage;
    }
    starter = agentStarter(launcher, io.stderr, io.runLauncher);
  }
  if (parsed.value.socket === undefined) {
    io.stderr(`browxai bridge: ${NO_SOCKET}\n`);
    return EXIT.unreachable;
  }
  let path: string;
  try {
    path = socketPathOf(parsed.value.socket);
  } catch (err) {
    io.stderr(`browxai bridge: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.unreachable;
  }
  announce(io);
  let stopped = false;
  io.onStop(() => (stopped = true));
  const first = await waitForDaemon(
    path,
    parsed.value.connectTimeoutMs,
    io,
    () => stopped,
    starter,
  );
  if (!("link" in first)) {
    if (first.message !== undefined) io.stderr(first.message);
    return first.code;
  }
  starter?.reset();
  log.info("bridge: connected to the daemon", { socket: path });
  return relay(path, first.link, io, starter);
}
