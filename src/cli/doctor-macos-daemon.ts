// `browxai doctor` macos-app row, second half: when browxai runs from the Browxai app,
// whether the app's daemon answers on its socket. An MCP client set up with
// `browxai bridge` reaches that daemon, so this is the first thing to look at when
// such a client reports no server. See docs/rfcs/0013-stdio-socket-bridge.md.
//
// The probe opens a connection and closes it. It sends nothing, does no MCP handshake
// and gives up after 2 seconds. Like the rest of the row it never fails doctor.

import { connectOwnSocket, SocketGuardError } from "../transport/socket-guard.js";
import type { Check } from "./doctor.js";
import { macosAppFacts, type MacosAppOptions } from "./doctor-macos-app.js";
import { appLauncherOf, appSocketPath, runCommand } from "./macos-app.js";

/** How long the probe waits for the socket to accept a connection. */
export const DAEMON_PROBE_TIMEOUT_MS = 2_000;

/** What the probe found: a daemon, or none, with the reason when the socket was refused. */
export type DaemonProbe = { reachable: true } | { reachable: false; refused?: string };

/** Opens a checked connection to a daemon socket. A test passes its own. */
export type SocketOpener = (path: string) => Promise<{ destroy(): unknown }>;

/** Open a connection to the socket at `path` and close it. Never throws. */
export async function probeDaemon(
  path: string,
  open: SocketOpener = connectOwnSocket,
  timeoutMs: number = DAEMON_PROBE_TIMEOUT_MS,
): Promise<DaemonProbe> {
  const opening = open(path);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const first = await Promise.race([opening, timedOut]);
    if (first === "timeout") {
      // A connection that opens after the bound is closed and not counted.
      void opening.then(
        (socket) => void socket.destroy(),
        () => undefined,
      );
      return { reachable: false };
    }
    first.destroy();
    return { reachable: true };
  } catch (err) {
    return err instanceof SocketGuardError
      ? { reachable: false, refused: err.message }
      : { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

export interface MacosAppCheckOptions extends MacosAppOptions {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  probe?: (path: string) => Promise<DaemonProbe>;
}

/**
 * The whole `macos-app` row. Outside the app it is the row of `macosAppRow` unchanged,
 * and nothing is probed. Inside the app the detail gains `daemon reachable` or
 * `no daemon on the socket`, and the second one carries a next step.
 */
export async function macosAppCheck(opts: MacosAppCheckOptions = {}): Promise<Check | undefined> {
  const facts = macosAppFacts(opts);
  if (!facts?.app) return facts?.row;
  const { row, app } = facts;
  const socket = appSocketPath(opts.env, opts.home);
  const found = await (opts.probe ?? probeDaemon)(socket);
  if (found.reachable) return { ...row, detail: `${row.detail}, daemon reachable` };

  const launcher = appLauncherOf(opts.run ?? runCommand, app) ?? "the app's launcher";
  const why = found.refused === undefined ? "" : ` The socket was not tried: ${found.refused}`;
  const next =
    `no daemon answers on ${socket}, so an MCP client set up with \`browxai bridge\` has no server. ` +
    `Check the login agent with \`"${launcher}" login-item status\`.${why}`;
  return {
    name: row.name,
    ok: true,
    warn: true,
    detail: `${row.detail}, no daemon on the socket`,
    fix: row.fix ? `${row.fix} ${next}` : next,
  };
}
