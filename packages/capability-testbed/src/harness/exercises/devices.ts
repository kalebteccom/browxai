import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass } from "../types.js";

type JsonRecord = Record<string, unknown>;

const DEVICES = {
  bluetooth: '[data-testid="req-bluetooth"]',
  usb: '[data-testid="req-usb"]',
  hid: '[data-testid="req-hid"]',
  out: '[data-testid="device-out"]',
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
  const data = isRecord(value) && "data" in value ? value.data : undefined;
  const text = firstText(value);
  if (data !== undefined) return data;
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
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

function catalogHasDevice(data: JsonRecord, name: string): boolean {
  const catalog = recordAt(data, "catalog");
  return records(catalog?.devices).some((entry) => stringAt(entry, "name") === name);
}

function requestFor(data: JsonRecord, api: string): JsonRecord | undefined {
  return records(data.requests).find((entry) => stringAt(entry, "api") === api);
}

async function verifyText(ctx: ExerciseCtx, selector: string, text: string, exact = false): Promise<JsonRecord> {
  return payloadRecord(await ctx.call("verify_text", { selector, text, exact }), "verify_text");
}

async function clickAndVerifyOutput(
  ctx: ExerciseCtx,
  selector: string,
  expectedText: string,
): Promise<{ click: JsonRecord; wait: JsonRecord; verify: JsonRecord }> {
  const click = payloadRecord(await ctx.call("click", { selector }), "click");
  const wait = payloadRecord(await ctx.call("wait_for", { text: expectedText, timeoutMs: 2_500 }), "wait_for");
  const verify = await verifyText(ctx, DEVICES.out, expectedText, true);
  return { click, wait, verify };
}

async function readRequests(ctx: ExerciseCtx): Promise<JsonRecord> {
  return payloadRecord(await ctx.call("device_requests"), "device_requests");
}

const emulate_bluetooth = exercise(async (ctx) => {
  const name = "browxai-bt-testbed";
  const staged = payloadRecord(
    await ctx.call("emulate_bluetooth", {
      devices: [{ name, id: "bt-testbed-1", services: ["battery_service"] }],
    }),
    "emulate_bluetooth",
  );
  await ctx.goto("/devices");
  const page = await clickAndVerifyOutput(ctx, DEVICES.bluetooth, `bt:${name}`);
  const requests = await readRequests(ctx);
  const request = requestFor(requests, "bluetooth");
  if (
    staged.ok === true &&
    staged.api === "bluetooth" &&
    catalogHasDevice(staged, name) &&
    page.verify.ok === true &&
    request?.handledAs === "resolved" &&
    numberAt(request, "returned") === 1
  ) {
    return pass("emulate_bluetooth staged a device consumed by navigator.bluetooth.requestDevice", {
      staged,
      page,
      request,
    });
  }
  return fail("emulate_bluetooth did not produce the expected synthetic Bluetooth flow", {
    staged,
    page,
    requests,
  });
});

const emulate_usb = exercise(async (ctx) => {
  const name = "browxai-usb-testbed";
  const staged = payloadRecord(
    await ctx.call("emulate_usb", {
      devices: [{ name, vendorId: 0x1209, productId: 0xb0b0, manufacturerName: "browxai" }],
    }),
    "emulate_usb",
  );
  await ctx.goto("/devices");
  const page = await clickAndVerifyOutput(ctx, DEVICES.usb, `usb:${name}`);
  const requests = await readRequests(ctx);
  const request = requestFor(requests, "usb");
  if (
    staged.ok === true &&
    staged.api === "usb" &&
    catalogHasDevice(staged, name) &&
    page.verify.ok === true &&
    request?.handledAs === "resolved" &&
    numberAt(request, "returned") === 1
  ) {
    return pass("emulate_usb staged a device consumed by navigator.usb.requestDevice", {
      staged,
      page,
      request,
    });
  }
  return fail("emulate_usb did not produce the expected synthetic USB flow", { staged, page, requests });
});

const emulate_hid = exercise(async (ctx) => {
  const name = "browxai-hid-testbed";
  const staged = payloadRecord(
    await ctx.call("emulate_hid", {
      devices: [{ name, vendorId: 0x1209, productId: 0xb0b1, collections: [] }],
    }),
    "emulate_hid",
  );
  await ctx.goto("/devices");
  const page = await clickAndVerifyOutput(ctx, DEVICES.hid, "hid:1");
  const requests = await readRequests(ctx);
  const request = requestFor(requests, "hid");
  if (
    staged.ok === true &&
    staged.api === "hid" &&
    catalogHasDevice(staged, name) &&
    page.verify.ok === true &&
    request?.handledAs === "resolved" &&
    numberAt(request, "returned") === 1
  ) {
    return pass("emulate_hid staged a device list consumed by navigator.hid.requestDevice", {
      staged,
      page,
      request,
    });
  }
  return fail("emulate_hid did not produce the expected synthetic HID flow", { staged, page, requests });
});

const device_requests = exercise(async (ctx) => {
  const name = "browxai-requests-usb";
  const staged = payloadRecord(
    await ctx.call("emulate_usb", {
      devices: [{ name, vendorId: 0x1209, productId: 0xb0c0 }],
    }),
    "emulate_usb",
  );
  await ctx.goto("/devices");
  const page = await clickAndVerifyOutput(ctx, DEVICES.usb, `usb:${name}`);
  const data = await readRequests(ctx);
  const request = requestFor(data, "usb");
  if (
    data.ok === true &&
    Array.isArray(data.supportedApis) &&
    data.supportedApis.includes("usb") &&
    request?.handledAs === "resolved" &&
    numberAt(request, "returned") === 1 &&
    numberAt(request, "ts") !== undefined
  ) {
    return pass("device_requests returned the captured WebUSB requestDevice call", {
      staged,
      page,
      data,
      request,
    });
  }
  return fail("device_requests did not include the expected captured request", { staged, page, data });
});

const exercises = {
  emulate_bluetooth,
  emulate_usb,
  emulate_hid,
  device_requests,
} satisfies ExerciseMap;

export default exercises;
