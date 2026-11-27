import { statSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { tempRuntime, type TempRuntime } from "./__fixtures__/runtime-tree.js";
import {
  readSettingsFile,
  resolveAutoUpdate,
  resolveChannel,
  writeSettingsFile,
} from "./runtime-settings.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

describe("resolveChannel", () => {
  it("defaults to latest", () => {
    expect(resolveChannel({}, {})).toEqual({ ok: true, value: "latest", source: "default" });
  });

  it("takes the variable over runtime.json", () => {
    expect(resolveChannel({ BROWX_RUNTIME_CHANNEL: "next" }, { channel: "latest" })).toEqual({
      ok: true,
      value: "next",
      source: "BROWX_RUNTIME_CHANNEL",
    });
    expect(resolveChannel({}, { channel: "next" })).toEqual({
      ok: true,
      value: "next",
      source: "runtime.json",
    });
  });

  it("refuses a channel it doesn't know, from either place", () => {
    expect(resolveChannel({ BROWX_RUNTIME_CHANNEL: "beta" }, {})).toEqual({
      ok: false,
      error: "BROWX_RUNTIME_CHANNEL=beta is not a channel. Use latest or next.",
    });
    expect(resolveChannel({}, { channel: 3 })).toMatchObject({ ok: false });
  });
});

describe("resolveAutoUpdate", () => {
  it("is on by default", () => {
    expect(resolveAutoUpdate({}, {})).toEqual({ on: true, source: "default" });
  });

  it.each(["off", "0", "false", "no", "OFF"])(
    "turns off with BROWX_RUNTIME_AUTO_UPDATE=%s",
    (v) => {
      expect(resolveAutoUpdate({ BROWX_RUNTIME_AUTO_UPDATE: v }, { autoUpdate: true })).toEqual({
        on: false,
        source: "BROWX_RUNTIME_AUTO_UPDATE",
      });
    },
  );

  it("fails closed on a value it doesn't know, in the variable or the file", () => {
    expect(resolveAutoUpdate({ BROWX_RUNTIME_AUTO_UPDATE: "sometimes" }, {})).toEqual({
      on: false,
      source: "BROWX_RUNTIME_AUTO_UPDATE",
      warning: "BROWX_RUNTIME_AUTO_UPDATE=sometimes is not on or off, so auto-update is off",
    });
    expect(resolveAutoUpdate({}, { autoUpdate: "maybe" })).toMatchObject({
      on: false,
      source: "runtime.json",
    });
    expect(resolveAutoUpdate({}, {}, "runtime.json is not a JSON object")).toMatchObject({
      on: false,
    });
  });

  it("lets off in runtime.json win over on in the variable", () => {
    expect(resolveAutoUpdate({ BROWX_RUNTIME_AUTO_UPDATE: "on" }, { autoUpdate: false })).toEqual({
      on: false,
      source: "runtime.json",
    });
    expect(resolveAutoUpdate({ BROWX_RUNTIME_AUTO_UPDATE: "on" }, {})).toEqual({
      on: true,
      source: "BROWX_RUNTIME_AUTO_UPDATE",
    });
  });
});

describe("runtime.json", () => {
  it("merges a write into the file, mode 0600", () => {
    rt = tempRuntime();
    writeSettingsFile(rt.paths, { channel: "next" });
    writeSettingsFile(rt.paths, { autoUpdate: false });
    expect(readSettingsFile(rt.paths)).toEqual({ file: { channel: "next", autoUpdate: false } });
    expect(statSync(rt.paths.settings).mode & 0o777).toBe(0o600);
  });

  it("reports a file that isn't a JSON object", () => {
    rt = tempRuntime();
    writeFileSync(rt.paths.settings, "[]");
    expect(readSettingsFile(rt.paths)).toEqual({
      file: {},
      error: `${rt.paths.settings} is not a JSON object`,
    });
  });
});
