import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass, skip } from "../types.js";

type JsonRecord = Record<string, unknown>;

const WORKERS = {
  spawn: '[data-testid="spawn-worker"]',
  registerSw: '[data-testid="register-sw"]',
  swFetch: '[data-testid="sw-fetch"]',
  out: '[data-testid="worker-out"]',
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

function stringAt(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function requireOk(record: JsonRecord, label: string): void {
  if (record.ok !== true) {
    throw new Error(`${label} did not return ok:true`);
  }
}

function isStructuredRefusal(record: JsonRecord): boolean {
  return record.ok === false && typeof record.error === "string";
}

async function verifyVisible(ctx: ExerciseCtx, selector: string): Promise<JsonRecord> {
  const data = payloadRecord(await ctx.call("verify_visible", { selector }), "verify_visible");
  requireOk(data, "verify_visible");
  return data;
}

async function verifyText(
  ctx: ExerciseCtx,
  selector: string,
  text: string,
  exact = false,
): Promise<JsonRecord> {
  return payloadRecord(await ctx.call("verify_text", { selector, text, exact }), "verify_text");
}

async function waitForOutput(ctx: ExerciseCtx, text: string, timeoutMs = 3_000): Promise<JsonRecord> {
  await ctx.call("wait_for", { text, timeoutMs });
  return verifyText(ctx, WORKERS.out, text, false);
}

async function ensureDedicatedWorker(
  ctx: ExerciseCtx,
): Promise<{ workerId: string; listData: JsonRecord }> {
  await ctx.goto("/workers");
  await verifyVisible(ctx, WORKERS.spawn);
  await ctx.call("click", { selector: WORKERS.spawn });
  const visible = await waitForOutput(ctx, '"value":49');
  if (visible.ok !== true) {
    throw new Error("worker fixture did not print the square(7) result");
  }

  const listData = payloadRecord(await ctx.call("workers_list", { type: "web" }), "workers_list");
  requireOk(listData, "workers_list");
  const worker = asRecords(listData.workers).find((entry) => {
    const id = stringAt(entry, "workerId");
    return stringAt(entry, "type") === "web" && id !== undefined && id.startsWith("ww-");
  });
  const workerId = worker ? stringAt(worker, "workerId") : undefined;
  if (!workerId) throw new Error("workers_list did not include a dedicated worker id");
  return { workerId, listData };
}

async function prepareServiceWorker(
  ctx: ExerciseCtx,
): Promise<{ listData: JsonRecord; serviceWorkers: JsonRecord[] }> {
  await ctx.goto("/workers");
  await verifyVisible(ctx, WORKERS.registerSw);
  await ctx.call("click", { selector: WORKERS.registerSw });
  const registered = await waitForOutput(ctx, "sw-registered");
  if (registered.ok !== true) {
    throw new Error("service worker registration did not reach the page output");
  }

  await ctx.goto("/workers");
  await verifyVisible(ctx, WORKERS.swFetch);
  const listData = payloadRecord(await ctx.call("workers_list", { type: "service" }), "workers_list");
  requireOk(listData, "workers_list");
  const serviceWorkers = asRecords(listData.workers).filter(
    (entry) => stringAt(entry, "type") === "service",
  );
  return { listData, serviceWorkers };
}

function messageDataIncludes(messages: JsonRecord[], text: string): boolean {
  return messages.some((message) => stringAt(message, "data")?.includes(text) === true);
}

const workers_list = exercise(async (ctx) => {
  const { workerId, listData } = await ensureDedicatedWorker(ctx);
  return pass("workers_list exposed the dedicated worker spawned by the page", {
    workerId,
    workers: listData.workers,
  });
});

const worker_messages_read = exercise(async (ctx) => {
  const { workerId } = await ensureDedicatedWorker(ctx);
  const data = payloadRecord(
    await ctx.call("worker_messages_read", { workerId }),
    "worker_messages_read",
  );
  requireOk(data, "worker_messages_read");
  const messages = asRecords(data.messages);
  if (messageDataIncludes(messages, '"ready"') && messageDataIncludes(messages, '"value":49')) {
    return pass("worker_messages_read drained the ready and square-result worker frames", {
      workerId,
      messages,
    });
  }
  return fail("worker_messages_read did not include the expected worker frames", {
    workerId,
    messages,
  });
});

const worker_message_send = exercise(async (ctx) => {
  const { workerId } = await ensureDedicatedWorker(ctx);
  await ctx.call("worker_messages_read", { workerId });
  const sent = payloadRecord(
    await ctx.call("worker_message_send", { workerId, message: "hello-from-tool" }),
    "worker_message_send",
  );
  requireOk(sent, "worker_message_send");

  const visible = await waitForOutput(ctx, "hello-from-tool");
  if (visible.ok !== true) {
    return fail("worker_message_send did not produce a visible worker echo", {
      workerId,
      sent,
      visible,
    });
  }

  const read = payloadRecord(
    await ctx.call("worker_messages_read", { workerId }),
    "worker_messages_read",
  );
  const messages = asRecords(read.messages);
  if (read.ok === true && messageDataIncludes(messages, "hello-from-tool")) {
    return pass("worker_message_send posted to the worker and the echo was readable", {
      workerId,
      sent,
      messages,
    });
  }
  return fail("worker_message_send echo was visible but missing from worker_messages_read", {
    workerId,
    sent,
    read,
  });
});

const sw_intercept_fetch = exercise(async (ctx) => {
  const setup = await prepareServiceWorker(ctx);
  if (setup.serviceWorkers.length === 0) {
    return skip("service worker target was not discoverable in this browser session");
  }

  const pattern = "**/workers/sw-ping";
  const intercepted = payloadRecord(
    await ctx.call("sw_intercept_fetch", {
      pattern,
      response: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ fromTool: "sw_intercept_fetch" }),
      },
    }),
    "sw_intercept_fetch",
  );
  if (intercepted.ok !== true) {
    if (isStructuredRefusal(intercepted)) {
      return skip(`sw_intercept_fetch returned a structured refusal: ${String(intercepted.error)}`);
    }
    return fail("sw_intercept_fetch did not arm the interceptor", intercepted);
  }

  await ctx.call("click", { selector: WORKERS.swFetch });
  const visible = await waitForOutput(ctx, "sw_intercept_fetch");
  if (visible.ok === true) {
    return pass("sw_intercept_fetch rewrote the service-worker-handled fetch response", {
      setup: setup.listData,
      intercepted,
      visible,
    });
  }
  return fail("service-worker fetch did not show the intercepted response", {
    setup: setup.listData,
    intercepted,
    visible,
  });
});

const sw_unintercept_fetch = exercise(async (ctx) => {
  const setup = await prepareServiceWorker(ctx);
  if (setup.serviceWorkers.length === 0) {
    return skip("service worker target was not discoverable in this browser session");
  }

  const pattern = "**/workers/sw-ping";
  const armed = payloadRecord(
    await ctx.call("sw_intercept_fetch", {
      pattern,
      response: {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ fromTool: "temporary-sw-intercept" }),
      },
    }),
    "sw_intercept_fetch",
  );
  if (armed.ok !== true) {
    if (isStructuredRefusal(armed)) {
      return skip(`sw_intercept_fetch returned a structured refusal: ${String(armed.error)}`);
    }
    return fail("setup sw_intercept_fetch did not arm the interceptor", armed);
  }

  await ctx.call("click", { selector: WORKERS.swFetch });
  const firstFetch = await waitForOutput(ctx, "temporary-sw-intercept");
  if (firstFetch.ok !== true) {
    return fail("setup fetch did not prove the temporary interceptor was active", {
      setup: setup.listData,
      armed,
      firstFetch,
    });
  }

  const removed = payloadRecord(
    await ctx.call("sw_unintercept_fetch", { pattern }),
    "sw_unintercept_fetch",
  );
  if (removed.ok !== true) {
    if (isStructuredRefusal(removed)) {
      return skip(`sw_unintercept_fetch returned a structured refusal: ${String(removed.error)}`);
    }
    return fail("sw_unintercept_fetch did not remove the interceptor", removed);
  }

  await ctx.goto("/workers");
  await verifyVisible(ctx, WORKERS.swFetch);
  await ctx.call("click", { selector: WORKERS.swFetch });
  const passThrough = await waitForOutput(ctx, '"fromServiceWorker":true');
  if (passThrough.ok === true) {
    return pass("sw_unintercept_fetch restored the service worker's native response", {
      setup: setup.listData,
      armed,
      removed,
      passThrough,
    });
  }
  return fail("fetch still did not show the service worker's native response after removal", {
    setup: setup.listData,
    armed,
    removed,
    passThrough,
  });
});

const map: ExerciseMap = {
  workers_list,
  worker_messages_read,
  worker_message_send,
  sw_intercept_fetch,
  sw_unintercept_fetch,
};

export default map;
