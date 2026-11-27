import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addVersion, tempRuntime, type TempRuntime } from "./__fixtures__/runtime-tree.js";
import { SHIM_TEXT, writeShim } from "./runtime-shim.js";
import { switchCurrent } from "./runtime-store.js";

// The launcher runs under whatever /bin/sh the machine has. Each shell found here
// runs every case: dash (Debian's /bin/sh), bash in POSIX mode, and /bin/sh.
const SHELLS: Array<{ name: string; argv: string[] }> = [
  { name: "dash", argv: ["dash"] },
  { name: "bash --posix", argv: ["bash", "--posix"] },
  { name: "/bin/sh", argv: ["/bin/sh"] },
].filter((s) => spawnSync("sh", ["-c", `command -v ${s.argv[0]}`]).status === 0);

const STUB = `const out = {
  argv: process.argv.slice(2),
  pid: process.pid,
  dir: process.env.BROWX_RUNTIME_DIR,
  version: process.env.BROWX_RUNTIME_VERSION,
};
process.stdout.write(JSON.stringify(out));
process.exit(Number(process.env.STUB_EXIT ?? 0));
`;

const NODE_DIR = dirname(process.execPath);
const BASE_ENV = { PATH: `${NODE_DIR}:/usr/bin:/bin`, HOME: "/nonexistent" };

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

function layout(dirName?: string): TempRuntime {
  rt = tempRuntime(dirName ? { dirName } : {});
  writeShim(rt.paths);
  writeFileSync(rt.paths.nodePath, process.execPath + "\n");
  addVersion(rt.paths, "1.2.3", STUB);
  switchCurrent(rt.paths, "1.2.3");
  return rt;
}

function launch(shell: string[], shim: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(shell[0]!, [...shell.slice(1), shim, ...args], {
    env: { ...BASE_ENV, ...env },
    encoding: "utf8",
  });
  return { status: r.status, pid: r.pid, stdout: r.stdout, stderr: r.stderr };
}

describe("the launcher text", () => {
  it("is written once with mode 0755 and left alone when unchanged", () => {
    rt = tempRuntime();
    expect(writeShim(rt.paths)).toBe(true);
    expect(statSync(rt.paths.shim).mode & 0o777).toBe(0o755);
    expect(readFileSync(rt.paths.shim, "utf8")).toBe(SHIM_TEXT);
    expect(writeShim(rt.paths)).toBe(false);
  });

  it("makes no network call and avoids readlink -f", () => {
    expect(SHIM_TEXT).not.toMatch(/curl|wget|npm|readlink -f|readlink -e|realpath/);
    expect(SHIM_TEXT.split("\n").length).toBeLessThanOrEqual(45);
  });
});

describe.each(SHELLS)("the launcher under $name", ({ argv: shell }) => {
  it("parses (sh -n)", () => {
    rt = tempRuntime();
    writeShim(rt.paths);
    expect(spawnSync(shell[0]!, [...shell.slice(1), "-n", rt.paths.shim]).status).toBe(0);
  });

  it.each([".browxai-runtime", "run time with spaces"])(
    "execs node on current's cli.js with every argument unchanged (%s)",
    (dirName) => {
      const { paths } = layout(dirName);
      const args = ["a b", "", "it's", '"q"', "-x", "--", "$HOME", "*", "--dir=/x y"];
      const r = launch(shell, paths.shim, args);
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout) as {
        argv: string[];
        pid: number;
        dir: string;
        version: string;
      };
      expect(out.argv).toEqual(args);
      expect(out.pid).toBe(r.pid);
      expect(out.dir).toBe(realpathSync(paths.root));
      expect(out.version).toBe("1.2.3");
    },
  );

  it("passes the server's exit code through", () => {
    const { paths } = layout();
    expect(launch(shell, paths.shim, [], { STUB_EXIT: "7" }).status).toBe(7);
  });

  it("resolves current once per start, so a switch reaches the next start", () => {
    const { paths } = layout();
    addVersion(paths, "1.3.0", STUB);
    switchCurrent(paths, "1.3.0");
    expect(JSON.parse(launch(shell, paths.shim, []).stdout)).toMatchObject({ version: "1.3.0" });
  });

  it("prefers BROWX_RUNTIME_NODE, then node-path, then node on PATH", () => {
    const { paths } = layout();
    writeFileSync(paths.nodePath, "/nonexistent/node\n");
    expect(launch(shell, paths.shim, []).status).toBe(0);
    const viaEnv = launch(shell, paths.shim, [], {
      PATH: "/usr/bin:/bin",
      BROWX_RUNTIME_NODE: process.execPath,
    });
    expect(viaEnv.status).toBe(0);
  });

  it.runIf(!existsSync("/usr/bin/node") && !existsSync("/bin/node"))(
    "says so when no node is found",
    () => {
      const { paths } = layout();
      writeFileSync(paths.nodePath, "/nonexistent/node\n");
      const r = launch(shell, paths.shim, [], { PATH: "/usr/bin:/bin" });
      expect(r.status).toBe(127);
      expect(r.stderr).toBe("browxai: no node found. Set BROWX_RUNTIME_NODE.\n");
    },
  );

  it.each([
    ["an absolute symlink", (shim: string) => shim],
    ["a relative symlink", (shim: string, dir: string) => relative(dir, shim)],
  ])("runs the runtime's version when started through %s to the launcher", (_label, target) => {
    const { paths, home } = layout("run time with spaces");
    const bin = join(home, "user bin");
    mkdirSync(bin);
    const link = join(bin, "browxai");
    symlinkSync(target(paths.shim, bin), link);
    const r = launch(shell, link, ["a b", ""]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { argv: string[]; dir: string; version: string };
    expect(out.argv).toEqual(["a b", ""]);
    expect(out.dir).toBe(realpathSync(paths.root));
    expect(out.version).toBe("1.2.3");
  });

  it("follows a chain of symlinks to the launcher", () => {
    const { paths, home } = layout();
    const first = join(home, "first");
    const second = join(home, "second");
    symlinkSync(paths.shim, first);
    symlinkSync(first, second);
    const r = launch(shell, second, []);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ dir: realpathSync(paths.root) });
  });

  it("says so when there is no current version", () => {
    rt = tempRuntime();
    writeShim(rt.paths);
    const r = launch(shell, rt.paths.shim, []);
    expect(r.status).toBe(127);
    expect(r.stderr).toBe(
      `browxai: no current version in ${realpathSync(rt.paths.root)}. Run: browxai runtime install\n`,
    );
  });

  it("says so when current's cli.js is missing", () => {
    rt = tempRuntime();
    writeShim(rt.paths);
    mkdirSync(join(rt.paths.versions, "9.9.9"));
    symlinkSync("versions/9.9.9", rt.paths.current);
    const cli = join(realpathSync(rt.paths.versions), "9.9.9", "node_modules/browxai/dist/cli.js");
    const r = launch(shell, rt.paths.shim, []);
    expect(r.status).toBe(127);
    const root = realpathSync(rt.paths.root);
    expect(r.stderr).toBe(
      `browxai: ${cli} is missing. Run: ${root}/bin/browxai runtime rollback\n`,
    );
  });
});
