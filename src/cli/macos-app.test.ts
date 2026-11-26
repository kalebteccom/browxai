import { describe, expect, it } from "vitest";
import {
  appLauncherOf,
  appSocketPath,
  appWrapperOf,
  MACOS_APP_BUNDLE_ID,
  runningAppBundle,
  type CommandRunner,
} from "./macos-app.js";

const APP = "/Applications/Browxai.app";
const NODE = `${APP}/Contents/Resources/node/bin/node`;

/** A plutil that answers the two Info.plist keys, and records every call. */
function plist(values: Record<string, string | undefined>) {
  const calls: string[] = [];
  const run: CommandRunner = (file, args) => {
    calls.push([file, ...args].join(" "));
    const value = file === "/usr/bin/plutil" ? values[args[1] ?? ""] : undefined;
    return value === undefined
      ? { status: 1, stdout: "", stderr: "no such key" }
      : { status: 0, stdout: `${value}\n`, stderr: "" };
  };
  return { run, calls };
}

describe("runningAppBundle", () => {
  it("names the app when node runs inside a bundle with the Browxai id", () => {
    const { run } = plist({ CFBundleIdentifier: MACOS_APP_BUNDLE_ID });
    expect(runningAppBundle({ platform: "darwin", execPath: NODE, run })).toBe(APP);
  });

  it("is undefined off macOS and outside any bundle, and runs nothing", () => {
    const { run, calls } = plist({ CFBundleIdentifier: MACOS_APP_BUNDLE_ID });
    expect(runningAppBundle({ platform: "linux", execPath: NODE, run })).toBeUndefined();
    expect(
      runningAppBundle({ platform: "darwin", execPath: "/opt/homebrew/bin/node", run }),
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("is undefined inside another app's bundle", () => {
    const { run } = plist({ CFBundleIdentifier: "com.example.editor" });
    expect(
      runningAppBundle({
        platform: "darwin",
        execPath: "/Applications/Editor.app/Contents/Frameworks/node",
        run,
      }),
    ).toBeUndefined();
  });
});

describe("the app's paths", () => {
  it("reads the launcher's name from the Info.plist and refuses a path in it", () => {
    expect(appLauncherOf(plist({ CFBundleExecutable: "browxai-launcher" }).run, APP)).toBe(
      `${APP}/Contents/MacOS/browxai-launcher`,
    );
    expect(appLauncherOf(plist({ CFBundleExecutable: "../../bin/sh" }).run, APP)).toBeUndefined();
    expect(appLauncherOf(plist({}).run, APP)).toBeUndefined();
  });

  it("names the wrapper the cask links onto PATH", () => {
    expect(appWrapperOf(APP)).toBe(`${APP}/Contents/Resources/bin/browxai`);
  });

  it("takes the socket from BROWX_SOCKET, and falls back to the app's default", () => {
    expect(appSocketPath({ BROWX_SOCKET: " /tmp/own.sock " }, "/Users/someone")).toBe(
      "/tmp/own.sock",
    );
    for (const env of [{}, { BROWX_SOCKET: "" }, { BROWX_SOCKET: "  " }]) {
      expect(appSocketPath(env, "/Users/someone")).toBe(
        "/Users/someone/Library/Application Support/Browxai/run/browxai.sock",
      );
    }
  });
});
