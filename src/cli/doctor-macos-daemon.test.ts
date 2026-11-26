// The `macos-app` row's daemon detail: what the probe does to the socket, and what the
// row says inside and outside the app.

import { describe, expect, it } from "vitest";
import { SocketGuardError } from "../transport/socket-guard.js";
import { macosAppCheck, probeDaemon, type DaemonProbe } from "./doctor-macos-daemon.js";
import { formatDoctor } from "./doctor-summary.js";
import { MACOS_APP_BUNDLE_ID, type CommandRunner } from "./macos-app.js";

const APP = "/Applications/Browxai.app";
const NODE = `${APP}/Contents/Resources/node/bin/node`;
const LAUNCHER = `${APP}/Contents/MacOS/browxai-launcher`;
const HOME = "/Users/someone";
const DEFAULT_SOCKET = `${HOME}/Library/Application Support/Browxai/run/browxai.sock`;

const SIGNED = [
  "Identifier=com.kalebtec.browxai",
  "CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded",
  "TeamIdentifier=ABCDE12345",
].join("\n");
const ADHOC = [
  "Identifier=com.kalebtec.browxai",
  "CodeDirectory v=20400 size=900 flags=0x2(adhoc) hashes=30+7 location=embedded",
  "Signature=adhoc",
  "TeamIdentifier=not set",
].join("\n");

/** A runner that answers what the row asks about a signed app with a registered agent. */
function appRunner(signature: string = SIGNED): CommandRunner {
  return (file, args) => {
    if (file === "/usr/bin/plutil") {
      const value = args[1] === "CFBundleIdentifier" ? MACOS_APP_BUNDLE_ID : "browxai-launcher";
      return { status: 0, stdout: `${value}\n`, stderr: "" };
    }
    if (file === "/usr/bin/codesign" && args[0] === "-dv") {
      return { status: 0, stdout: "", stderr: signature };
    }
    if (file === "/usr/bin/codesign") return { status: 0, stdout: "", stderr: "" };
    if (file === LAUNCHER) return { status: 0, stdout: "enabled: registered\n", stderr: "" };
    return { status: 127, stdout: "", stderr: "not found" };
  };
}

/** A probe that records the path it was given. */
function probeOf(answer: DaemonProbe) {
  const paths: string[] = [];
  const probe = (path: string): Promise<DaemonProbe> => {
    paths.push(path);
    return Promise.resolve(answer);
  };
  return { probe, paths };
}

const inApp = (answer: DaemonProbe, over: Parameters<typeof macosAppCheck>[0] = {}) => {
  const p = probeOf(answer);
  const check = macosAppCheck({
    platform: "darwin",
    execPath: NODE,
    run: appRunner(),
    env: {},
    home: HOME,
    probe: p.probe,
    ...over,
  });
  return { check, paths: p.paths };
};

describe("probeDaemon", () => {
  it("opens a connection, closes it and reports a daemon", async () => {
    let destroyed = 0;
    const found = await probeDaemon("/tmp/d.sock", (path) => {
      expect(path).toBe("/tmp/d.sock");
      return Promise.resolve({ destroy: () => void destroyed++ });
    });
    expect(found).toEqual({ reachable: true });
    expect(destroyed).toBe(1);
  });

  it("reports no daemon when nothing is there or nothing listens", async () => {
    for (const code of ["ENOENT", "ECONNREFUSED"]) {
      const found = await probeDaemon("/tmp/d.sock", () =>
        Promise.reject(Object.assign(new Error(code), { code })),
      );
      expect(found, code).toEqual({ reachable: false });
    }
  });

  it("carries the reason when the socket fails the owner check", async () => {
    const found = await probeDaemon("/tmp/d.sock", () =>
      Promise.reject(new SocketGuardError("refusing to connect: /tmp/d.sock is not a socket.")),
    );
    expect(found).toEqual({
      reachable: false,
      refused: "refusing to connect: /tmp/d.sock is not a socket.",
    });
  });

  it("gives up after the bound, and closes a connection that opens later", async () => {
    let destroyed = 0;
    let open: (socket: { destroy: () => void }) => void = () => undefined;
    const late = new Promise<{ destroy: () => void }>((resolve) => (open = resolve));
    const found = await probeDaemon("/tmp/d.sock", () => late, 10);
    expect(found).toEqual({ reachable: false });
    open({ destroy: () => void destroyed++ });
    await new Promise((resolve) => setImmediate(resolve));
    expect(destroyed).toBe(1);
  });
});

describe("macosAppCheck", () => {
  it("returns no row off macOS and probes nothing", async () => {
    const p = probeOf({ reachable: true });
    for (const platform of ["linux", "win32"] as const) {
      expect(
        await macosAppCheck({ platform, execPath: NODE, run: appRunner(), probe: p.probe }),
      ).toBeUndefined();
    }
    expect(p.paths).toEqual([]);
  });

  it("leaves the one line alone outside the app and probes nothing", async () => {
    const p = probeOf({ reachable: true });
    const check = await macosAppCheck({
      platform: "darwin",
      execPath: "/opt/homebrew/bin/node",
      run: appRunner(),
      probe: p.probe,
    });
    expect(check).toEqual({
      name: "macos-app",
      ok: true,
      info: true,
      detail:
        "not running from the signed Browxai app. Permission grants then attach to the launching terminal or MCP client.",
    });
    expect(p.paths).toEqual([]);
  });

  it("adds `daemon reachable` in the app and stays informational", async () => {
    const { check, paths } = inApp({ reachable: true });
    const row = (await check)!;
    expect(row.detail).toMatch(/login agent registered, daemon reachable$/);
    expect(row.info).toBe(true);
    expect(row.warn).toBeUndefined();
    expect(row.fix).toBeUndefined();
    expect(paths).toEqual([DEFAULT_SOCKET]);
  });

  it("probes the socket in BROWX_SOCKET when the launcher set one", async () => {
    const { check, paths } = inApp({ reachable: true }, { env: { BROWX_SOCKET: "/tmp/own.sock" } });
    await check;
    expect(paths).toEqual(["/tmp/own.sock"]);
  });

  it("adds `no daemon on the socket` with a next step that names login-item status", async () => {
    const row = (await inApp({ reachable: false }).check)!;
    expect(row.detail).toMatch(/, no daemon on the socket$/);
    expect(row.ok).toBe(true);
    expect(row.warn).toBe(true);
    expect(row.info).toBeUndefined();
    expect(row.fix).toContain(`no daemon answers on ${DEFAULT_SOCKET}`);
    expect(row.fix).toContain(`"${LAUNCHER}" login-item status`);
  });

  it("says why when the socket was refused", async () => {
    const row = (await inApp({ reachable: false, refused: "refusing to connect: it has mode 666." })
      .check)!;
    expect(row.fix).toContain("The socket was not tried: refusing to connect: it has mode 666.");
  });

  it("keeps the signature's own next step and adds the daemon's", async () => {
    const row = (await inApp({ reachable: false }, { run: appRunner(ADHOC) }).check)!;
    expect(row.fix).toContain("a signature with no team changes with every build");
    expect(row.fix).toContain("login-item status");
    const reachable = (await inApp({ reachable: true }, { run: appRunner(ADHOC) }).check)!;
    expect(reachable.warn).toBe(true);
    expect(reachable.detail).toMatch(/, daemon reachable$/);
    expect(reachable.fix).not.toContain("login-item status");
  });

  it("never fails doctor, and shows the next step in the short summary", async () => {
    const row = (await inApp({ reachable: false }).check)!;
    const { text, allOk } = formatDoctor([row], { verbose: false, version: "0.0.0" });
    expect(allOk).toBe(true);
    expect(text).toContain("login-item status");
  });
});
