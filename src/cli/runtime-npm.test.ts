import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeNpm } from "./__fixtures__/runtime-tree.js";
import type { RunResult } from "./runtime-exec.js";
import {
  auditSignatures,
  beforeFor,
  findNpmCli,
  npmEnv,
  npmInstall,
  npmRegistry,
  parseView,
  type NpmContext,
} from "./runtime-npm.js";

const NODE = "/opt/node/bin/node";
const NPM_CLI = "/opt/node/lib/node_modules/npm/bin/npm-cli.js";

const done = (status: number | null, stdout = "", stderr = "", error?: string): RunResult => ({
  status,
  stdout,
  stderr,
  ...(error ? { error } : {}),
});

describe("findNpmCli", () => {
  it("finds npm-cli.js beside the node install", () => {
    expect(findNpmCli(NODE, (p) => p === NPM_CLI)).toBe(NPM_CLI);
  });

  it("finds a Homebrew keg's libexec copy", () => {
    const keg = "/opt/node/libexec/lib/node_modules/npm/bin/npm-cli.js";
    expect(findNpmCli(NODE, (p) => p === keg)).toBe(keg);
  });

  it("is undefined when there is none", () => {
    expect(findNpmCli(NODE, () => false)).toBeUndefined();
  });
});

describe("findNpmCli on fake install layouts", () => {
  // Real directories and symlinks under a temp root, shaped like each node
  // installer lays them out. Each `node` is an empty file: findNpmCli reads paths only.
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bx-node-layout-")));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function file(path: string): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    return path;
  }
  const npmCliUnder = (prefix: string) =>
    join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");

  it("Homebrew formula: bin/node links into the Cellar, npm sits in the prefix's lib", () => {
    const brew = join(root, "homebrew");
    const cellar = join(brew, "Cellar", "node", "23.3.0");
    file(join(cellar, "bin", "node"));
    mkdirSync(join(brew, "bin"), { recursive: true });
    symlinkSync("../Cellar/node/23.3.0/bin/node", join(brew, "bin", "node"));
    const cli = file(npmCliUnder(brew));
    expect(findNpmCli(join(brew, "bin", "node"))).toBe(cli);
  });

  it("Homebrew formula: npm only in the keg's libexec, found through the node link's real path", () => {
    const brew = join(root, "homebrew");
    const cellar = join(brew, "Cellar", "node", "23.3.0");
    file(join(cellar, "bin", "node"));
    mkdirSync(join(brew, "bin"), { recursive: true });
    symlinkSync("../Cellar/node/23.3.0/bin/node", join(brew, "bin", "node"));
    const cli = file(join(cellar, "libexec", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
    expect(findNpmCli(join(brew, "bin", "node"))).toBe(cli);
  });

  it("Homebrew keg-only node@22: opt/node@22 links to the keg", () => {
    const brew = join(root, "homebrew");
    const keg = join(brew, "Cellar", "node@22", "22.11.0");
    file(join(keg, "bin", "node"));
    const cli = file(npmCliUnder(keg));
    mkdirSync(join(brew, "opt"), { recursive: true });
    symlinkSync("../Cellar/node@22/22.11.0", join(brew, "opt", "node@22"));
    expect(realpathSync(findNpmCli(join(brew, "opt", "node@22", "bin", "node"))!)).toBe(cli);
  });

  it("mise: the install directory of the version, also through a version alias link", () => {
    const installs = join(root, "mise", "installs", "node");
    const prefix = join(installs, "22.11.0");
    file(join(prefix, "bin", "node"));
    const cli = file(npmCliUnder(prefix));
    expect(findNpmCli(join(prefix, "bin", "node"))).toBe(cli);
    symlinkSync("22.11.0", join(installs, "22"));
    expect(realpathSync(findNpmCli(join(installs, "22", "bin", "node"))!)).toBe(cli);
  });

  it("mise shim: a link to the mise binary has no npm beside it, so install asks for a real node", () => {
    const miseBin = file(join(root, "bin", "mise"));
    const shims = join(root, "mise", "shims");
    mkdirSync(shims, { recursive: true });
    symlinkSync(miseBin, join(shims, "node"));
    expect(findNpmCli(join(shims, "node"))).toBeUndefined();
  });

  it("nvm: the version directory", () => {
    const prefix = join(root, "nvm", "versions", "node", "v22.11.0");
    file(join(prefix, "bin", "node"));
    const cli = file(npmCliUnder(prefix));
    expect(findNpmCli(join(prefix, "bin", "node"))).toBe(cli);
  });

  it("a recorded node that a version manager pruned", () => {
    expect(findNpmCli(join(root, "gone", "bin", "node"))).toBeUndefined();
  });
});

describe("how npm runs", () => {
  const npm = (run = fakeNpm()): NpmContext => ({
    node: NODE,
    npmCli: NPM_CLI,
    run,
    env: { PATH: "/usr/bin" },
  });

  it("runs as <node-path> <npm-cli.js>, with that node's directory first on PATH", async () => {
    const run = fakeNpm();
    const prefix = mkdtempSync(join(tmpdir(), "bx-npm-"));
    await npmInstall(npm(run), prefix, "0.22.0", "2026-11-26T17:29:27.814Z");
    rmSync(prefix, { recursive: true, force: true });
    expect(run.calls).toEqual([
      {
        file: NODE,
        args: [
          NPM_CLI,
          "install",
          "--prefix",
          prefix,
          "browxai@0.22.0",
          "--save-exact",
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--before",
          "2026-11-26T17:29:27.814Z",
          "--no-update-notifier",
        ],
      },
    ]);
    expect(npmEnv({ node: NODE, env: { PATH: "/usr/bin" } }).PATH).toBe(`/opt/node/bin:/usr/bin`);
  });

  it("views browxai@<spec> as JSON", async () => {
    const calls: string[][] = [];
    const registry = npmRegistry({
      ...npm(),
      run: (file, args) => {
        calls.push([file, ...args]);
        return Promise.resolve(done(0, JSON.stringify({ version: "0.22.0", time: {} })));
      },
    });
    await registry.view("latest");
    expect(calls).toEqual([
      [NODE, NPM_CLI, "view", "browxai@latest", "--json", "--no-update-notifier"],
    ]);
  });

  it("passes npm audit signatures on exit 0, and fails on anything else", async () => {
    await expect(auditSignatures(npm(fakeNpm()), "/p")).resolves.toEqual({
      ok: true,
      detail: "npm audit signatures passed, 0 invalid, 0 missing",
    });
    await expect(auditSignatures(npm(fakeNpm({ audit: 1 })), "/p")).resolves.toEqual({
      ok: false,
      detail: "npm audit signatures failed (exit 1, 1 invalid, 0 missing)",
    });
  });
});

describe("parseView", () => {
  const doc = {
    version: "0.22.0",
    time: { "0.22.0": "2026-11-26T16:29:27.814Z" },
    dist: { integrity: "sha512-x" },
  };

  it("reads the version, its publish time and its integrity", () => {
    expect(parseView(done(0, JSON.stringify(doc)), "latest")).toEqual({
      ok: true,
      info: { version: "0.22.0", publishedAt: "2026-11-26T16:29:27.814Z", integrity: "sha512-x" },
    });
  });

  it("takes the last entry of an array and reads a deprecation", () => {
    const r = parseView(
      done(0, JSON.stringify([{ version: "0.1.0" }, { ...doc, deprecated: "Use 0.23.0" }])),
      "x",
    );
    expect(r).toMatchObject({ ok: true, info: { version: "0.22.0", deprecated: "Use 0.23.0" } });
  });

  it("says when the version doesn't exist", () => {
    const e404 = JSON.stringify({
      error: { code: "E404", summary: "No match found for version 9.9.9" },
    });
    expect(parseView(done(1, e404, "npm error code E404\n"), "9.9.9")).toEqual({
      ok: false,
      unreachable: false,
      message: "npm view browxai@9.9.9 failed (E404: No match found for version 9.9.9)",
    });
    expect(parseView(done(0, ""), "9.9.9")).toMatchObject({ ok: false, unreachable: false });
  });

  it("calls a network error or a timeout unreachable", () => {
    expect(parseView(done(1, "", "npm error code ENOTFOUND\n"), "latest")).toMatchObject({
      ok: false,
      unreachable: true,
    });
    expect(parseView(done(null, "", "", "npm ran past 60000 ms"), "latest")).toMatchObject({
      unreachable: true,
    });
  });

  it("refuses a version string that isn't exact semver", () => {
    expect(parseView(done(0, JSON.stringify({ version: "../x" })), "latest")).toMatchObject({
      ok: false,
    });
  });
});

describe("beforeFor", () => {
  it("is the publish time plus one hour", () => {
    expect(beforeFor("2026-11-26T16:29:27.814Z")).toBe("2026-11-26T17:29:27.814Z");
    expect(beforeFor("not a date")).toBeUndefined();
  });
});
