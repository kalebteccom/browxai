import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { addVersion, tempRuntime, type TempRuntime } from "./__fixtures__/runtime-tree.js";
import { runtimeRow, span, type RuntimeRowDeps } from "./doctor-runtime.js";
import { cliOf, versionDir } from "./runtime-layout.js";
import { switchCurrent, writeState, type RuntimeState } from "./runtime-store.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A runtime on 0.22.0 with a recorded node that exists. */
function installed(state: RuntimeState = {}): TempRuntime {
  rt = tempRuntime();
  addVersion(rt.paths, "0.22.0");
  switchCurrent(rt.paths, "0.22.0");
  writeFileSync(rt.paths.nodePath, process.execPath + "\n");
  writeState(rt.paths, state);
  return rt;
}

function row(over: RuntimeRowDeps = {}) {
  return runtimeRow({
    env: { BROWX_RUNTIME_DIR: rt!.paths.root },
    home: rt!.home,
    selfCli: cliOf(versionDir(rt!.paths, "0.22.0")),
    version: "0.22.0",
    appBundle: () => undefined,
    now: () => NOW,
    agentInstalled: () => ["/fake/job.plist"],
    ...over,
  });
}

describe("the runtime row", () => {
  it("is informational outside a runtime and names the path that won't update", () => {
    rt = tempRuntime();
    const r = runtimeRow({
      env: {},
      selfCli: "/usr/local/lib/node_modules/browxai/dist/cli.js",
      appBundle: () => undefined,
    });
    expect(r).toEqual({
      name: "runtime",
      ok: true,
      info: true,
      detail:
        "not running from a browxai runtime. Client entries that name /usr/local/lib/node_modules/browxai/dist/cli.js don't update",
      enable: "browxai runtime install",
    });
  });

  it("finds the runtime from the real path of cli.js when the variable is unset", () => {
    installed({ lastCheck: iso(NOW - 2 * HOUR), nextCheck: iso(NOW + 4 * HOUR) });
    expect(row({ env: {} })).toMatchObject({ ok: true, detail: expect.stringContaining("0.22.0") });
  });

  it("points at Homebrew inside the signed app", () => {
    rt = tempRuntime();
    expect(row({ appBundle: () => "/Applications/Browxai.app" })).toEqual({
      name: "runtime",
      ok: true,
      info: true,
      detail: "signed app. Updates through Homebrew: brew upgrade --cask browxai",
    });
  });

  it("up to date: the version, channel, last and next check, and where auto-update came from", () => {
    installed({ lastCheck: iso(NOW - 2 * HOUR), nextCheck: iso(NOW + 4 * HOUR) });
    expect(row()).toEqual({
      name: "runtime",
      ok: true,
      detail:
        "0.22.0 (channel latest), checked 2h ago, next check in ~4h, auto-update on (default)",
    });
  });

  it("warns about a version that waits out its delay", () => {
    installed({
      lastCheck: iso(NOW),
      pending: { version: "0.23.0", state: "waiting", until: "2026-11-28T10:00:00.000Z" },
    });
    expect(row()).toMatchObject({
      ok: true,
      warn: true,
      detail: expect.stringMatching(
        /^0\.23\.0 available, waits until 2026-11-28T10:00:00\.000Z\. 0\.22\.0/,
      ) as string,
    });
  });

  it("warns about a held version and a failed apply", () => {
    installed({
      pending: { version: "0.23.0", state: "held", reason: "failed its checks 3 times" },
    });
    expect(row().detail).toMatch(/^0\.23\.0 available, held: failed its checks 3 times/);
    installed({
      failed: { "0.23.0": 2 },
      pending: { version: "0.23.0", state: "failed", reason: "smoke check failed: MCP handshake" },
    });
    expect(row().detail).toMatch(
      /^0\.23\.0 failed its checks 2 times \(smoke check failed: MCP handshake\)\. current stays 0\.22\.0/,
    );
  });

  it("fails doctor only for a version that failed verification", () => {
    installed({ held: { "0.23.0": "verification failed" } });
    const r = row();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^0\.23\.0 failed signature or provenance verification and is held/);
    // An older version held for the same reason is history, not a problem now.
    installed({ held: { "0.21.0": "verification failed" } });
    expect(row().ok).toBe(true);
  });

  it("warns when this process is older than current", () => {
    installed();
    expect(row({ version: "0.21.0" }).detail).toMatch(
      /^this process runs 0\.21\.0, current is 0\.22\.0\. Restart the MCP client/,
    );
  });

  it("warns about a deprecated current, a missing node and a missing job", () => {
    installed({ currentDeprecated: "Use 0.22.1." });
    writeFileSync(rt!.paths.nodePath, "/nonexistent/node\n");
    const r = row({ agentInstalled: () => [] });
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(
      /^0\.22\.0 is deprecated: "Use 0\.22\.1\."\. Run browxai runtime update/,
    );
    expect(r.fix).toBe(
      "the recorded node at /nonexistent/node is gone. Run browxai runtime install; " +
        "auto-update is on, but no background job is installed. Run browxai runtime install",
    );
  });

  it("warns about a held version with auto-update off too", () => {
    const reason = "needs Node >=24, and the runtime's node at /opt/node/bin/node is 22.11.0";
    installed({ pending: { version: "0.23.0", state: "held", reason } });
    const r = row({
      env: { BROWX_RUNTIME_DIR: rt!.paths.root, BROWX_RUNTIME_AUTO_UPDATE: "off" },
    });
    expect(r.warn).toBe(true);
    expect(r.detail).toBe(
      `0.23.0 available, held: ${reason}. 0.22.0 (channel latest), never checked, auto-update off (BROWX_RUNTIME_AUTO_UPDATE)`,
    );
  });

  it("is informational with auto-update off, and names a version a cached check found", () => {
    installed({ pending: { version: "0.23.0", state: "waiting", until: iso(NOW + HOUR) } });
    expect(
      row({ env: { BROWX_RUNTIME_DIR: rt!.paths.root, BROWX_RUNTIME_AUTO_UPDATE: "off" } }),
    ).toEqual({
      name: "runtime",
      ok: true,
      info: true,
      detail: "0.22.0, auto-update off (BROWX_RUNTIME_AUTO_UPDATE). 0.23.0 available",
    });
  });

  it("warns when the auto-update value isn't understood, which counts as off", () => {
    installed();
    const r = row({
      env: { BROWX_RUNTIME_DIR: rt!.paths.root, BROWX_RUNTIME_AUTO_UPDATE: "maybe" },
    });
    expect(r.warn).toBe(true);
    expect(r.detail).toMatch(
      /^BROWX_RUNTIME_AUTO_UPDATE=maybe is not on or off, so auto-update is off/,
    );
  });
});

describe("span", () => {
  it("rounds to minutes, hours or days", () => {
    expect(span(20_000)).toBe("under a minute");
    expect(span(15 * 60_000)).toBe("15m");
    expect(span(2 * HOUR)).toBe("2h");
    expect(span(72 * HOUR)).toBe("3d");
  });
});

describe("the runtime row: notes and the updater fallback", () => {
  it("warns about unread Upgrading notes", () => {
    installed({ notesUnseen: ["0.22.0"] });
    expect(row()).toMatchObject({
      ok: true,
      warn: true,
      detail: expect.stringMatching(
        /^Upgrading notes for 0\.22\.0: browxai runtime notes\. 0\.22\.0/,
      ),
    });
  });

  it.each([
    [
      "1",
      "the updater in 0.22.0 exited with an error on its last run. After 3 in a row the background job runs the previous version's updater once",
    ],
    [
      "2",
      "the updater in 0.22.0 exited with an error on its last 2 runs. After 3 in a row the background job runs the previous version's updater once",
    ],
    [
      "3",
      "the updater in 0.22.0 exited with an error on its last 3 runs. The next run uses the previous version's updater",
    ],
  ])("warns after %s failed background runs", (count, line) => {
    installed({ previous: "0.21.0" });
    writeFileSync(rt!.paths.updaterErrors, `${count}\n`);
    expect(row()).toMatchObject({ ok: true, warn: true, detail: expect.stringContaining(line) });
  });

  it("says when the previous version's updater ran", () => {
    installed({ previous: "0.21.0" });
    writeFileSync(rt!.paths.updaterErrors, "0\n");
    expect(row().detail).toContain(
      "the updater in 0.22.0 exited with an error 3 runs in a row, so the background job ran the previous version's updater once",
    );
  });

  it("says there is nothing to fall back to without a previous version", () => {
    installed();
    writeFileSync(rt!.paths.updaterErrors, "3\n");
    expect(row().detail).toContain("There is no previous version to fall back to");
  });

  it("ignores a count it can't read", () => {
    installed({ lastCheck: iso(NOW - 2 * HOUR), nextCheck: iso(NOW + 4 * HOUR) });
    writeFileSync(rt!.paths.updaterErrors, "x\n");
    expect(row()).toMatchObject({ ok: true });
    expect(row().warn).toBeUndefined();
  });
});
