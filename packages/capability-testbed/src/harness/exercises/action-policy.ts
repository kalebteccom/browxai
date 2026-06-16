import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass, skip } from "../types.js";

type JsonRecord = Record<string, unknown>;

const DIALOGS = {
  confirm: '[data-testid="do-confirm"]',
  out: '[data-testid="dialog-out"]',
} as const;

const MEDIA = {
  download: '[data-testid="download-link"]',
  fsaOut: '[data-testid="fsa-out"]',
  openPicker: '[data-testid="open-picker"]',
} as const;

const PERMISSIONS = {
  geo: '[data-testid="req-geo"]',
  notif: '[data-testid="req-notif"]',
  out: '[data-testid="perm-out"]',
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

function requireOk(record: JsonRecord, label: string): void {
  if (record.ok !== true) {
    throw new Error(`${label} did not return ok:true`);
  }
}

function unsupportedEngine(record: JsonRecord): boolean {
  return record.ok === false && typeof record.engine === "string";
}

function structuredRefusal(record: JsonRecord): boolean {
  return record.ok === false && typeof record.error === "string";
}

function safeSession(ctx: ExerciseCtx): string {
  return ctx.session.replace(/[^A-Za-z0-9._-]/g, "_") || "default";
}

function origin(ctx: ExerciseCtx): string {
  return new URL(ctx.baseUrl).origin;
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

async function verifyVisible(ctx: ExerciseCtx, selector: string): Promise<JsonRecord> {
  const result = await ctx.call("verify_visible", { selector });
  const data = payloadRecord(result, "verify_visible");
  requireOk(data, "verify_visible");
  return data;
}

async function evalValue(ctx: ExerciseCtx, expr: string): Promise<unknown> {
  const data = payloadRecord(await ctx.call("eval_js", { expr, returnType: "json" }), "eval_js");
  requireOk(data, "eval_js");
  return data.value;
}

const set_dialog_policy = exercise(async (ctx) => {
  await ctx.goto("/dialogs");
  const policy = payloadRecord(await ctx.call("set_dialog_policy", { mode: "accept" }), "set_dialog_policy");
  requireOk(policy, "set_dialog_policy");
  await ctx.call("click", { selector: DIALOGS.confirm });
  const verified = await verifyText(ctx, DIALOGS.out, "confirm:true", true);
  if (recordAt(policy, "policy")?.mode === "accept") {
    return pass("set_dialog_policy accepted a confirm dialog and the page observed true", {
      policy,
      verified,
    });
  }
  return fail("set_dialog_policy did not report the accepted policy", policy);
});

const grant_permissions = exercise(async (ctx) => {
  await ctx.goto("/permissions");
  const granted = payloadRecord(
    await ctx.call("grant_permissions", { permissions: ["geolocation"], origin: origin(ctx) }),
    "grant_permissions",
  );
  requireOk(granted, "grant_permissions");
  const state = payloadRecord(
    await ctx.call("permission_state", { permissions: ["geolocation"], origin: origin(ctx) }),
    "permission_state",
  );
  requireOk(state, "permission_state");
  await ctx.call("set_permission_policy", {
    mode: "allow",
    perPermission: { geolocation: "allow" },
  });
  await ctx.call("set_geolocation", { latitude: 12.34, longitude: 56.78, accuracy: 3 });
  await ctx.call("click", { selector: PERMISSIONS.geo });
  const verified = await verifyText(ctx, PERMISSIONS.out, "geo:12.34,56.78");
  if (recordAt(state, "states")?.geolocation === "granted") {
    return pass("grant_permissions granted geolocation and the page received the synthetic position", {
      granted,
      states: state.states,
      verified,
    });
  }
  return fail("grant_permissions did not produce a granted geolocation state", { granted, state });
});

const set_permission_policy = exercise(async (ctx) => {
  await ctx.goto("/permissions");
  const policy = payloadRecord(
    await ctx.call("set_permission_policy", {
      mode: "deny",
      perPermission: { geolocation: "deny" },
    }),
    "set_permission_policy",
  );
  requireOk(policy, "set_permission_policy");
  await ctx.call("click", { selector: PERMISSIONS.geo });
  const verified = await verifyText(ctx, PERMISSIONS.out, "geo-error:");
  if (recordAt(policy, "policy")?.mode === "deny") {
    return pass("set_permission_policy denied a geolocation request without hanging the page", {
      policy,
      verified,
    });
  }
  return fail("set_permission_policy did not report the deny policy", policy);
});

const set_notification_policy = exercise(async (ctx) => {
  await ctx.goto("/permissions");
  await ctx.call("set_permission_policy", {
    mode: "allow",
    perPermission: { notifications: "allow" },
  });
  const policy = payloadRecord(
    await ctx.call("set_notification_policy", { mode: "deny" }),
    "set_notification_policy",
  );
  requireOk(policy, "set_notification_policy");
  await ctx.call("click", { selector: PERMISSIONS.notif });
  const verified = await verifyText(ctx, PERMISSIONS.out, "ctor:");
  if (recordAt(policy, "policy")?.mode === "deny") {
    return pass("set_notification_policy denied the Notification constructor and the page caught it", {
      policy,
      verified,
    });
  }
  return fail("set_notification_policy did not report the deny policy", policy);
});

const set_geolocation = exercise(async (ctx) => {
  await ctx.goto("/permissions");
  await ctx.call("grant_permissions", { permissions: ["geolocation"], origin: origin(ctx) });
  await ctx.call("set_permission_policy", {
    mode: "allow",
    perPermission: { geolocation: "allow" },
  });
  const geo = payloadRecord(
    await ctx.call("set_geolocation", { latitude: 37.7749, longitude: -122.4194, accuracy: 5 }),
    "set_geolocation",
  );
  requireOk(geo, "set_geolocation");
  await ctx.call("click", { selector: PERMISSIONS.geo });
  const verified = await verifyText(ctx, PERMISSIONS.out, "geo:37.7749,-122.4194");
  const applied = recordAt(geo, "applied");
  const appliedGeolocation = applied ? recordAt(applied, "geolocation") : undefined;
  if (appliedGeolocation) {
    return pass("set_geolocation supplied coordinates to getCurrentPosition", {
      applied,
      verified,
    });
  }
  return fail("set_geolocation did not report applied coordinates", geo);
});

const set_fs_picker_policy = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  const policy = payloadRecord(
    await ctx.call("set_fs_picker_policy", {
      mode: "deny",
      perAPI: { showOpenFilePicker: "deny" },
    }),
    "set_fs_picker_policy",
  );
  requireOk(policy, "set_fs_picker_policy");
  await ctx.call("click", { selector: MEDIA.openPicker });
  const verified = await verifyText(ctx, MEDIA.fsaOut, "open-error:");
  if (recordAt(policy, "policy")?.mode === "deny") {
    return pass("set_fs_picker_policy denied showOpenFilePicker and the page surfaced the rejection", {
      policy,
      verified,
    });
  }
  return fail("set_fs_picker_policy did not report the deny policy", policy);
});

const pdf_save = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  const path = `capability-testbed/action-policy/${safeSession(ctx)}-media.pdf`;
  const result = payloadRecord(
    await ctx.call("pdf_save", { path, format: "A4", printBackground: true }),
    "pdf_save",
  );
  if (structuredRefusal(result)) {
    return skip(`pdf_save refused in this session: ${String(result.error)}`);
  }
  if (unsupportedEngine(result)) return skip(`pdf_save unsupported on engine: ${String(result.engine)}`);
  requireOk(result, "pdf_save");
  const visible = await verifyVisible(ctx, MEDIA.download);
  if (numberAt(result, "bytes") !== undefined && Number(result.bytes) > 0 && stringAt(result, "path")) {
    return pass("pdf_save wrote non-empty PDF bytes and the media page stayed observable", {
      path: result.path,
      bytes: result.bytes,
      visible,
    });
  }
  return fail("pdf_save did not report a non-empty PDF artifact", result);
});

const set_locale = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = payloadRecord(await ctx.call("set_locale", { locale: "fr-FR" }), "set_locale");
  if (unsupportedEngine(result)) return skip(`set_locale unsupported on engine: ${String(result.engine)}`);
  requireOk(result, "set_locale");
  const value = await evalValue(
    ctx,
    "({ language: navigator.language, locale: Intl.DateTimeFormat().resolvedOptions().locale })",
  );
  if (isRecord(value) && stringAt(value, "language")?.toLowerCase().startsWith("fr")) {
    return pass("set_locale changed navigator.language on the live page", {
      applied: result.applied,
      observed: value,
    });
  }
  return fail("set_locale did not change navigator.language", { result, observed: value });
});

const set_timezone = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = payloadRecord(
    await ctx.call("set_timezone", { timezoneId: "Asia/Tokyo" }),
    "set_timezone",
  );
  if (unsupportedEngine(result)) return skip(`set_timezone unsupported on engine: ${String(result.engine)}`);
  requireOk(result, "set_timezone");
  const value = await evalValue(ctx, "Intl.DateTimeFormat().resolvedOptions().timeZone");
  if (value === "Asia/Tokyo") {
    return pass("set_timezone changed Intl.DateTimeFormat timeZone", {
      applied: result.applied,
      observed: value,
    });
  }
  return fail("set_timezone did not change the page timeZone", { result, observed: value });
});

const set_color_scheme = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = payloadRecord(
    await ctx.call("set_color_scheme", { scheme: "dark" }),
    "set_color_scheme",
  );
  requireOk(result, "set_color_scheme");
  const value = await evalValue(ctx, 'matchMedia("(prefers-color-scheme: dark)").matches');
  if (value === true) {
    return pass("set_color_scheme made the dark color-scheme media query match", {
      applied: result.applied,
      observed: value,
    });
  }
  return fail("set_color_scheme did not affect matchMedia", { result, observed: value });
});

const set_reduced_motion = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = payloadRecord(
    await ctx.call("set_reduced_motion", { on: true }),
    "set_reduced_motion",
  );
  requireOk(result, "set_reduced_motion");
  const value = await evalValue(ctx, 'matchMedia("(prefers-reduced-motion: reduce)").matches');
  if (value === true) {
    return pass("set_reduced_motion made the reduced-motion media query match", {
      applied: result.applied,
      observed: value,
    });
  }
  return fail("set_reduced_motion did not affect matchMedia", { result, observed: value });
});

const set_user_agent = exercise(async (ctx) => {
  await ctx.goto("/core");
  const userAgent = "browxai-testbed/1.0";
  const result = payloadRecord(await ctx.call("set_user_agent", { userAgent }), "set_user_agent");
  if (unsupportedEngine(result)) return skip(`set_user_agent unsupported on engine: ${String(result.engine)}`);
  requireOk(result, "set_user_agent");
  const value = await evalValue(ctx, "navigator.userAgent");
  if (typeof value === "string" && value.includes(userAgent)) {
    return pass("set_user_agent changed navigator.userAgent on the live page", {
      applied: result.applied,
      observed: value,
    });
  }
  return fail("set_user_agent did not change navigator.userAgent", { result, observed: value });
});

const map: ExerciseMap = {
  set_dialog_policy,
  grant_permissions,
  set_permission_policy,
  set_notification_policy,
  set_geolocation,
  set_fs_picker_policy,
  pdf_save,
  set_locale,
  set_timezone,
  set_color_scheme,
  set_reduced_motion,
  set_user_agent,
};

export default map;
