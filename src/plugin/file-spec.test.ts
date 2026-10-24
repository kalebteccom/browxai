import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { runPlugin } from "./cli.js";
import { parseFileSpec } from "./file-spec.js";

const pmCalls = vi.hoisted(() => [] as Array<{ op: string; target: string | undefined }>);

// The install path shells out to pnpm/npm; the stub records what the CLI hands
// it and reports success, so the plugins.json write is what gets checked.
vi.mock("./pm-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pm-runner.js")>()),
  runPm: (_paths: unknown, op: string, target?: string) => {
    pmCalls.push({ op, target });
    return Promise.resolve(0);
  },
}));

let root: string;
let pluginDir: string;
let workspaceRoot: string;
let originalWorkspace: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "browxai-file-spec-")));
  pluginDir = join(root, "packages", "plugins", "figma");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, "package.json"),
    JSON.stringify({ name: "@browxai/plugin-figma", version: "1.2.3" }),
  );
  workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot);
  originalWorkspace = process.env.BROWX_WORKSPACE;
  process.env.BROWX_WORKSPACE = workspaceRoot;
  pmCalls.length = 0;
});

afterEach(() => {
  if (originalWorkspace === undefined) delete process.env.BROWX_WORKSPACE;
  else process.env.BROWX_WORKSPACE = originalWorkspace;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("parseFileSpec", () => {
  it("ignores specs that are not file: specs", () => {
    expect(parseFileSpec("@browxai/plugin-figma@^0.1.0", root)).toBeUndefined();
    expect(parseFileSpec("some-package", root)).toBeUndefined();
  });

  it("reads the package name from package.json, not the directory name", () => {
    const parsed = parseFileSpec(`file:${pluginDir}`, root);
    expect(parsed).toEqual({
      ok: true,
      spec: `file:${pluginDir}`,
      dir: pluginDir,
      name: "@browxai/plugin-figma",
    });
  });

  it("resolves a relative path against the given working directory", () => {
    const parsed = parseFileSpec("file:./packages/plugins/figma", root);
    expect(parsed).toMatchObject({ ok: true, dir: pluginDir, spec: `file:${pluginDir}` });
    const up = parseFileSpec("file:../figma/", join(root, "packages", "plugins", "other"));
    expect(up).toMatchObject({ ok: true, dir: pluginDir });
  });

  it("reports a missing directory, bad JSON and a missing name", () => {
    expect(parseFileSpec("file:", root)).toMatchObject({ ok: false });
    expect(parseFileSpec("file:./nope", root)).toMatchObject({
      ok: false,
      error: expect.stringContaining("no package.json") as unknown,
    });
    const bad = join(root, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "package.json"), "{ nope");
    expect(parseFileSpec(`file:${bad}`, root)).toMatchObject({
      ok: false,
      error: expect.stringContaining("not valid JSON") as unknown,
    });
    const anon = join(root, "anon");
    mkdirSync(anon);
    writeFileSync(join(anon, "package.json"), JSON.stringify({ version: "1.0.0" }));
    expect(parseFileSpec(`file:${anon}`, root)).toMatchObject({
      ok: false,
      error: expect.stringContaining('no "name"') as unknown,
    });
  });
});

describe("browxai plugin install file:<dir>", () => {
  const declared = (): Record<string, unknown> =>
    (
      JSON.parse(readFileSync(join(workspaceRoot, "plugins.json"), "utf8")) as {
        plugins: Record<string, unknown>;
      }
    ).plugins;

  it.each([
    {
      label: "records the package name and hands the package manager an absolute path",
      specPath: () => pluginDir,
    },
    {
      label: "resolves a relative path from the working directory, not the install dir",
      specPath: () => relative(process.cwd(), pluginDir),
    },
  ])("$label", async ({ specPath }) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runPlugin(["install", `file:${specPath()}`]);
    expect(code).toBe(0);
    expect(pmCalls).toEqual([{ op: "add", target: `file:${pluginDir}` }]);
    expect(Object.keys(declared())).toEqual(["@browxai/plugin-figma"]);
  });

  it("fails before running the package manager when the directory has no package.json", async () => {
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runPlugin(["install", `file:${join(root, "missing")}`]);
    expect(code).toBe(1);
    expect(pmCalls).toEqual([]);
    expect(String(err.mock.calls[0]?.[0])).toContain("no package.json");
  });
});
