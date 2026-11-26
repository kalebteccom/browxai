// Shell route keystone: `browxai call` drives a real headless Chromium through a real
// `serve --socket` daemon, one command per tool, the way an agent with a shell would.
// Every command is a separate invocation of the same handler the bin runs, so nothing
// carries over between them but what the daemon holds: the session and its refs.
//
// Covered:
//   - open a session, navigate, snapshot, then click by a ref read from the snapshot
//     in an earlier command, then verify the page changed
//   - an element that is not there exits 1 with `data.ok` false
//   - a screenshot is listed without pixels, and `--out` writes the first image to a
//     file, refuses to overwrite it, and overwrites with `--force`
//   - a gated tool is refused with exit 4 while a real session is open, and does nothing
//
// Skipped on Windows: the daemon test relies on POSIX socket file semantics.

import { afterAll, beforeAll, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startServeForTests } from "../../src/cli/serve.js";
import { runCall } from "../../src/cli/shell-call.js";
import type { ShellIo } from "../../src/cli/shell-io.js";
import { startFixture, type Fixture } from "./fixture.js";
import { gatedDescribe, hostGate } from "./keystone-gate.js";

const KEYSTONE_TIMEOUT = 120_000;
const skipIfWindows = gatedDescribe(
  hostGate(process.platform !== "win32", "the daemon socket is a Unix domain socket"),
);

let fixture: Fixture;
let workspace: string;
let socketPath: string;
let serveHandle: Awaited<ReturnType<typeof startServeForTests>>;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-shell-ks-"));
  process.env.BROWX_WORKSPACE = workspace;
  socketPath = join(workspace, "browxai.sock");
  fixture = await startFixture();
  serveHandle = await startServeForTests({ socketPath, headless: true });
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await serveHandle?.shutdown().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

interface Doc {
  isError: boolean;
  data?: Record<string, unknown>;
  text?: string;
  images: Array<{ mimeType: string; bytes: number; path?: string }>;
  truncated?: unknown;
}

/** One `browxai call` invocation: a fresh process as far as the route can tell. */
async function call(tool: string, args: Record<string, unknown>, ...flags: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: ShellIo = {
    env: {},
    stdout: (t) => Promise.resolve(void out.push(t)),
    stderr: (t) => Promise.resolve(void err.push(t)),
    input: { readStdin: () => Promise.resolve(""), readFile: (p) => readFileSync(p, "utf8") },
  };
  const code = await runCall(
    [tool, JSON.stringify(args), "--socket", socketPath, "--max-chars", "0", ...flags],
    io,
  );
  const raw = out.join("");
  return { code, doc: JSON.parse(raw) as Doc, raw, err: err.join("") };
}

const SESSION = "shell-ks";
/** The bin's source entry, run through tsx: the keystone shards have no dist/. */
const REPO = join(__dirname, "..", "..");

skipIfWindows("browxai call drives a real browser through serve --socket", () => {
  it(
    "opens a session, snapshots, clicks by a ref from an earlier command, and verifies",
    async () => {
      const opened = await call("open_session", { session: SESSION, mode: "incognito" });
      expect(opened.code).toBe(0);
      expect(opened.doc.data?.ok).toBe(true);

      const nav = await call("navigate", { session: SESSION, url: `${fixture.url}/` });
      expect(nav.code).toBe(0);
      expect(nav.doc.data?.ok).toBe(true);

      // The snapshot tree is not JSON, so it comes back as text.
      const snap = await call("snapshot", { session: SESSION });
      expect(snap.code).toBe(0);
      expect(snap.doc.data).toBeUndefined();
      const tree = snap.doc.text ?? "";
      expect(tree).toContain('[data-testid="save-btn"]');
      expect(snap.raw.trimEnd().split("\n")).toHaveLength(1);

      // The ref is read here and used in another command: the daemon holds it.
      const line = tree.split("\n").find((l) => l.includes("save-btn")) ?? "";
      const ref = /\[ref=(e\d+)\]/.exec(line)?.[1];
      expect(ref, `no ref on the Save button line: ${line}`).toBeDefined();

      const clicked = await call("click", { session: SESSION, ref });
      expect(clicked.code).toBe(0);
      expect(clicked.doc.data?.ok).toBe(true);

      const verified = await call("verify_text", {
        session: SESSION,
        selector: '[data-testid="saved-state"]',
        text: "Saved OK",
      });
      expect(verified.code).toBe(0);
      expect(verified.doc.data?.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "exits 1 when an element is not there, with data.ok false",
    async () => {
      const missing = await call("click", {
        session: SESSION,
        selector: "#no-such-element",
        timeoutMs: 1500,
      });
      expect(missing.code).toBe(1);
      expect(missing.doc.isError).toBe(false);
      expect(missing.doc.data?.ok).toBe(false);

      const wrong = await call("verify_text", {
        session: SESSION,
        selector: '[data-testid="saved-state"]',
        text: "text that is not on the page",
      });
      expect(wrong.code).toBe(1);
      expect(wrong.doc.data?.ok).toBe(false);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "lists a screenshot without pixels, and --out writes, refuses to overwrite, then overwrites",
    async () => {
      const file = join(workspace, "shot.png");
      const shot = await call("screenshot", { session: SESSION }, "--out", file);
      expect(shot.code).toBe(0);
      const image = shot.doc.images[0];
      expect(image?.mimeType).toMatch(/^image\//);
      expect(image?.bytes).toBeGreaterThan(100);
      expect(image?.path).toBe(file);
      expect(statSync(file).size).toBe(image?.bytes);
      // The document names the image and carries no pixels: it is far smaller than the file.
      expect(shot.raw.length).toBeLessThan((image?.bytes ?? 0) / 2);
      const first = readFileSync(file);

      // A second run to the same path is refused before the tool runs.
      const again = await runCall(
        ["screenshot", JSON.stringify({ session: SESSION }), "--socket", socketPath, "--out", file],
        {
          env: {},
          stdout: () => Promise.resolve(),
          stderr: () => Promise.resolve(),
          input: { readStdin: () => Promise.resolve(""), readFile: () => "" },
        },
      );
      expect(again).toBe(2);
      expect(readFileSync(file).equals(first)).toBe(true);

      const forced = await call("screenshot", { session: SESSION }, "--out", file, "--force");
      expect(forced.code).toBe(0);
      expect(existsSync(file)).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses a gated tool with exit 4 while a session is open, and the page is untouched",
    async () => {
      const refused = await call("eval_js", {
        session: SESSION,
        expr: "document.title = 'changed by eval'",
      });
      expect(refused.code).toBe(4);
      expect(refused.doc.data?.ok).toBe(false);
      expect(refused.doc.data?.requiredCapability).toBe("eval");

      const title = await call("extract", {
        session: SESSION,
        schema: {
          type: "object",
          properties: { title: { type: "string", "x-browx-source": { selector: "h1" } } },
        },
      });
      expect(title.code).toBe(0);
      expect(JSON.stringify(title.doc.data)).not.toContain("changed by eval");
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "refuses eval_js with the same envelope the stdio bin returns to an MCP client",
    async () => {
      const refused = await call("eval_js", { session: SESSION, expr: "1 + 1" });
      expect(refused.code).toBe(4);

      // The bin's entry over stdio, the server an MCP client such as Claude Code starts.
      const transport = new StdioClientTransport({
        command: join(REPO, "node_modules/.bin/tsx"),
        args: [join(REPO, "src/cli.ts")],
        cwd: REPO,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          BROWX_WORKSPACE: workspace,
          BROWX_HEADLESS: "1",
        },
        stderr: "ignore",
      });
      const client = new Client({ name: "shell-route-keystone", version: "0" });
      try {
        await client.connect(transport);
        const res = await client.callTool({
          name: "eval_js",
          arguments: { session: SESSION, expr: "1 + 1" },
        });
        const items = res.content as Array<{ type: string; text?: string }>;
        const viaStdio = JSON.parse(items[0]?.text ?? "null") as Record<string, unknown>;
        expect(viaStdio.requiredCapability).toBe("eval");
        expect(refused.doc.data).toEqual(viaStdio);
      } finally {
        await client.close().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "closes the session",
    async () => {
      const closed = await call("close_session", { session: SESSION });
      expect(closed.code).toBe(0);
      expect(closed.doc.data?.ok).toBe(true);
    },
    KEYSTONE_TIMEOUT,
  );
});
