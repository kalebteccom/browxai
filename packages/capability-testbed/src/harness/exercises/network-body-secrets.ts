import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass } from "../types.js";

type JsonRecord = Record<string, unknown>;

const SECRET_VALUE = "sk-test-DEADBEEF-secret-value";
const SECRET_ALIAS = "TESTBED_SECRET";

function exercise(fn: (ctx: ExerciseCtx) => Promise<ExerciseResult>): Exercise {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      return fail("exercise failed unexpectedly", errorEvidence(err));
    }
  };
}

function errorEvidence(err: unknown): JsonRecord {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { thrown: err };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
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

function dataRecord(value: unknown): JsonRecord | undefined {
  const data = payload(value);
  return isRecord(data) ? data : undefined;
}

function stringAt(record: JsonRecord | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

async function captureSecretRequestId(ctx: ExerciseCtx): Promise<string | undefined> {
  await ctx.call("navigate", { url: `${ctx.baseUrl}/api/secret` });
  const network = dataRecord(await ctx.call("network_read", { limit: 20 }));
  const request = records(network?.requests)
    .reverse()
    .find((entry) => stringAt(entry, "url")?.includes("/api/secret"));
  return stringAt(request, "requestId");
}

const network_body = exercise(async (ctx) => {
  await ctx.goto("/network");
  const requestId = await captureSecretRequestId(ctx);
  if (!requestId) return fail("network_read did not expose a requestId for /api/secret");
  const body = dataRecord(await ctx.call("network_body", { requestId }));
  const text = stringAt(body, "body");
  // network_body omits `truncated` entirely when the body came back whole (the
  // field is only present when it is true), so accept absent-or-false.
  if (body?.ok === true && text?.includes(SECRET_VALUE) && body.truncated !== true) {
    return pass("network_body returned the full /api/secret response body", {
      requestId,
      body,
    });
  }
  return fail("network_body did not return the expected secret response body", {
    requestId,
    body,
  });
});

const register_secret = exercise(async (ctx) => {
  await ctx.goto("/network");
  const registered = dataRecord(
    await ctx.call("register_secret", {
      name: SECRET_ALIAS,
      value: SECRET_VALUE,
      scope: ctx.baseUrl,
    }),
  );
  const requestId = await captureSecretRequestId(ctx);
  if (!requestId) return fail("network_read did not expose a requestId for masked /api/secret");
  const body = dataRecord(await ctx.call("network_body", { requestId }));
  const text = stringAt(body, "body");
  if (
    registered?.ok === true &&
    Array.isArray(registered.names) &&
    registered.names.includes(SECRET_ALIAS) &&
    body?.ok === true &&
    text?.includes(`<${SECRET_ALIAS}>`) &&
    !text.includes(SECRET_VALUE)
  ) {
    return pass("register_secret masked the secret value in network_body egress", {
      registered,
      body,
    });
  }
  return fail("register_secret did not mask the secret response body", {
    registered,
    body,
  });
});

const map: ExerciseMap = {
  network_body,
  register_secret,
};

export default map;
