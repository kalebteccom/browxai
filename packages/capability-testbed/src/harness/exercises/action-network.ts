import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass, skip } from "../types.js";

type JsonRecord = Record<string, unknown>;

const NETWORK = {
  doJson: '[data-testid="do-json"]',
  netOut: '[data-testid="net-out"]',
  wsConnect: '[data-testid="ws-connect"]',
  wsOut: '[data-testid="ws-out"]',
} as const;

function exercise(fn: (ctx: ExerciseCtx) => Promise<ExerciseResult>): Exercise {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      return {
        outcome: "error",
        detail: err instanceof Error ? err.message : "Exercise threw a non-Error value",
        evidence: String(err),
      };
    }
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecords(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function firstText(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  for (const item of value.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
      return item.text;
    }
  }
  return undefined;
}

function payload(value: unknown): unknown {
  if (isRecord(value) && "data" in value) return value.data;
  const text = firstText(value);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function payloadRecord(value: unknown, label: string): JsonRecord {
  const data = payload(value);
  if (!isRecord(data)) throw new Error(`${label} did not return a JSON object`);
  return data;
}

function recordAt(record: JsonRecord, key: string): JsonRecord | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function stringAt(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberAt(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanAt(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireOk(record: JsonRecord, label: string): void {
  if (record.ok !== true) {
    throw new Error(`${label} did not return ok:true`);
  }
}

function unsupportedEngine(record: JsonRecord): boolean {
  return (
    record.ok === false &&
    (typeof record.engine === "string" ||
      (typeof record.error === "string" && record.error.toLowerCase().includes("engine")))
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function safeSession(ctx: ExerciseCtx): string {
  return ctx.session.replace(/[^A-Za-z0-9._-]/g, "_");
}

function wsUrl(ctx: ExerciseCtx): string {
  return `${ctx.baseUrl.replace(/^http/, "ws")}/ws/echo`;
}

function isWorkspacePath(workspace: string, path: string): boolean {
  const rel = relative(workspace, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function verifyText(
  ctx: ExerciseCtx,
  selector: string,
  text: string,
  exact = false,
): Promise<JsonRecord> {
  const result = await ctx.call("verify_text", { selector, text, exact });
  const data = payloadRecord(result, "verify_text");
  requireOk(data, "verify_text");
  return data;
}

async function waitForText(ctx: ExerciseCtx, text: string): Promise<void> {
  const result = await ctx.call("wait_for", { text, timeoutMs: 2_500 });
  const data = payloadRecord(result, "wait_for");
  requireOk(data, "wait_for");
}

async function clickJson(ctx: ExerciseCtx): Promise<void> {
  await ctx.call("click", { selector: NETWORK.doJson, timeoutMs: 5_000 });
}

async function networkRead(ctx: ExerciseCtx): Promise<JsonRecord> {
  return payloadRecord(await ctx.call("network_read", { limit: 25 }), "network_read");
}

function requests(data: JsonRecord): JsonRecord[] {
  return asRecords(data.requests);
}

function sawRequest(data: JsonRecord, urlNeedle: string, bodyStatus?: number): boolean {
  return requests(data).some((request) => {
    const url = stringAt(request, "url") ?? "";
    const status = numberAt(request, "status");
    return url.includes(urlNeedle) && (bodyStatus === undefined || status === bodyStatus);
  });
}

async function pageText(ctx: ExerciseCtx, selector: string): Promise<string> {
  const escaped = JSON.stringify(selector);
  const result = await ctx.call("eval_js", {
    expr: `document.querySelector(${escaped})?.textContent ?? ""`,
  });
  const data = payloadRecord(result, "eval_js");
  requireOk(data, "eval_js");
  const value = data.value;
  if (typeof value !== "string") throw new Error("eval_js did not return text content");
  return value;
}

async function liveSocketId(ctx: ExerciseCtx): Promise<string> {
  const result = await ctx.call("eval_js", {
    expr: "globalThis.__browxWs ? globalThis.__browxWs.list() : []",
  });
  const data = payloadRecord(result, "eval_js");
  requireOk(data, "eval_js");
  const sockets = asRecords(data.value);
  const open = sockets.find((socket) => {
    const url = stringAt(socket, "url") ?? "";
    return url.includes("/ws/echo") && numberAt(socket, "readyState") === 1;
  });
  const wsId = open ? stringAt(open, "wsId") : undefined;
  if (!wsId) throw new Error("no open /ws/echo socket was discoverable");
  return wsId;
}

async function connectSocket(ctx: ExerciseCtx, expectedText = "recv:welcome"): Promise<void> {
  await ctx.call("click", { selector: NETWORK.wsConnect });
  await waitForText(ctx, expectedText);
  await verifyText(ctx, NETWORK.wsOut, expectedText);
}

function wsFrames(data: JsonRecord): JsonRecord[] {
  return asRecords(data.frames);
}

async function waitForFile(path: string): Promise<{ size: number; text: string }> {
  for (let i = 0; i < 20; i++) {
    try {
      const info = await stat(path);
      if (info.size > 0) {
        return { size: info.size, text: await readFile(path, "utf8") };
      }
    } catch {
      // HAR finalization races the browser context close by a short interval.
    }
    await delay(100);
  }
  throw new Error(`HAR file was not finalized at ${path}`);
}

const route = exercise(async (ctx) => {
  await ctx.goto("/network");
  const body = JSON.stringify({ ok: true, message: "stubbed-route", items: ["stub"] });
  const routed = payloadRecord(
    await ctx.call("route", {
      urlPattern: "**/api/json",
      method: "GET",
      status: 200,
      body,
      contentType: "application/json",
    }),
    "route",
  );
  requireOk(routed, "route");

  await clickJson(ctx);
  await verifyText(ctx, NETWORK.netOut, "stubbed-route");
  const read = await networkRead(ctx);
  if (sawRequest(read, "/api/json", 200)) {
    return pass("route fulfilled /api/json with the stubbed body and the request was observable", {
      route: routed,
      network: read,
    });
  }
  return fail("route stubbed the DOM response but network_read did not show /api/json", read);
});

const route_queue = exercise(async (ctx) => {
  await ctx.goto("/network");
  const queued = payloadRecord(
    await ctx.call("route_queue", {
      urlPattern: "**/api/json",
      method: "GET",
      responses: [
        {
          status: 200,
          body: JSON.stringify({ ok: true, message: "queue-one" }),
          contentType: "application/json",
        },
        {
          status: 200,
          body: JSON.stringify({ ok: true, message: "queue-two" }),
          contentType: "application/json",
        },
      ],
    }),
    "route_queue",
  );
  requireOk(queued, "route_queue");

  await clickJson(ctx);
  await verifyText(ctx, NETWORK.netOut, "queue-one");
  await clickJson(ctx);
  await verifyText(ctx, NETWORK.netOut, "queue-two");
  await clickJson(ctx);
  await verifyText(ctx, NETWORK.netOut, "json-payload");

  const read = await networkRead(ctx);
  if (requests(read).filter((request) => (stringAt(request, "url") ?? "").includes("/api/json")).length >= 3) {
    return pass("route_queue served two staged bodies and then fell through to the real response", {
      routeQueue: queued,
      network: read,
    });
  }
  return fail("route_queue responses were not all observable as /api/json requests", read);
});

const unroute = exercise(async (ctx) => {
  await ctx.goto("/network");
  const pattern = "**/api/json";
  requireOk(
    payloadRecord(
      await ctx.call("route", {
        urlPattern: pattern,
        body: JSON.stringify({ ok: true, message: "will-be-unrouted" }),
        contentType: "application/json",
      }),
      "route",
    ),
    "route",
  );

  await clickJson(ctx);
  await verifyText(ctx, NETWORK.netOut, "will-be-unrouted");
  const removed = payloadRecord(await ctx.call("unroute", { urlPattern: pattern }), "unroute");
  requireOk(removed, "unroute");
  await clickJson(ctx);
  await verifyText(ctx, NETWORK.netOut, "json-payload");

  return pass("unroute removed the stub and /api/json returned to the real server body", {
    removed,
    text: await pageText(ctx, NETWORK.netOut),
  });
});

const network_emulate = exercise(async (ctx) => {
  await ctx.goto("/network");
  const applied = payloadRecord(await ctx.call("network_emulate", { offline: true }), "network_emulate");
  if (unsupportedEngine(applied)) return skip(`network_emulate unsupported on engine: ${String(applied.engine)}`);
  requireOk(applied, "network_emulate");

  await ctx.call("click", { selector: NETWORK.doJson, timeoutMs: 2_000 });
  await delay(250);
  const offlineRead = await networkRead(ctx);
  const summary = recordAt(offlineRead, "summary");
  const failedCount = numberAt(summary ?? {}, "failed") ?? 0;
  const failedRequest = requests(offlineRead).some((request) => booleanAt(request, "failed") === true);

  const reset = payloadRecord(await ctx.call("network_emulate", {}), "network_emulate");
  requireOk(reset, "network_emulate reset");
  await clickJson(ctx);
  await verifyText(ctx, NETWORK.netOut, "json-payload");

  if (failedCount > 0 || failedRequest) {
    return pass("network_emulate offline caused a failed fetch, then reset restored real network access", {
      applied,
      offlineRead,
      reset,
    });
  }
  return fail("network_emulate offline did not produce a failed network observation", {
    applied,
    offlineRead,
    reset,
  });
});

const ws_send = exercise(async (ctx) => {
  await ctx.goto("/network");
  await ctx.call("ws_unintercept");
  await connectSocket(ctx);
  const wsId = await liveSocketId(ctx);
  const sent = payloadRecord(await ctx.call("ws_send", { wsId, message: "tool-injected" }), "ws_send");
  requireOk(sent, "ws_send");
  await waitForText(ctx, "recv:echo:tool-injected");
  await verifyText(ctx, NETWORK.wsOut, "recv:echo:tool-injected");

  const read = payloadRecord(await ctx.call("ws_read", { limit: 20, urlPattern: "/ws/echo" }), "ws_read");
  const frames = wsFrames(read);
  const sawSent = frames.some((frame) => frame.dir === "sent" && frame.payload === "tool-injected");
  const sawEcho = frames.some((frame) => frame.dir === "recv" && frame.payload === "echo:tool-injected");
  if (sawSent && sawEcho) {
    return pass("ws_send pushed a frame through the page socket and the page observed the server echo", {
      wsId,
      sent,
      frames,
    });
  }
  return fail("ws_send did not produce the expected sent and echoed WS frames", { wsId, sent, frames });
});

const ws_intercept = exercise(async (ctx) => {
  await ctx.goto("/network");
  const pattern = wsUrl(ctx);
  const intercepted = payloadRecord(
    await ctx.call("ws_intercept", { pattern, response: { data: "intercepted-welcome" } }),
    "ws_intercept",
  );
  requireOk(intercepted, "ws_intercept");
  await connectSocket(ctx, "recv:intercepted-welcome");
  const text = await pageText(ctx, NETWORK.wsOut);
  if (text.split("\n").includes("recv:intercepted-welcome")) {
    return pass("ws_intercept rewrote the inbound welcome frame before the page handler saw it", {
      intercepted,
      text,
    });
  }
  return fail("ws_intercept did not rewrite the inbound welcome frame", { intercepted, text });
});

const ws_unintercept = exercise(async (ctx) => {
  await ctx.goto("/network");
  const pattern = wsUrl(ctx);
  requireOk(
    payloadRecord(
      await ctx.call("ws_intercept", { pattern, response: { data: "temporary-welcome" } }),
      "ws_intercept",
    ),
    "ws_intercept",
  );
  await connectSocket(ctx, "recv:temporary-welcome");

  const removed = payloadRecord(await ctx.call("ws_unintercept", { pattern }), "ws_unintercept");
  requireOk(removed, "ws_unintercept");
  await connectSocket(ctx, "recv:welcome");
  const text = await pageText(ctx, NETWORK.wsOut);
  const lines = text.split("\n").filter(Boolean);
  if (lines.includes("recv:temporary-welcome") && lines.includes("recv:welcome")) {
    return pass("ws_unintercept removed the replacement and a new socket received the real welcome", {
      removed,
      lines,
    });
  }
  return fail("ws_unintercept did not restore pass-through WS frames", { removed, lines });
});

const start_har = exercise(async (ctx) => {
  await ctx.goto("/network");
  const harPath = `har/${safeSession(ctx)}-start.har`;
  const started = payloadRecord(
    await ctx.call("start_har", { path: harPath, urlFilter: "**/api/**" }),
    "start_har",
  );
  requireOk(started, "start_har");
  const path = stringAt(started, "path");
  if (!path || !isWorkspacePath(ctx.workspace, path)) {
    return fail("start_har did not reserve a workspace-rooted HAR path", started);
  }

  await clickJson(ctx);
  await verifyText(ctx, NETWORK.netOut, "json-payload");
  const stopped = payloadRecord(await ctx.call("stop_har"), "stop_har");
  requireOk(stopped, "stop_har");
  if (booleanAt(stopped, "wasActive") === true && stringAt(stopped, "path") === path) {
    return pass("start_har armed recording for a real /api/json request", {
      started,
      stopped,
      network: await networkRead(ctx),
    });
  }
  return fail("start_har did not leave an active recorder for stop_har", { started, stopped });
});

const stop_har = exercise(async (ctx) => {
  await ctx.goto("/network");
  const harPath = `har/${safeSession(ctx)}-stop.har`;
  const started = payloadRecord(
    await ctx.call("start_har", { path: harPath, urlFilter: "**/api/**" }),
    "start_har",
  );
  requireOk(started, "start_har");
  await clickJson(ctx);
  await verifyText(ctx, NETWORK.netOut, "json-payload");

  const stopped = payloadRecord(await ctx.call("stop_har"), "stop_har");
  requireOk(stopped, "stop_har");
  const path = stringAt(stopped, "path");
  if (!path || !isWorkspacePath(ctx.workspace, path) || booleanAt(stopped, "wasActive") !== true) {
    return fail("stop_har did not report an active workspace-rooted HAR target", { started, stopped });
  }

  await ctx.client.close_session({ session: ctx.session });
  const file = await waitForFile(path);
  if (file.text.includes("/api/json")) {
    return pass("stop_har removed the recorder and the HAR finalized on session close", {
      stopped,
      path,
      bytes: file.size,
    });
  }
  return fail("finalized HAR did not contain the /api/json request", {
    stopped,
    path,
    bytes: file.size,
    excerpt: file.text.slice(0, 500),
  });
});

const exercises = {
  route,
  route_queue,
  unroute,
  network_emulate,
  ws_send,
  ws_intercept,
  ws_unintercept,
  start_har,
  stop_har,
} satisfies ExerciseMap;

export default exercises;
