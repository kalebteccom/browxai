// Runtime keystone (RFC 0015, test 4): `browxai runtime install`, `update`, `gc`,
// `rollback` and the background job's one-shot run, `update --auto`, against a
// loopback npm registry, with real npm, the real launcher and real processes. No
// browser, and no launchd or systemd: the job itself is a fake here, and its
// unit files are tested in src/cli/runtime-agent.test.ts.
//
// The packages are small stand-ins named `browxai`, packed with `npm pack`: each
// `dist/cli.js` answers `--version`, `doctor --json` and an MCP handshake with its
// own version, and loads `dist/lazy.js` only on `tools/list`, the way browxai loads
// code lazily. The registry serves their packuments (with `time`, `dist-tags` and
// `deprecated`) and tarballs, and each version's provenance attestations for the
// real tarball's sha512, so the provenance pin runs over HTTP as it does against
// npm. It can't sign, so `npm audit signatures` is replaced by a stub here; its
// runner contract is unit-tested in src/cli/runtime-npm.test.ts.
//
// Steps: install gets A; a server started through the launcher stays up on A; B,
// E and F are published and applied in turn; a new start runs the newest; the A
// server still answers `tools/list` as A after a forced gc that kept A because it
// is in use; rollback goes back one version; a C whose `--version` lies fails the
// smoke check and never becomes current; a deprecated D is skipped; once the A
// server exits, gc removes A. Then `update --auto`, on a clock the test moves:
// the first run after a boot waits; the next applies a version published two
// days earlier; a version whose updater can't start fails smoke step 4 and
// `current` stays; with the registry gone the run exits 0 and backs off.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { attestationsDoc } from "../../src/cli/__fixtures__/provenance.js";
import { fakeAgent, testUid } from "../../src/cli/__fixtures__/runtime-tree.js";
import type { AutoClock } from "../../src/cli/runtime-auto.js";
import { readJournal } from "../../src/cli/runtime-journal.js";
import { runtimePaths, versionDir } from "../../src/cli/runtime-layout.js";
import { findNpmCli } from "../../src/cli/runtime-npm.js";
import { SLSA_PROVENANCE_V1 } from "../../src/cli/runtime-provenance.js";
import { readCurrent, readState } from "../../src/cli/runtime-store.js";
import { runRuntime } from "../../src/cli/runtime.js";
import { gatedDescribe, hostGate } from "./keystone-gate.js";

const STEP_TIMEOUT = 120_000;
const HOUR = 60 * 60 * 1000;
const NPM_CLI = findNpmCli(process.execPath);
const describeRuntime = gatedDescribe(
  hostGate(
    process.platform !== "win32" && NPM_CLI !== undefined && existsSync("/bin/sh"),
    "needs a POSIX /bin/sh and npm-cli.js next to the node running the tests",
  ),
);

const STUB = (version: string, says: string, noUpdater = false) => `#!/usr/bin/env node
"use strict";
const V = ${JSON.stringify(version)};
const argv = process.argv.slice(2);
if (argv[0] === "--version") {
  process.stdout.write(${JSON.stringify(says)} + "\\n");
  process.exit(0);
}
if (argv[0] === "runtime" && argv[1] === "status" && argv[2] === "--json") {
  if (${JSON.stringify(noUpdater)}) process.exit(2);
  process.stdout.write(JSON.stringify({ dir: process.env.BROWX_RUNTIME_DIR, layout: "absent" }) + "\\n");
  process.exit(0);
}
if (argv[0] === "doctor" && argv[1] === "--json") {
  process.stdout.write(JSON.stringify({ version: V, ok: true, checks: [{ name: "node", ok: true, detail: "" }] }) + "\\n");
  process.exit(0);
}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "browxai", version: V } } });
    } else if (msg.method === "tools/list") {
      const lazy = require("./lazy.js");
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "snapshot", description: "served by " + lazy.version, inputSchema: { type: "object" } }] } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

interface Published {
  tgz: string;
  integrity: string;
  shasum: string;
  time: string;
  deprecated?: string;
}

let tmp: string;
let home: string;
let server: Server;
let base: string;
let npmEnv: NodeJS.ProcessEnv;
let held: ChildProcessWithoutNullStreams | undefined;
const published = new Map<string, Published>();
const tags: Record<string, string> = {};

function packument(): object {
  const versions: Record<string, object> = {};
  const time: Record<string, string> = {
    created: "2026-01-01T00:00:00.000Z",
    modified: new Date().toISOString(),
  };
  for (const [v, p] of published) {
    versions[v] = {
      name: "browxai",
      version: v,
      dist: {
        tarball: `${base}browxai/-/browxai-${v}.tgz`,
        integrity: p.integrity,
        shasum: p.shasum,
        attestations: {
          url: `${base}-/npm/v1/attestations/browxai@${v}`,
          provenance: { predicateType: SLSA_PROVENANCE_V1 },
        },
      },
      ...(p.deprecated ? { deprecated: p.deprecated } : {}),
    };
    time[v] = p.time;
  }
  return { name: "browxai", "dist-tags": tags, versions, time };
}

/** Pack a stand-in browxai at `version` whose `--version` prints `says`, and
 *  publish it on the loopback registry under the `latest` tag. */
function publish(
  version: string,
  opts: { says?: string; deprecated?: string; time?: string; noUpdater?: boolean } = {},
): void {
  const pkg = join(tmp, "src", version);
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ name: "browxai", version, files: ["dist"] }),
  );
  writeFileSync(
    join(pkg, "dist", "cli.js"),
    STUB(version, opts.says ?? version, opts.noUpdater ?? false),
  );
  writeFileSync(
    join(pkg, "dist", "lazy.js"),
    `module.exports = { version: ${JSON.stringify(version)} };\n`,
  );
  const dest = join(tmp, "tarballs");
  mkdirSync(dest, { recursive: true });
  const r = spawnSync(process.execPath, [NPM_CLI!, "pack", "--json", "--pack-destination", dest], {
    cwd: pkg,
    env: npmEnv,
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
  const [packed] = JSON.parse(r.stdout) as Array<{
    filename: string;
    integrity: string;
    shasum: string;
  }>;
  published.set(version, {
    tgz: join(dest, packed!.filename),
    integrity: packed!.integrity,
    shasum: packed!.shasum,
    time: opts.time ?? new Date().toISOString(),
    ...(opts.deprecated ? { deprecated: opts.deprecated } : {}),
  });
  tags.latest = version;
}

async function runtime(
  args: string[],
  extra: { clock?: AutoClock; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const paths = runtimePaths(join(home, ".browxai-runtime"));
  const code = await runRuntime(args, {
    ctx: {
      env: {
        ...npmEnv,
        ...extra.env,
        BROWX_WORKSPACE: join(home, "workspace"),
        BROWX_RUNTIME_DIR: paths.root,
      },
      home,
      platform: process.platform,
      uid: testUid(),
    },
    appBundle: () => undefined,
    // A loopback registry can't sign packages, so npm audit signatures can't pass here.
    verify: () => Promise.resolve({ ok: true, detail: "signatures not checked by this test" }),
    system: { platform: process.platform, home, env: {}, exists: () => false },
    agent: fakeAgent(),
    ...(extra.clock ? { clock: extra.clock } : {}),
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { code, out, err };
}

/** Start a server through the launcher and complete the MCP handshake. */
function startThroughLauncher(): {
  child: ChildProcessWithoutNullStreams;
  request: (method: string, params?: object) => Promise<Record<string, unknown>>;
} {
  const shim = join(home, ".browxai-runtime", "bin", "browxai");
  const child = spawn(shim, [], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home } });
  let buf = "";
  let nextId = 1;
  const waiting = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      buf = buf.slice(i + 1);
      waiting.get(msg.id as number)?.(msg);
    }
  });
  const request = (method: string, params: object = {}) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  return { child, request };
}

const handshake = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "keystone", version: "0" },
};
const versionOf = (init: Record<string, unknown>) =>
  (init.result as { serverInfo: { version: string } }).serverInfo.version;

describeRuntime("browxai runtime against a loopback npm registry", () => {
  const paths = () => runtimePaths(join(home, ".browxai-runtime"));

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "browxai-runtime-ks-")));
    home = join(tmp, "home");
    mkdirSync(home);
    server = createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      if (url === "/browxai") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(packument()));
        return;
      }
      // The provenance the release workflow would attach, for the real tarball's
      // sha512, so the provenance pin runs against this registry too.
      const a = /^\/-\/npm\/v1\/attestations\/browxai@(.+)$/.exec(url);
      const attested = a ? published.get(a[1]!) : undefined;
      if (a && attested) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(attestationsDoc({ version: a[1]!, integrity: attested.integrity })));
        return;
      }
      const m = /^\/browxai\/-\/browxai-(.+)\.tgz$/.exec(url);
      const p = m ? published.get(m[1]!) : undefined;
      if (p) {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        createReadStream(p.tgz).pipe(res);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end('{"error":"not found"}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    npmEnv = {
      PATH: process.env.PATH,
      HOME: home,
      npm_config_registry: base,
      npm_config_cache: join(tmp, "npm-cache"),
      npm_config_userconfig: join(tmp, "npmrc"),
      npm_config_globalconfig: join(tmp, "npmrc-global"),
      npm_config_update_notifier: "false",
    };
  }, STEP_TIMEOUT);

  afterAll(async () => {
    held?.kill("SIGKILL");
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  let request: ReturnType<typeof startThroughLauncher>["request"];

  it(
    "install gets A, and a server started through the launcher runs A",
    async () => {
      publish("1.0.0");
      const r = await runtime(["install"]);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(readCurrent(paths())).toBe("1.0.0");
      const started = startThroughLauncher();
      held = started.child;
      request = started.request;
      expect(versionOf(await request("initialize", handshake))).toBe("1.0.0");
    },
    STEP_TIMEOUT,
  );

  it(
    "update switches to each newer version, and a new start runs the newest",
    async () => {
      for (const v of ["1.1.0", "1.1.1", "1.1.2"]) {
        publish(v);
        const r = await runtime(["update", "--now"]);
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(readCurrent(paths())).toBe(v);
      }
      expect(readState(paths()).previous).toBe("1.1.1");
      const fresh = startThroughLauncher();
      expect(versionOf(await fresh.request("initialize", handshake))).toBe("1.1.2");
      fresh.child.stdin.end();
    },
    STEP_TIMEOUT,
  );

  it(
    "gc keeps A while the A server runs, and that server still loads its own files",
    async () => {
      const r = await runtime(["gc"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`kept 1.0.0: in use by pid ${held!.pid}`);
      expect(existsSync(versionDir(paths(), "1.0.0"))).toBe(true);
      const listed = await request("tools/list");
      const tools = (listed.result as { tools: Array<{ description: string }> }).tools;
      expect(tools[0]!.description).toBe("served by 1.0.0");
    },
    STEP_TIMEOUT,
  );

  it(
    "rollback goes back one version with no registry call",
    async () => {
      const r = await runtime(["rollback"]);
      expect(r.code).toBe(0);
      expect(readCurrent(paths())).toBe("1.1.1");
    },
    STEP_TIMEOUT,
  );

  it(
    "a version whose --version lies fails the smoke check and never becomes current",
    async () => {
      publish("1.2.0", { says: "1.1.9" });
      const r = await runtime(["update", "--now"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(
        'smoke check failed: cli.js --version: printed "1.1.9", expected 1.2.0',
      );
      expect(readCurrent(paths())).toBe("1.1.1");
      expect(existsSync(versionDir(paths(), "1.2.0"))).toBe(false);
      expect(readdirSync(paths().staging).filter((n) => n.startsWith("1.2.0-"))).toEqual([]);
      expect(readState(paths()).failed).toMatchObject({ "1.2.0": 1 });
    },
    STEP_TIMEOUT,
  );

  it(
    "a deprecated version is skipped",
    async () => {
      publish("1.3.0", { deprecated: "Use 1.3.1." });
      const r = await runtime(["update", "--now"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(
        '1.3.0 is deprecated on the registry ("Use 1.3.1."), so it is skipped.',
      );
      expect(readCurrent(paths())).toBe("1.1.1");
    },
    STEP_TIMEOUT,
  );

  it(
    "once the A server exits, gc removes A",
    async () => {
      const exited = new Promise((r) => held!.once("exit", r));
      held!.stdin.end();
      await exited;
      held = undefined;
      const r = await runtime(["gc"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("removed: 1.0.0");
      expect(existsSync(versionDir(paths(), "1.0.0"))).toBe(false);
    },
    STEP_TIMEOUT,
  );

  // The background job's clock: past the manual run's next check, on a boot the
  // runtime hasn't seen yet.
  let clockNow = Date.now() + 7 * HOUR;
  const BOOT = Date.now() - HOUR;
  const jobClock: AutoClock = {
    now: () => clockNow,
    random: () => 0,
    bootTime: () => Promise.resolve(BOOT),
  };
  const twoDaysAgo = () => new Date(clockNow - 48 * HOUR).toISOString();

  it(
    "update --auto: the first run after a boot waits, the next applies a version past its delay",
    async () => {
      publish("1.4.0", { time: twoDaysAgo() });
      const waited = await runtime(["update", "--auto"], { clock: jobClock });
      expect(waited.code).toBe(0);
      expect(readCurrent(paths())).toBe("1.1.1");
      expect(readState(paths()).bootSeen).toBe(BOOT);
      clockNow += 11 * 60_000;
      const r = await runtime(["update", "--auto"], { clock: jobClock });
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(readCurrent(paths())).toBe("1.4.0");
      expect(readJournal(paths()).at(-1)).toMatchObject({
        mode: "auto",
        event: "apply",
        version: "1.4.0",
        from: "1.1.1",
        result: "applied",
      });
      const fresh = startThroughLauncher();
      expect(versionOf(await fresh.request("initialize", handshake))).toBe("1.4.0");
      fresh.child.stdin.end();
    },
    STEP_TIMEOUT,
  );

  it(
    "update --auto: a version whose updater can't start fails the smoke check, and current stays",
    async () => {
      publish("1.5.0", { time: twoDaysAgo(), noUpdater: true });
      clockNow += 7 * HOUR;
      const r = await runtime(["update", "--auto"], { clock: jobClock });
      expect(r.code).toBe(0);
      expect(r.out).toContain("smoke check failed: runtime status --json: exit 2");
      expect(readCurrent(paths())).toBe("1.4.0");
      expect(existsSync(versionDir(paths(), "1.5.0"))).toBe(false);
      expect(readdirSync(paths().staging).filter((n) => n.startsWith("1.5.0-"))).toEqual([]);
      expect(readState(paths())).toMatchObject({
        failed: { "1.5.0": 1 },
        pending: { version: "1.5.0", state: "failed" },
      });
      expect(readJournal(paths()).at(-1)).toMatchObject({
        event: "apply",
        version: "1.5.0",
        result: "failed",
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "update --auto: with the registry gone it exits 0, keeps current and backs off",
    async () => {
      await new Promise<void>((r) => server.close(() => r()));
      clockNow += 7 * HOUR;
      const r = await runtime(["update", "--auto"], {
        clock: jobClock,
        env: { npm_config_fetch_retries: "0" },
      });
      expect(r.code).toBe(0);
      expect(readCurrent(paths())).toBe("1.4.0");
      expect(readState(paths())).toMatchObject({ lastResult: "offline", backoffMs: HOUR });
      expect(readJournal(paths()).at(-1)).toMatchObject({ event: "offline" });
    },
    STEP_TIMEOUT,
  );
});
