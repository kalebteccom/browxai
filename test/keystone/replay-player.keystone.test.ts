// Replay-player keystone (RFC 0007 P2) — the end-to-end gate for the whole
// player half. One real Chrome plays both roles:
//
//   1. CAPTURE. browxai attaches to it (BYOB), drives a fixture page through
//      the real MCP handlers, and the P1 capture path records what happened —
//      `attachDomCapture` for the DOM stream, `src/replay/sources.ts` for the
//      agent's own timeline, `ReplayLog` + `writeArtifact` for the container.
//      Nothing is synthesised: the events come from handlers that really ran.
//   2. REVIEW. The built single-file player is opened over `file://` and driven
//      through browxai's own tools.
//
// What only a real browser can prove, and what a jsdom test structurally
// cannot:
//   - the single file opens from `file://` with no server. That is the entire
//     product constraint: a reviewer double-clicks it out of a CI artifact.
//   - rrweb's Replayer actually rebuilds the captured DOM inside its iframe,
//     with the fixture's real text in it — not just that a `<canvas>` appeared.
//   - the step list matches the actions browxai really performed.
//   - an unknown event type is marked and announced, and the replay still
//     plays. That is the forward-compatibility rule from `src/replay/schema.ts`
//     under test rather than asserted in a comment.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createSocket } from "node:net";
import { createServer as createHttp, type Server } from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import { chromium, type BrowserContext, type Browser } from "playwright-core";

import { createServer } from "../../src/server.js";
import { attachDomCapture, type DomCaptureHandle } from "../../src/replay/dom-capture.js";
import { ReplayLog } from "../../src/replay/log.js";
import { writeArtifact } from "../../src/replay/artifact.js";
import {
  actionCallEvent,
  annotateSpanEvent,
  createClock,
  resultEvent,
  type SourceContext,
} from "../../src/replay/sources.js";
import { Redactor } from "../../src/replay/redact.js";
import { buildPlayerHtml, packPlayerHtml } from "../../scripts/build-replay-player.js";

const KEYSTONE_TIMEOUT = 180_000;

const MARKER = "REPLAY-PLAYER-MARKER";
const TYPED = "typed-into-the-form";
/** An event type this build has never heard of. The forward-compatibility gate. */
const FUTURE_TYPE = "telemetry/flamechart";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>replay player fixture</title></head>
<body>
  <h1 id="title">${MARKER}</h1>
  <input data-testid="task-input" id="task" type="text" />
  <button data-testid="save-btn" id="save" type="button"
          onclick="document.getElementById('saved').textContent='Saved OK'">Save</button>
  <output data-testid="saved-state" id="saved">Unsaved</output>
</body></html>`;

interface Fixture {
  url: string;
  close: () => Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const server: Server = createHttp((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createSocket();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function waitForCdp(url: string, proc: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/json/version`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) {
      throw new Error(`Chrome exited with code ${proc.exitCode}: ${stderr().trim() || "(silent)"}`);
    }
    if (Date.now() > deadline) throw new Error(`CDP never came up: ${stderr().trim()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const chromePath = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const describePlayer = chromePath && existsSync(chromePath) ? describe : describe.skip;

let fixture: Fixture;
let chrome: ChildProcess;
let endpoint: string;
let workspace: string;
let profileDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-replay-player-"));
  process.env.BROWX_WORKSPACE = workspace;
  process.env.BROWX_CAPABILITIES = "read,navigation,action,human,byob-attach,eval";

  fixture = await startFixture();
  if (!chromePath || !existsSync(chromePath)) return;

  profileDir = mkdtempSync(join(tmpdir(), "browx-replay-player-profile-"));
  const port = await freePort();
  endpoint = `http://127.0.0.1:${port}`;
  chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-allow-origins=*",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  chrome.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString();
  });
  await waitForCdp(endpoint, chrome, () => stderr);
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await exited;
  }
  await fixture?.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  delete process.env.BROWX_WORKSPACE;
  delete process.env.BROWX_CAPABILITIES;
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 });
}, KEYSTONE_TIMEOUT);

type Call = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

function callerFor(handlers: Record<string, (a: unknown) => Promise<unknown>>): Call {
  return async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
    const fn = handlers[name];
    if (!fn) throw new Error(`replay-player keystone: no handler "${name}"`);
    const res = (await fn(args)) as { content: Array<{ text: string }> };
    return JSON.parse(res.content[0]?.text ?? "{}") as T;
  };
}

interface Captured {
  artifactPath: string;
  /** The actions the agent really performed, in order, with their verdicts. */
  expectedSteps: { tool: string; ok: boolean }[];
  failingStepIndex: number;
}

/**
 * Drive a browxai session against the fixture through the MCP handlers while
 * the P1 capture path records it, then write the `.browx`.
 */
async function captureSession(): Promise<Captured> {
  const server = await createServer({ attachCdp: endpoint, headless: true });
  const call = callerFor(server.handlers);
  const clockOrigin = Date.now();
  const clock = createClock(clockOrigin);
  const ctx: SourceContext = { clock, redact: new Redactor() };

  const log = await ReplayLog.open({ workspaceRoot: workspace, path: "replay/events.jsonl" });
  let browser: Browser | undefined;
  let capture: DomCaptureHandle | undefined;
  const expectedSteps: { tool: string; ok: boolean }[] = [];

  /** One browxai tool call, both halves of its timeline entry recorded. */
  const step = async (tool: string, args: Record<string, unknown>): Promise<{ ok?: boolean }> => {
    log.append(actionCallEvent(ctx, { tool, args }));
    const outcome = await call<{ ok?: boolean; failure?: Record<string, unknown> }>(tool, args);
    log.append(resultEvent(ctx, tool, outcome));
    expectedSteps.push({ tool, ok: outcome.ok === true });
    return outcome;
  };

  try {
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0] as BrowserContext;
    capture = await attachDomCapture(context, {
      clockOrigin,
      onEvent: (e) => void log.append(e),
    });

    await call("approve_actions", { scopes: ["byob_action"], ttlSeconds: 600 });
    await call("open_session", { session: "capture", mode: "attached" });

    log.append(annotateSpanEvent(ctx, { label: "AC-SAVE", phase: "start" }));
    await step("navigate", { session: "capture", url: `${fixture.url}/` });
    await step("fill", {
      session: "capture",
      selector: '[data-testid="task-input"]',
      value: TYPED,
    });
    await step("click", { session: "capture", selector: '[data-testid="save-btn"]' });
    await step("verify_text", {
      session: "capture",
      selector: '[data-testid="saved-state"]',
      text: "Saved OK",
    });
    // The failure the reviewer is meant to jump to.
    const failingStepIndex = expectedSteps.length;
    await step("verify_text", {
      session: "capture",
      selector: '[data-testid="saved-state"]',
      text: "This text is never on the page",
    });
    log.append(annotateSpanEvent(ctx, { label: "AC-SAVE", phase: "end" }));

    // An event type from a browxai that does not exist yet, written straight
    // into the log the way a future capture source or a plugin would.
    log.record(FUTURE_TYPE, { frames: [1, 2, 3] }, { v: 4 });

    // rrweb's emit is async through the exposeBinding; give the tail a moment.
    await new Promise((r) => setTimeout(r, 1500));
    await capture.detach();
    const stats = await log.close();
    expect(stats.counts["dom/rrweb"] ?? 0).toBeGreaterThan(0);

    const written = await writeArtifact({
      workspaceRoot: workspace,
      path: "replay/session-replay.browx",
      manifest: {
        schemaVersion: 1,
        sessionId: "capture",
        clockOrigin,
        tier: "replay",
        browxaiVersion: "keystone",
        engine: "chromium",
        counts: stats.counts,
        ...(stats.truncated ? { truncated: stats.truncated } : {}),
      },
      events: await readFile(stats.path),
    });
    return { artifactPath: written.path, expectedSteps, failingStepIndex };
  } finally {
    await capture?.detach().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server.shutdown().catch(() => undefined);
  }
}

/** Build the real single-file player and embed the artifact in it. */
async function packPlayer(artifactPath: string, name: string): Promise<string> {
  const shell = await buildPlayerHtml();
  expect(shell).not.toContain("__BROWX_");
  // Self-contained is the product constraint, so it is asserted rather than
  // assumed. Markup only: inlined script bodies are full of `src=` in string
  // literals, and a substring match over the whole file would fail on those
  // instead of on a real external reference.
  const markup = shell
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");
  expect(markup).not.toMatch(/\s(?:src|href)\s*=/);
  const styles = shell.match(/<style[\s\S]*?<\/style>/gi)?.join("") ?? "";
  expect(styles).not.toMatch(/@import|url\(/i);
  const packed = packPlayerHtml(shell, await readFile(artifactPath));
  const out = join(workspace, name);
  await writeFile(out, packed, "utf8");
  return pathToFileURL(out).href;
}

describePlayer("replay player keystone — capture with browxai, review with browxai", () => {
  let captured: Captured;
  let playerUrl: string;

  beforeAll(async () => {
    if (!chromePath || !existsSync(chromePath)) return;
    captured = await captureSession();
    playerUrl = await packPlayer(captured.artifactPath, "session-replay.html");
  }, KEYSTONE_TIMEOUT);

  it(
    "opens from file:// with no server, replays the captured DOM, and lists the real steps",
    async () => {
      const server = await createServer({ attachCdp: endpoint, headless: true });
      const call = callerFor(server.handlers);
      try {
        await call("approve_actions", { scopes: ["byob_action"], ttlSeconds: 600 });
        await call("open_session", { session: "review", mode: "attached" });
        const nav = await call<{ ok: boolean }>("navigate", { session: "review", url: playerUrl });
        expect(nav.ok).toBe(true);

        // The player reports its own lifecycle on <body>, so readiness is a
        // wait on the DOM rather than a sleep.
        const ready = await call<{ ok: boolean }>("wait_for", {
          session: "review",
          selector: 'body[data-player-state="ready"]',
          timeoutMs: 30_000,
        });
        expect(ready.ok).toBe(true);

        // The step list is the agent's real timeline, in order, with verdicts.
        const steps = await call<{ ok: boolean; failure?: { actual?: unknown } }>("verify_count", {
          session: "review",
          selector: "#steps li.step",
          n: captured.expectedSteps.length,
        });
        expect(steps.ok).toBe(true);

        const listed = await call<{ ok: boolean; value?: unknown }>("eval_js", {
          session: "review",
          expr: `Array.from(document.querySelectorAll('#steps li.step')).map(li => li.dataset.tool + ':' + li.dataset.ok)`,
        });
        expect(listed.value).toEqual(
          captured.expectedSteps.map((s) => `${s.tool}:${String(s.ok)}`),
        );

        // t=0 is the tab before it navigated, so the replay correctly shows a
        // blank page there. Click the last step to put the playhead after the
        // navigation and the fill.
        const last = captured.expectedSteps.length - 1;
        const jumped = await call<{ ok: boolean }>("click", {
          session: "review",
          selector: `#steps li.step[data-step-index="${last}"]`,
        });
        expect(jumped.ok).toBe(true);

        // The evidence that the DOM replay actually rendered: the fixture's own
        // markup and the value browxai typed, read out of rrweb's replay
        // iframe. A mounted-but-empty stage passes a visibility check and fails
        // this.
        let replayed: { html: string; typed: string | null } = { html: "", typed: null };
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const read = await call<{ value?: unknown }>("eval_js", {
            session: "review",
            expr: `(() => {
              const f = document.querySelector('#stage iframe');
              const d = f && f.contentDocument;
              if (!d || !d.body) return { html: "", typed: null };
              const input = d.getElementById('task');
              return { html: d.body.innerHTML, typed: input ? input.value : null };
            })()`,
            timeoutMs: 20_000,
          });
          replayed = read.value as typeof replayed;
          if (replayed.html.includes(MARKER)) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(replayed.html).toContain(MARKER);
        expect(replayed.typed).toBe(TYPED);
      } finally {
        await server.shutdown().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "jumps to the first failed assertion and shows what it compared",
    async () => {
      const server = await createServer({ attachCdp: endpoint, headless: true });
      const call = callerFor(server.handlers);
      try {
        await call("approve_actions", { scopes: ["byob_action"], ttlSeconds: 600 });
        await call("open_session", { session: "failure", mode: "attached" });
        await call("navigate", { session: "failure", url: playerUrl });
        await call("wait_for", {
          session: "failure",
          selector: 'body[data-player-state="ready"]',
          timeoutMs: 30_000,
        });

        const enabled = await call<{ ok: boolean }>("verify_attribute", {
          session: "failure",
          selector: "#jump-failure",
          attr: "data-failure-step",
          value: String(captured.failingStepIndex),
        });
        expect(enabled.ok).toBe(true);

        const clicked = await call<{ ok: boolean }>("click", {
          session: "failure",
          selector: "#jump-failure",
        });
        expect(clicked.ok).toBe(true);

        const selected = await call<{ ok: boolean }>("verify_attribute", {
          session: "failure",
          selector: "#step-detail",
          attr: "data-step-index",
          value: String(captured.failingStepIndex),
        });
        expect(selected.ok).toBe(true);

        const highlighted = await call<{ ok: boolean }>("verify_count", {
          session: "failure",
          selector: "#steps li.step.is-current",
          n: 1,
        });
        expect(highlighted.ok).toBe(true);

        // The playhead moved off zero: the DOM replay really seeked.
        const clock = await call<{ ok: boolean; value?: unknown }>("eval_js", {
          session: "failure",
          expr: `Number(document.getElementById('clock').dataset.t)`,
        });
        expect(Number(clock.value)).toBeGreaterThan(0);
      } finally {
        await server.shutdown().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "marks an unknown event type, announces it, and still plays",
    async () => {
      const server = await createServer({ attachCdp: endpoint, headless: true });
      const call = callerFor(server.handlers);
      try {
        await call("approve_actions", { scopes: ["byob_action"], ttlSeconds: 600 });
        await call("open_session", { session: "unknown", mode: "attached" });
        await call("navigate", { session: "unknown", url: playerUrl });
        await call("wait_for", {
          session: "unknown",
          selector: 'body[data-player-state="ready"]',
          timeoutMs: 30_000,
        });

        const banner = await call<{ ok: boolean }>("verify_count", {
          session: "unknown",
          selector: '.banner[data-kind="unknown"]',
          n: 1,
        });
        expect(banner.ok).toBe(true);

        const named = await call<{ ok: boolean }>("verify_text", {
          session: "unknown",
          selector: '.banner[data-kind="unknown"]',
          text: FUTURE_TYPE,
        });
        expect(named.ok).toBe(true);

        const marked = await call<{ ok: boolean }>("verify_count", {
          session: "unknown",
          selector: "#strip .mark-unknown",
          n: 1,
        });
        expect(marked.ok).toBe(true);

        // Never blocks playback: the transport is live and the playhead moves.
        const played = await call<{ ok: boolean; value?: unknown }>("eval_js", {
          session: "unknown",
          expr: `(() => {
            const b = document.getElementById('play-pause');
            if (b.disabled) return 'disabled';
            b.click();
            return b.textContent;
          })()`,
        });
        expect(played.value).toBe("Pause");

        const advanced = await call<{ ok: boolean }>("wait_for", {
          session: "unknown",
          selector: '#clock:not([data-t="0"])',
          timeoutMs: 20_000,
        });
        expect(advanced.ok).toBe(true);
      } finally {
        await server.shutdown().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "says so prominently when the manifest records a truncated capture",
    async () => {
      // Same events, a manifest that says capture was cut short. A silently
      // short replay is worse than a refused one, so this is a separate gate
      // from the happy path rather than an assertion tacked onto it.
      const events = await readFile(join(workspace, "replay", "events.jsonl"));
      const cut = await writeArtifact({
        workspaceRoot: workspace,
        path: "replay/truncated.browx",
        manifest: {
          schemaVersion: 1,
          sessionId: "capture",
          clockOrigin: Date.now(),
          tier: "replay",
          browxaiVersion: "keystone",
          engine: "chromium",
          counts: {},
          truncated: { at: 1234, reason: "size-cap", droppedEvents: 987 },
        },
        events,
      });
      const url = await packPlayer(cut.path, "truncated.html");

      const server = await createServer({ attachCdp: endpoint, headless: true });
      const call = callerFor(server.handlers);
      try {
        await call("approve_actions", { scopes: ["byob_action"], ttlSeconds: 600 });
        await call("open_session", { session: "truncated", mode: "attached" });
        await call("navigate", { session: "truncated", url });
        await call("wait_for", {
          session: "truncated",
          selector: 'body[data-player-state="ready"]',
          timeoutMs: 30_000,
        });

        const banner = await call<{ ok: boolean }>("verify_visible", {
          session: "truncated",
          selector: '.banner[data-kind="truncated"]',
        });
        expect(banner.ok).toBe(true);

        for (const text of ["incomplete", "size-cap", "987"]) {
          const said = await call<{ ok: boolean }>("verify_text", {
            session: "truncated",
            selector: '.banner[data-kind="truncated"]',
            text,
          });
          expect(said.ok).toBe(true);
        }
      } finally {
        await server.shutdown().catch(() => undefined);
      }
    },
    KEYSTONE_TIMEOUT,
  );
});
