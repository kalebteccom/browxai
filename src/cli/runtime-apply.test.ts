import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addVersion,
  fakeNpm,
  fakeRegistry,
  tempRuntime,
  type TempRuntime,
} from "./__fixtures__/runtime-tree.js";
import { releasedInfo } from "./__fixtures__/provenance.js";
import { applyVersion, selectVersion, type ApplyDeps } from "./runtime-apply.js";
import { cliOf, versionDir } from "./runtime-layout.js";
import type { SmokeResult } from "./runtime-smoke.js";
import { readCurrent, readState, switchCurrent, writeState } from "./runtime-store.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

const VERSIONS = {
  "0.21.0": {},
  "0.22.0": { publishedAt: "2026-11-26T16:29:27.814Z" },
  "0.23.0": { deprecated: "Use 0.23.1" },
};

function setup(current?: string): TempRuntime {
  rt = tempRuntime();
  if (current) {
    addVersion(rt.paths, current);
    switchCurrent(rt.paths, current);
  }
  return rt;
}

function deps(
  over: Partial<ApplyDeps> & { npmRun?: ReturnType<typeof fakeNpm> } = {},
): ApplyDeps & { log: string[] } {
  const log: string[] = [];
  return {
    registry: fakeRegistry(VERSIONS, { latest: "0.22.0" }),
    npm: {
      node: "/usr/bin/node",
      npmCli: "/usr/lib/npm-cli.js",
      run: over.npmRun ?? fakeNpm(),
      env: {},
    },
    smoke: () => Promise.resolve<SmokeResult>({ ok: true, notes: [] }),
    out: (l) => log.push(l),
    pid: 4242,
    log,
    ...over,
  };
}

describe("selectVersion", () => {
  it("takes the channel's version when it is newer than current", async () => {
    const { paths } = setup("0.21.0");
    const s = await selectVersion(paths, fakeRegistry(VERSIONS, { latest: "0.22.0" }), {
      channel: "latest",
    });
    expect(s).toMatchObject({
      kind: "apply",
      info: { version: "0.22.0" },
      current: "0.21.0",
      warnings: [],
    });
  });

  it("does nothing when current is the newest", async () => {
    const { paths } = setup("0.22.0");
    const s = await selectVersion(paths, fakeRegistry(VERSIONS, { latest: "0.22.0" }), {
      channel: "latest",
    });
    expect(s).toEqual({
      kind: "none",
      message: "current is 0.22.0, and the latest channel has 0.22.0. Nothing to do.",
    });
  });

  it("skips a deprecated channel version", async () => {
    const { paths } = setup("0.22.0");
    const s = await selectVersion(paths, fakeRegistry(VERSIONS, { latest: "0.23.0" }), {
      channel: "latest",
    });
    expect(s).toMatchObject({ kind: "none", message: expect.stringContaining("is deprecated") });
  });

  it("applies a named version up or down, warning on a downgrade", async () => {
    const { paths } = setup("0.22.0");
    const s = await selectVersion(paths, fakeRegistry(VERSIONS, {}), {
      channel: "latest",
      version: "0.21.0",
    });
    expect(s).toMatchObject({ kind: "apply", warnings: ["0.21.0 is older than current 0.22.0"] });
  });

  it("returns exit code 3 when the registry can't be reached", async () => {
    const { paths } = setup();
    const s = await selectVersion(paths, fakeRegistry({}, {}, { unreachable: true }), {
      channel: "latest",
    });
    expect(s).toMatchObject({ kind: "error", code: 3 });
  });
});

describe("applyVersion", () => {
  it("stages, verifies, checks and switches, then records the previous version", async () => {
    const { paths } = setup("0.21.0");
    const npmRun = fakeNpm();
    const d = deps({ npmRun });
    const r = await applyVersion(paths, releasedInfo("0.22.0", "2026-11-26T16:29:27.814Z"), d);
    expect(r).toEqual({ ok: true, version: "0.22.0", previous: "0.21.0" });
    expect(readCurrent(paths)).toBe("0.22.0");
    expect(readState(paths).previous).toBe("0.21.0");
    expect(npmRun.calls[0]!.args).toContain("2026-11-26T17:29:27.814Z");
    expect(npmRun.calls[1]!.args.slice(1, 4)).toEqual(["audit", "signatures", "--json"]);
    const dir = versionDir(paths, "0.22.0");
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).toEqual({ private: true });
    expect(JSON.parse(readFileSync(join(dir, ".runtime-meta.json"), "utf8"))).toMatchObject({
      version: "0.22.0",
      publishedAt: "2026-11-26T16:29:27.814Z",
      verification:
        "npm audit signatures passed, 0 invalid, 0 missing; provenance names " +
        "https://github.com/kalebteccom/browxai/.github/workflows/release.yml@refs/tags/v0.22.0",
    });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readdirSync(paths.staging)).toEqual([]);
  });

  it("never writes a version directory that already exists: it switches to it", async () => {
    const { paths } = setup("0.22.0");
    addVersion(paths, "0.21.0");
    const before = readFileSync(cliOf(versionDir(paths, "0.21.0")), "utf8");
    const npmRun = fakeNpm();
    const r = await applyVersion(paths, { version: "0.21.0" }, deps({ npmRun }));
    expect(r).toMatchObject({ ok: true, version: "0.21.0", previous: "0.22.0" });
    expect(npmRun.calls).toEqual([]);
    expect(readFileSync(cliOf(versionDir(paths, "0.21.0")), "utf8")).toBe(before);
  });

  it("keeps current and counts the failure when npm install fails", async () => {
    const { paths } = setup("0.21.0");
    const r = await applyVersion(
      paths,
      releasedInfo("0.22.0", "2026-11-26T16:29:27.814Z"),
      deps({ npmRun: fakeNpm({ installStatus: 1 }) }),
    );
    expect(r).toEqual({ ok: false, reason: "npm install failed: npm error code E500" });
    expect(readCurrent(paths)).toBe("0.21.0");
    expect(readState(paths).failed).toEqual({ "0.22.0": 1 });
    expect(existsSync(versionDir(paths, "0.22.0"))).toBe(false);
    expect(readdirSync(paths.staging)).toEqual([]);
  });

  it("refuses a staged tree that holds another version", async () => {
    const { paths } = setup("0.21.0");
    const r = await applyVersion(
      paths,
      releasedInfo("0.22.0", "2026-11-26T16:29:27.814Z"),
      deps({ npmRun: fakeNpm({ installs: "0.22.1" }) }),
    );
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringContaining("holds 0.22.1, expected 0.22.0"),
    });
    expect(readCurrent(paths)).toBe("0.21.0");
  });

  it("holds a version that fails verification and never runs it", async () => {
    const { paths } = setup("0.21.0");
    let smoked = false;
    const d = deps({
      npmRun: fakeNpm({ audit: 1 }),
      smoke: () => {
        smoked = true;
        return Promise.resolve<SmokeResult>({ ok: true, notes: [] });
      },
    });
    const r = await applyVersion(paths, releasedInfo("0.22.0", "2026-11-26T16:29:27.814Z"), d);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("verification failed") });
    expect(smoked).toBe(false);
    expect(readState(paths).held).toEqual({ "0.22.0": "verification failed" });
    expect(readCurrent(paths)).toBe("0.21.0");
  });

  it("holds a version whose provenance names another repository, before the smoke check", async () => {
    const { paths } = setup("0.21.0");
    let smoked = false;
    const registry = fakeRegistry(
      { "0.22.0": { provenance: { repository: "https://github.com/someone/browxai-fork" } } },
      { latest: "0.22.0" },
    );
    const d = deps({
      registry,
      smoke: () => {
        smoked = true;
        return Promise.resolve<SmokeResult>({ ok: true, notes: [] });
      },
    });
    const r = await applyVersion(paths, releasedInfo("0.22.0", "2026-11-26T16:29:27.814Z"), d);
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /^verification failed: 0\.22\.0: its provenance names workflow\.repository "https:\/\/github\.com\/someone\/browxai-fork"/,
      ),
    });
    expect(registry.attestationReads).toHaveLength(1);
    expect(smoked).toBe(false);
    expect(readState(paths).held).toEqual({ "0.22.0": "verification failed" });
    expect(readCurrent(paths)).toBe("0.21.0");
    expect(existsSync(versionDir(paths, "0.22.0"))).toBe(false);
    expect(readdirSync(paths.staging)).toEqual([]);
  });

  it("holds a version the registry lists no attestation for", async () => {
    const { paths } = setup("0.21.0");
    const { attestationsUrl: _none, ...info } = releasedInfo("0.22.0", "2026-11-26T16:29:27.814Z");
    const r = await applyVersion(paths, info, deps());
    expect(r).toMatchObject({
      ok: false,
      reason: "verification failed: 0.22.0: the registry lists no provenance attestation for it",
    });
    expect(readState(paths).held).toEqual({ "0.22.0": "verification failed" });
  });

  it("counts an unreadable attestation as a failure it retries, with no hold", async () => {
    const { paths } = setup("0.21.0");
    const d = deps({
      registry: fakeRegistry({ "0.22.0": { provenance: "unreadable" } }, { latest: "0.22.0" }),
    });
    const r = await applyVersion(paths, releasedInfo("0.22.0", "2026-11-26T16:29:27.814Z"), d);
    expect(r).toMatchObject({
      ok: false,
      reason: expect.stringContaining("the provenance check couldn't run"),
    });
    expect(readState(paths).held).toBeUndefined();
    expect(readState(paths).failed).toEqual({ "0.22.0": 1 });
    expect(readCurrent(paths)).toBe("0.21.0");
  });

  it("keeps current when the smoke check fails, and current stays valid", async () => {
    const { paths } = setup("0.21.0");
    writeState(paths, { failed: { "0.22.0": 1 } });
    const d = deps({
      smoke: () =>
        Promise.resolve<SmokeResult>({ ok: false, reason: 'cli.js --version: printed "9"' }),
    });
    const r = await applyVersion(paths, releasedInfo("0.22.0", "2026-11-26T16:29:27.814Z"), d);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("smoke check failed") });
    expect(readState(paths).failed).toEqual({ "0.22.0": 2 });
    expect(readCurrent(paths)).toBe("0.21.0");
    expect(existsSync(cliOf(versionDir(paths, "0.21.0")))).toBe(true);
  });

  it("refuses a version with no publish time, since --before needs one", async () => {
    const { paths } = setup();
    const r = await applyVersion(paths, { version: "0.22.0" }, deps());
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("no publish time") });
  });

  it("refuses an incomplete version directory", async () => {
    const { paths } = setup("0.21.0");
    addVersion(paths, "0.22.0");
    writeFileSync(join(versionDir(paths, "0.22.0"), "x"), "");
    const { rmSync } = await import("node:fs");
    rmSync(cliOf(versionDir(paths, "0.22.0")));
    const r = await applyVersion(paths, { version: "0.22.0" }, deps());
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("has no cli.js") });
  });
});

describe("selectVersion on the next channel", () => {
  const guards = { allowMajor: false, engines: () => Promise.resolve(undefined) };

  it("takes a prerelease newer than latest", async () => {
    const { paths } = setup("0.22.0");
    const registry = fakeRegistry(
      { "0.22.0": {}, "0.23.0-next.1": {} },
      { latest: "0.22.0", next: "0.23.0-next.1" },
    );
    const s = await selectVersion(paths, registry, { channel: "next" }, guards);
    expect(s).toMatchObject({ kind: "apply", info: { version: "0.23.0-next.1" } });
  });

  it("moves a prerelease on to the release that passes it", async () => {
    const { paths } = setup("0.23.0-next.1");
    const registry = fakeRegistry(
      { "0.23.0-next.1": {}, "0.23.0": {} },
      { latest: "0.23.0", next: "0.23.0-next.1" },
    );
    const s = await selectVersion(paths, registry, { channel: "next" }, guards);
    expect(s).toMatchObject({ kind: "apply", info: { version: "0.23.0" } });
  });

  it("holds a prerelease of a new major version, as on latest", async () => {
    const { paths } = setup("1.4.0");
    const registry = fakeRegistry(
      { "1.4.0": {}, "2.0.0-next.1": {} },
      { latest: "1.4.0", next: "2.0.0-next.1" },
    );
    const s = await selectVersion(paths, registry, { channel: "next" }, guards);
    expect(s).toMatchObject({
      kind: "held",
      info: { version: "2.0.0-next.1" },
      reason: expect.stringContaining("a new major version (1.4.0 to 2.0.0-next.1)"),
    });
  });

  it("leaves a prerelease in place on latest until a newer release", async () => {
    const { paths } = setup("0.23.0-next.1");
    const registry = fakeRegistry(
      { "0.22.0": {}, "0.23.0-next.1": {} },
      { latest: "0.22.0", next: "0.23.0-next.1" },
    );
    const s = await selectVersion(paths, registry, { channel: "latest" }, guards);
    expect(s).toEqual({
      kind: "none",
      message: "current is 0.23.0-next.1, and the latest channel has 0.22.0. Nothing to do.",
    });
  });
});
