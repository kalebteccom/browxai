import { describe, expect, it } from "vitest";
import {
  appBundleOf,
  macosAppRow,
  MACOS_APP_BUNDLE_ID,
  parseSignature,
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "./doctor-macos-app.js";
import { formatDoctor } from "./doctor-summary.js";

const APP = "/Applications/Browxai.app";
const NODE = `${APP}/Contents/Resources/node/bin/node`;
const LAUNCHER = `${APP}/Contents/MacOS/browxai-launcher`;

const done = (status: number | null, stdout = "", stderr = ""): CommandResult => ({
  status,
  stdout,
  stderr,
});

/** What `codesign -dv --verbose=4` prints for a Developer ID build. */
const SIGNED = [
  `Executable=${LAUNCHER}`,
  "Identifier=com.kalebtec.browxai",
  "Format=app bundle with Mach-O thin (arm64)",
  "CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded",
  "Signature size=9000",
  "Authority=Developer ID Application: Some Org (ABCDE12345)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "Timestamp=23 Nov 2026 at 10:00:00",
  "TeamIdentifier=ABCDE12345",
  "Sealed Resources version=2 rules=13 files=2000",
].join("\n");

const NO_RUNTIME = SIGNED.replace("flags=0x10000(runtime)", "flags=0x0(none)");
const ADHOC = [
  "Identifier=com.kalebtec.browxai",
  "CodeDirectory v=20400 size=900 flags=0x2(adhoc) hashes=30+7 location=embedded",
  "Signature=adhoc",
  "TeamIdentifier=not set",
].join("\n");

interface Setup {
  bundleId?: string | null;
  executable?: string | null;
  codesign?: CommandResult;
  verify?: CommandResult;
  login?: CommandResult;
}

/** A fake runner that answers the four commands the row runs, and records every call. */
function fake(s: Setup = {}): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const bundleId = s.bundleId === undefined ? MACOS_APP_BUNDLE_ID : s.bundleId;
  const executable = s.executable === undefined ? "browxai-launcher" : s.executable;
  const run: CommandRunner = (file, args) => {
    calls.push([file, ...args].join(" "));
    if (file === "/usr/bin/plutil") {
      const key = args[1];
      const value = key === "CFBundleIdentifier" ? bundleId : executable;
      return value === null ? done(1, "", "no such key") : done(0, `${value}\n`);
    }
    if (file === "/usr/bin/codesign" && args[0] === "-dv") {
      return s.codesign ?? done(0, "", SIGNED);
    }
    if (file === "/usr/bin/codesign" && args[0] === "--verify") return s.verify ?? done(0);
    if (file === LAUNCHER) return s.login ?? done(1, "", "unknown command");
    return done(127, "", "not found");
  };
  return { run, calls };
}

const row = (s: Setup = {}) =>
  macosAppRow({ platform: "darwin", execPath: NODE, run: fake(s).run });

describe("macosAppRow", () => {
  it("returns no row off macOS and runs nothing", () => {
    const { run, calls } = fake();
    for (const platform of ["linux", "win32"] as const) {
      expect(macosAppRow({ platform, execPath: NODE, run })).toBeUndefined();
    }
    expect(calls).toEqual([]);
  });

  it("says so, without failing, when node runs from npm or a source checkout", () => {
    const { run, calls } = fake();
    const r = macosAppRow({
      platform: "darwin",
      execPath: "/opt/homebrew/bin/node",
      run,
    });
    expect(r).toEqual({
      name: "macos-app",
      ok: true,
      info: true,
      detail:
        "not running from the signed Browxai app. Permission grants then attach to the launching terminal or MCP client.",
    });
    expect(calls).toEqual([]);
  });

  it("treats node inside another app bundle as not the Browxai app", () => {
    const { run } = fake({ bundleId: "com.example.editor" });
    const r = macosAppRow({
      platform: "darwin",
      execPath: "/Applications/Editor.app/Contents/Frameworks/node",
      run,
    });
    expect(r?.info).toBe(true);
    expect(r?.detail).toMatch(/^not running from the signed Browxai app/);
  });

  it("treats an Info.plist that plutil cannot read as not the Browxai app", () => {
    const r = row({ bundleId: null });
    expect(r?.info).toBe(true);
    expect(r?.detail).toMatch(/^not running from the signed Browxai app/);
  });

  it("reports a signed, verified app with the hardened runtime on, as information", () => {
    const r = row();
    expect(r).toEqual({
      name: "macos-app",
      ok: true,
      info: true,
      detail: `inside the app at ${APP}: signed, identifier com.kalebtec.browxai, team ABCDE12345, hardened runtime on, signature verifies`,
    });
  });

  it("runs codesign -dv --verbose=4 and codesign --verify --strict on the bundle", () => {
    const { run, calls } = fake();
    macosAppRow({ platform: "darwin", execPath: NODE, run });
    expect(calls).toContain(`/usr/bin/codesign -dv --verbose=4 ${APP}`);
    expect(calls).toContain(`/usr/bin/codesign --verify --strict ${APP}`);
  });

  it("never prints a certificate name", () => {
    const r = row();
    expect(JSON.stringify(r)).not.toContain("Some Org");
    expect(JSON.stringify(r)).not.toContain("Developer ID");
  });

  it("warns, with a fix, when the app is not signed at all", () => {
    const r = row({
      codesign: done(1, "", `${APP}: code object is not signed at all\n`),
    });
    expect(r?.ok).toBe(true);
    expect(r?.info).toBeUndefined();
    expect(r?.warn).toBe(true);
    expect(r?.detail).toBe(`inside the app at ${APP}: not signed`);
    expect(r?.fix).toContain("install the release build");
  });

  it("warns when the signature does not verify, and shows why without the path", () => {
    const r = row({
      verify: done(1, "", `${APP}: a sealed resource is missing or invalid\nfile modified: x\n`),
    });
    expect(r?.ok).toBe(true);
    expect(r?.warn).toBe(true);
    expect(r?.detail).toContain(
      "signature does not verify (a sealed resource is missing or invalid)",
    );
    expect(r?.detail).not.toContain(`${APP}: a sealed`);
    expect(r?.fix).toContain("changed after it was signed");
  });

  it("warns when the hardened runtime is off", () => {
    const r = row({ codesign: done(0, "", NO_RUNTIME) });
    expect(r?.warn).toBe(true);
    expect(r?.detail).toContain("hardened runtime off");
    expect(r?.fix).toContain("hardened runtime");
  });

  it("warns on an ad hoc signature, which has no team", () => {
    const r = row({ codesign: done(0, "", ADHOC) });
    expect(r?.warn).toBe(true);
    expect(r?.detail).toContain("signed ad hoc, identifier com.kalebtec.browxai, no team id");
    expect(r?.fix).toContain("asks for permissions again after an update");
  });

  it("stays informational when codesign cannot run", () => {
    const r = row({ codesign: done(null) });
    expect(r?.ok).toBe(true);
    expect(r?.info).toBe(true);
    expect(r?.warn).toBeUndefined();
    expect(r?.detail).toContain("could not read the signature");
  });

  it("does not call a check that did not run a failure", () => {
    const r = row({ verify: done(null) });
    expect(r?.info).toBe(true);
    expect(r?.detail).toContain("signature check did not run");
  });

  describe("login agent", () => {
    it.each([
      ["enabled", "login agent registered"],
      ["registered", "login agent registered"],
      ["not registered", "login agent not registered"],
      ["notRegistered", "login agent not registered"],
      ["requires approval", "login agent waits for approval in System Settings, Login Items"],
      ["not found", "login agent not found in the app"],
      ["something else", "login agent status unknown"],
    ])("reads %s from the launcher", (out, shown) => {
      const { run, calls } = fake({ login: done(0, `${out}\n`) });
      const r = macosAppRow({ platform: "darwin", execPath: NODE, run });
      expect(calls).toContain(`${LAUNCHER} login-item status`);
      expect(r?.detail.endsWith(`signature verifies, ${shown}`)).toBe(true);
      expect(r?.info).toBe(true);
    });

    it("says nothing when the launcher has no login-item command", () => {
      const r = row({ login: done(2, "", "usage: ...") });
      expect(r?.detail).not.toContain("login agent");
    });

    it("says nothing when the launcher name cannot be read", () => {
      const { run, calls } = fake({ executable: null });
      const r = macosAppRow({ platform: "darwin", execPath: NODE, run });
      expect(r?.detail).not.toContain("login agent");
      expect(calls.some((c) => c.includes("login-item"))).toBe(false);
    });

    it("never runs a launcher name that points out of the bundle", () => {
      const { run, calls } = fake({ executable: "../../bin/sh" });
      macosAppRow({ platform: "darwin", execPath: NODE, run });
      expect(calls.some((c) => c.includes("login-item"))).toBe(false);
    });
  });

  it("is never a failing row, whatever the signature says", () => {
    const setups: Setup[] = [
      {},
      { codesign: done(1, "", "code object is not signed at all") },
      { codesign: done(0, "", ADHOC) },
      { codesign: done(null) },
      { verify: done(1, "", "bad") },
    ];
    for (const s of setups) expect(row(s)?.ok).toBe(true);
  });
});

describe("appBundleOf", () => {
  it("finds the outer .app that holds the path", () => {
    expect(appBundleOf(NODE)).toBe(APP);
    expect(appBundleOf("/Users/me/Applications/My App.app/Contents/MacOS/x")).toBe(
      "/Users/me/Applications/My App.app",
    );
  });

  it("finds nothing for a path outside any bundle", () => {
    expect(appBundleOf("/usr/local/bin/node")).toBeUndefined();
    expect(appBundleOf("/tmp/foo.app/bin/node")).toBeUndefined();
  });
});

describe("parseSignature", () => {
  it("reads the identifier, team and hardened runtime from a Developer ID build", () => {
    expect(parseSignature(SIGNED)).toEqual({
      identifier: "com.kalebtec.browxai",
      team: "ABCDE12345",
      adhoc: false,
      runtime: true,
    });
  });

  it("reads an ad hoc build as having no team", () => {
    expect(parseSignature(ADHOC)).toEqual({
      identifier: "com.kalebtec.browxai",
      adhoc: true,
      runtime: false,
    });
  });

  it("finds runtime among several flags", () => {
    const text = "CodeDirectory v=20500 size=1 flags=0x10002(adhoc,runtime) hashes=1";
    expect(parseSignature(text)).toMatchObject({ adhoc: true, runtime: true });
  });
});

describe("macos-app row in the doctor output", () => {
  const base = [{ name: "node", ok: true, detail: "v22.1.0" }];
  const opts = { verbose: false, version: "9.9.9" };

  it("keeps an informational row out of the short summary", () => {
    const info = row();
    const { text, allOk } = formatDoctor([...base, ...(info ? [info] : [])], opts);
    expect(allOk).toBe(true);
    expect(text).not.toContain("macos-app");
  });

  it("shows a warning in the short summary with its next step, and does not fail", () => {
    const warn = row({ codesign: done(1, "", "code object is not signed at all") });
    const { text, allOk } = formatDoctor([...base, ...(warn ? [warn] : [])], opts);
    expect(allOk).toBe(true);
    expect(text).toMatch(
      /⚠ macos-app +inside the app at .*: not signed\n {4}next: install the release build/,
    );
    expect(text).toContain("Nothing failed, but read the ⚠ above.");
  });

  it("always shows the row with --verbose", () => {
    const info = row();
    const { text } = formatDoctor([...base, ...(info ? [info] : [])], { ...opts, verbose: true });
    expect(text).toContain("  − macos-app");
    expect(text).toContain("hardened runtime on");
  });
});

describe("runCommand", () => {
  it("runs a program with an argument list and returns its output", () => {
    const r = runCommand(process.execPath, ["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^v\d+\./);
  });

  it("returns a null status for a program that does not exist", () => {
    const r = runCommand("/nonexistent/browxai-test-binary", []);
    expect(r.status).toBeNull();
    expect(r.stdout).toBe("");
  });
});
