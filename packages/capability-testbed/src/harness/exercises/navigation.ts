import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass } from "../types.js";

type JsonRecord = Record<string, unknown>;

const CORE = {
  title: '[data-testid="surface-title"]',
} as const;

const FORMS = {
  title: '[data-testid="surface-title"]',
} as const;

const SCROLL = {
  lazyLoaded: '[data-testid="lazy-loaded"]',
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

function numberAt(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function verifyText(
  ctx: ExerciseCtx,
  selector: string,
  text: string,
  exact = false,
): Promise<JsonRecord> {
  return payloadRecord(await ctx.call("verify_text", { selector, text, exact }), "verify_text");
}

async function verifyVisible(ctx: ExerciseCtx, selector: string): Promise<JsonRecord> {
  return payloadRecord(await ctx.call("verify_visible", { selector }), "verify_visible");
}

async function evalValue(ctx: ExerciseCtx, expr: string): Promise<unknown> {
  const data = payloadRecord(await ctx.call("eval_js", { expr, returnType: "json" }), "eval_js");
  if (data.ok !== true) throw new Error("eval_js did not return ok:true");
  return data.value;
}

const navigate = exercise(async (ctx) => {
  await ctx.goto("/core");
  const data = payloadRecord(
    await ctx.call("navigate", { url: `${ctx.baseUrl}/forms` }),
    "navigate",
  );
  const verified = await verifyText(ctx, FORMS.title, "Forms & input surface", true);
  if (data.ok === true && verified.ok === true) {
    return pass("navigate loaded the forms surface from the core surface", {
      navigation: data.navigation,
      verified,
    });
  }
  return fail("navigate did not load the forms surface", { data, verified });
});

const go_back = exercise(async (ctx) => {
  await ctx.goto("/core");
  await ctx.call("navigate", { url: `${ctx.baseUrl}/forms` });
  const onForms = await verifyText(ctx, FORMS.title, "Forms & input surface", true);
  const data = payloadRecord(await ctx.call("go_back"), "go_back");
  const verified = await verifyText(ctx, CORE.title, "Core read surface", true);
  if (onForms.ok === true && data.ok === true && verified.ok === true) {
    return pass("go_back returned from forms to the core surface", {
      action: data,
      verified,
    });
  }
  return fail("go_back did not return to the core surface", { onForms, data, verified });
});

const go_forward = exercise(async (ctx) => {
  await ctx.goto("/core");
  await ctx.call("navigate", { url: `${ctx.baseUrl}/forms` });
  await ctx.call("go_back");
  const onCore = await verifyText(ctx, CORE.title, "Core read surface", true);
  const data = payloadRecord(await ctx.call("go_forward"), "go_forward");
  const verified = await verifyText(ctx, FORMS.title, "Forms & input surface", true);
  if (onCore.ok === true && data.ok === true && verified.ok === true) {
    return pass("go_forward returned from core to the forms surface", {
      action: data,
      verified,
    });
  }
  return fail("go_forward did not return to the forms surface", { onCore, data, verified });
});

const set_viewport = exercise(async (ctx) => {
  await ctx.goto("/core");
  const data = payloadRecord(await ctx.call("set_viewport", { width: 375, height: 667 }), "set_viewport");
  const observed = await evalValue(
    ctx,
    '({ width: window.innerWidth, height: window.innerHeight, mobile: matchMedia("(max-width: 480px)").matches })',
  );
  if (
    data.ok === true &&
    isRecord(observed) &&
    numberAt(observed, "width") === 375 &&
    numberAt(observed, "height") === 667 &&
    observed.mobile === true
  ) {
    return pass("set_viewport resized the live page and matched the mobile breakpoint", {
      action: data,
      observed,
    });
  }
  return fail("set_viewport did not apply the requested viewport", { data, observed });
});

const tab_visibility = exercise(async (ctx) => {
  await ctx.goto("/core");
  const data = payloadRecord(
    await ctx.call("tab_visibility", { state: "background", holdMs: 100 }),
    "tab_visibility",
  );
  const observed = await evalValue(ctx, "({ state: document.visibilityState, hidden: document.hidden })");
  if (
    data.ok === true &&
    data.state === "foreground" &&
    isRecord(observed) &&
    observed.state === "visible" &&
    observed.hidden === false
  ) {
    return pass("tab_visibility exercised the background hold and restored foreground visibility", {
      action: data,
      observed,
    });
  }
  return fail("tab_visibility did not restore visible foreground state", { data, observed });
});

const scroll = exercise(async (ctx) => {
  await ctx.goto("/scroll");
  const data = payloadRecord(await ctx.call("scroll", { to: "bottom" }), "scroll");
  await delay(250);
  const visible = await verifyVisible(ctx, SCROLL.lazyLoaded);
  const text = await verifyText(ctx, SCROLL.lazyLoaded, "lazy content loaded");
  const element = recordAt(data, "element");
  const scroller = element ? recordAt(element, "scroll") : undefined;
  if (data.ok === true && visible.ok === true && text.ok === true) {
    return pass("scroll reached the bottom sentinel and lazy content became visible", {
      action: { ok: data.ok, scroll: scroller },
      visible,
      text,
    });
  }
  return fail("scroll did not reveal the lazy-loaded bottom content", { data, visible, text });
});

const map: ExerciseMap = {
  navigate,
  go_back,
  go_forward,
  set_viewport,
  tab_visibility,
  scroll,
};

export default map;
