import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass } from "../types.js";

type JsonRecord = Record<string, unknown>;

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

function noProvider(data: JsonRecord | undefined, provider: string): boolean {
  const error = stringAt(data, "error")?.toLowerCase() ?? "";
  const hint = stringAt(data, "hint") ?? "";
  return data?.ok === false && error.includes(provider) && hint.length > 0;
}

/** A well-formed structured provider FAILURE: the credentials capability is
 *  wired and the provider responded with an actionable result rather than
 *  throwing/leaking. Covers both "no provider configured" (`provider:"none"`)
 *  AND "provider configured but no seed/credential for this account" (e.g. the
 *  default `oathtool` backend returns `{ok:false, provider:"oathtool", error,
 *  hint}`). Either is correct behavior to verify. */
function structuredProviderFailure(data: JsonRecord | undefined): boolean {
  if (data?.ok !== false) return false;
  const providerOk = typeof data.provider === "string" || data.provider === null;
  const error = stringAt(data, "error") ?? "";
  const hint = stringAt(data, "hint") ?? "";
  return providerOk && (error.length > 0 || hint.length > 0);
}

const solve_captcha = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const result = await ctx.call("solve_captcha", {
    type: "recaptcha2",
    siteKey: "testbed-site-key",
  });
  const data = dataRecord(result);
  if (data?.ok === false && data.provider === null && noProvider(data, "captcha provider")) {
    return pass("solve_captcha returned the expected structured no-provider result", data);
  }
  if (data?.ok === true && typeof data.solution === "string") {
    return pass("solve_captcha returned a provider solution in this configured environment", data);
  }
  return fail("solve_captcha did not return a well-formed provider result", data ?? result);
});

const get_totp = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const result = await ctx.call("get_totp", { account: "capability-testbed" });
  const data = dataRecord(result);
  if (structuredProviderFailure(data)) {
    return pass("get_totp returned a well-formed structured provider result (no seed/provider configured)", data);
  }
  if (data?.ok === true && typeof data.code === "string" && typeof data.provider === "string") {
    return pass("get_totp returned a provider code in this configured environment", {
      ok: data.ok,
      provider: data.provider,
      codeLength: data.code.length,
    });
  }
  return fail("get_totp did not return a well-formed provider result", data ?? result);
});

const get_credential = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const result = await ctx.call("get_credential", { account: "capability-testbed" });
  const data = dataRecord(result);
  if (structuredProviderFailure(data)) {
    return pass("get_credential returned a well-formed structured provider result (no seed/provider configured)", data);
  }
  if (
    data?.ok === true &&
    typeof data.username === "string" &&
    typeof data.aliasName === "string" &&
    !("password" in data)
  ) {
    return pass("get_credential returned username plus password alias without cleartext", data);
  }
  return fail("get_credential did not return a well-formed provider result", data ?? result);
});

const map: ExerciseMap = {
  solve_captcha,
  get_totp,
  get_credential,
};

export default map;
