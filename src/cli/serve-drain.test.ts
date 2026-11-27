import { afterEach, describe, expect, it } from "vitest";
import { fakeDrainClock } from "./__fixtures__/drain-clock.js";
import { addVersion, tempRuntime, type TempRuntime } from "./__fixtures__/runtime-tree.js";
import { switchCurrent } from "./runtime-store.js";
import {
  DRAIN_CHECK_MS,
  DRAIN_EXIT_CODE,
  DRAIN_IDLE_MS,
  drainSetting,
  startDrain,
} from "./serve-drain.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

const MIN = 60_000;

function runtimeOn(v: string): TempRuntime {
  rt = tempRuntime();
  addVersion(rt.paths, "0.21.0");
  addVersion(rt.paths, "0.22.0");
  switchCurrent(rt.paths, v);
  return rt;
}

function drain(opts: { connections?: () => number; sessions?: () => number } = {}) {
  const { clock, advance, live } = fakeDrainClock();
  const exits: number[] = [];
  const logs: string[] = [];
  const d = startDrain({
    root: rt!.paths.root,
    version: "0.21.0",
    connections: opts.connections ?? (() => 0),
    sessions: opts.sessions ?? (() => 0),
    clock,
    log: (l) => logs.push(l),
    onDrain: (code) => exits.push(code),
  });
  return { d, advance, exits, logs, live };
}

describe("drainSetting", () => {
  it("is on under the runtime launcher, by default", () => {
    expect(
      drainSetting({ BROWX_RUNTIME_DIR: "/rt", BROWX_RUNTIME_VERSION: "0.21.0" }, "9.9.9"),
    ).toEqual({ on: true, root: "/rt", version: "0.21.0" });
    expect(
      drainSetting({ BROWX_RUNTIME_DIR: "/rt", BROWX_RUNTIME_DAEMON_RESTART: "idle" }, "9.9.9"),
    ).toEqual({ on: true, root: "/rt", version: "9.9.9" });
  });

  it.each([
    [{}],
    [{ BROWX_RUNTIME_DIR: "relative" }],
    [{ BROWX_RUNTIME_DIR: "/rt", BROWX_RUNTIME_DAEMON_RESTART: "off" }],
  ])("is off for %j", (env) => {
    expect(drainSetting(env, "9.9.9")).toEqual({ on: false });
  });

  it("stays off with a warning for a value it doesn't know", () => {
    expect(
      drainSetting({ BROWX_RUNTIME_DIR: "/rt", BROWX_RUNTIME_DAEMON_RESTART: "always" }, "9.9.9"),
    ).toEqual({
      on: false,
      warning:
        "BROWX_RUNTIME_DAEMON_RESTART=always is not idle or off, so this daemon keeps running when the runtime switches versions",
    });
  });
});

describe("startDrain", () => {
  it("checks every 5 minutes and waits 15 idle minutes", () => {
    expect(DRAIN_CHECK_MS).toBe(5 * MIN);
    expect(DRAIN_IDLE_MS).toBe(15 * MIN);
    expect(DRAIN_EXIT_CODE).toBe(75);
  });

  it("never exits while current names its own version", () => {
    runtimeOn("0.21.0");
    const { advance, exits } = drain();
    advance(24 * 60 * MIN);
    expect(exits).toEqual([]);
  });

  it("exits 75 once, with one log line, after 15 idle minutes once current moved", () => {
    runtimeOn("0.21.0");
    const { advance, exits, logs, live } = drain();
    advance(10 * MIN);
    switchCurrent(rt!.paths, "0.22.0");
    advance(4 * MIN);
    expect(exits).toEqual([]);
    advance(1 * MIN);
    expect(exits).toEqual([75]);
    expect(logs).toEqual([
      "browxai serve: current is 0.22.0 and this daemon runs 0.21.0. It had no client and no session for 15 minutes, so it exits with 75 for its job to start 0.22.0.",
    ]);
    expect(live()).toBe(0);
    advance(60 * MIN);
    expect(exits).toEqual([75]);
  });

  it("waits while a client is connected and for 15 minutes after it leaves", () => {
    runtimeOn("0.22.0");
    let connections = 1;
    const { d, advance, exits } = drain({ connections: () => connections });
    advance(60 * MIN);
    expect(exits).toEqual([]);
    connections = 0;
    d.activity();
    advance(14 * MIN);
    expect(exits).toEqual([]);
    advance(6 * MIN);
    expect(exits).toEqual([75]);
  });

  it("restarts the idle time when a client comes and goes between checks", () => {
    runtimeOn("0.22.0");
    const { d, advance, exits } = drain();
    advance(12 * MIN);
    d.activity();
    advance(8 * MIN);
    expect(exits).toEqual([]);
    advance(10 * MIN);
    expect(exits).toEqual([75]);
  });

  it("never exits while a session is open", () => {
    runtimeOn("0.22.0");
    const { advance, exits } = drain({ sessions: () => 1 });
    advance(24 * 60 * MIN);
    expect(exits).toEqual([]);
  });

  it("does nothing when the runtime has no current", () => {
    rt = tempRuntime();
    const { advance, exits } = drain();
    advance(60 * MIN);
    expect(exits).toEqual([]);
  });

  it("stops checking when stopped", () => {
    runtimeOn("0.22.0");
    const { d, advance, exits, live } = drain();
    d.stop();
    expect(live()).toBe(0);
    advance(60 * MIN);
    d.check();
    expect(exits).toEqual([]);
  });
});
