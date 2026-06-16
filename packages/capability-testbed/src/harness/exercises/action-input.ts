import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass } from "../types.js";

type JsonRecord = Record<string, unknown>;

const FORM = {
  signup: '[data-testid="signup"]',
  name: '[data-testid="name"]',
  email: '[data-testid="email"]',
  password: '[data-testid="password"]',
  bio: '[data-testid="bio"]',
  role: '[data-testid="role"]',
  hoverBtn: '[data-testid="hover-btn"]',
  hoverOut: '[data-testid="hover-out"]',
  submit: '[data-testid="submit"]',
  result: '[data-testid="result"]',
  clipDst: '[data-testid="clip-dst"]',
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
  const data = isRecord(value) && "data" in value ? value.data : undefined;
  const text = firstText(value);
  if (data !== undefined) return data;
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

function actionFailed(tool: string, data: JsonRecord): ExerciseResult | undefined {
  return data.ok === true ? undefined : fail(`${tool} returned ok:false`, data);
}

async function verifyText(
  ctx: ExerciseCtx,
  selector: string,
  text: string,
  exact = false,
): Promise<JsonRecord> {
  return payloadRecord(await ctx.call("verify_text", { selector, text, exact }), "verify_text");
}

async function verifyValue(ctx: ExerciseCtx, selector: string, value: string): Promise<JsonRecord> {
  return payloadRecord(await ctx.call("verify_value", { selector, value }), "verify_value");
}

async function verifyAttribute(
  ctx: ExerciseCtx,
  selector: string,
  attr: string,
  value?: string,
): Promise<JsonRecord> {
  const args: Record<string, unknown> = { selector, attr };
  if (value !== undefined) args.value = value;
  return payloadRecord(await ctx.call("verify_attribute", args), "verify_attribute");
}

async function evalRecord(ctx: ExerciseCtx, expr: string, label: string): Promise<JsonRecord> {
  const data = payloadRecord(await ctx.call("eval_js", { expr }), "eval_js");
  if (data.ok !== true) throw new Error(`${label} eval_js returned ok:false`);
  const value = data.value;
  if (!isRecord(value)) throw new Error(`${label} eval_js value was not an object`);
  return value;
}

async function formResult(ctx: ExerciseCtx): Promise<JsonRecord> {
  const state = await evalRecord(
    ctx,
    `(() => {
      const node = document.querySelector('[data-testid="result"]');
      if (!node) return { found: false };
      const text = node.textContent || "";
      let parsed = null;
      let parseError = null;
      try {
        parsed = text.trim() ? JSON.parse(text) : null;
      } catch (err) {
        parseError = String(err);
      }
      return {
        found: true,
        submitted: node.getAttribute("data-submitted"),
        text,
        parsed,
        parseError
      };
    })()`,
    "form result",
  );
  const parsed = recordAt(state, "parsed");
  if (!parsed) throw new Error("form result was not submitted JSON");
  return { state, parsed };
}

function verifyOk(data: JsonRecord): boolean {
  return data.ok === true;
}

const click = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const action = payloadRecord(await ctx.call("click", { selector: FORM.submit }), "click");
  const failed = actionFailed("click", action);
  if (failed) return failed;
  const attr = await verifyAttribute(ctx, FORM.result, "data-submitted", "1");
  const result = await formResult(ctx);
  const parsed = recordAt(result, "parsed");
  if (verifyOk(attr) && parsed && stringAt(parsed, "volume") === "50") {
    return pass("click submitted the form and produced result JSON", { action, attr, result });
  }
  return fail("click did not produce the expected submitted form state", { action, attr, result });
});

const fill = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const value = "Ada Lovelace";
  const action = payloadRecord(await ctx.call("fill", { selector: FORM.name, value }), "fill");
  const failed = actionFailed("fill", action);
  if (failed) return failed;
  const verify = await verifyValue(ctx, FORM.name, value);
  if (verifyOk(verify)) {
    return pass("fill wrote the requested name input value", { action, verify });
  }
  return fail("fill did not land in the name input", { action, verify });
});

const press = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const action = payloadRecord(await ctx.call("press", { selector: FORM.name, key: "Tab" }), "press");
  const failed = actionFailed("press", action);
  if (failed) return failed;
  const state = await evalRecord(
    ctx,
    `(() => {
      const active = document.activeElement;
      return { activeTestId: active ? active.getAttribute("data-testid") : null };
    })()`,
    "active element",
  );
  if (state.activeTestId === "email") {
    return pass("press focused the name input then Tab moved focus to email", { action, state });
  }
  return fail("press did not move focus from name to email", { action, state });
});

const shortcut = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const value = "select this payload";
  const fillAction = payloadRecord(await ctx.call("fill", { selector: FORM.clipDst, value }), "fill");
  const fillFailed = actionFailed("fill setup", fillAction);
  if (fillFailed) return fillFailed;
  const fillVerify = await verifyValue(ctx, FORM.clipDst, value);
  if (!verifyOk(fillVerify)) {
    return fail("shortcut setup fill did not land", { fillAction, fillVerify });
  }
  const action = payloadRecord(
    await ctx.call("shortcut", { selector: FORM.clipDst, keys: "ControlOrMeta+A" }),
    "shortcut",
  );
  const failed = actionFailed("shortcut", action);
  if (failed) return failed;
  const state = await evalRecord(
    ctx,
    `(() => {
      const input = document.querySelector('[data-testid="clip-dst"]');
      if (!(input instanceof HTMLInputElement)) return { found: false };
      return {
        found: true,
        value: input.value,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        activeTestId: document.activeElement ? document.activeElement.getAttribute("data-testid") : null
      };
    })()`,
    "shortcut selection",
  );
  if (
    state.found === true &&
    state.value === value &&
    numberAt(state, "selectionStart") === 0 &&
    numberAt(state, "selectionEnd") === value.length
  ) {
    return pass("shortcut selected all text in the focused clipboard field", {
      action,
      state,
    });
  }
  return fail("shortcut did not select the field contents", { action, state });
});

const hover = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const action = payloadRecord(await ctx.call("hover", { selector: FORM.hoverBtn }), "hover");
  const failed = actionFailed("hover", action);
  if (failed) return failed;
  const verify = await verifyText(ctx, FORM.hoverOut, "hovered", true);
  if (verifyOk(verify)) {
    return pass("hover fired the hover surface handler", { action, verify });
  }
  return fail("hover did not update the hover output", { action, verify });
});

const select = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const action = payloadRecord(
    await ctx.call("select", { selector: FORM.role, values: ["editor"] }),
    "select",
  );
  const failed = actionFailed("select", action);
  if (failed) return failed;
  const verify = await verifyValue(ctx, FORM.role, "editor");
  if (verifyOk(verify)) {
    return pass("select chose the editor role by option value", { action, verify });
  }
  return fail("select did not set the role value to editor", { action, verify });
});

const choose_option = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const setup = await evalRecord(
    ctx,
    `(() => {
      const select = document.querySelector('[data-testid="role"]');
      if (!(select instanceof HTMLSelectElement)) return { ok: false, error: "role select missing" };
      select.setAttribute("size", String(select.options.length));
      return { ok: true, size: select.getAttribute("size") };
    })()`,
    "choose_option setup",
  );
  if (setup.ok !== true) return fail("choose_option setup could not expose role options", setup);
  const setupVerify = await verifyAttribute(ctx, FORM.role, "size", "4");
  if (!verifyOk(setupVerify)) {
    return fail("choose_option setup did not expose the native role options", {
      setup,
      setupVerify,
    });
  }
  const action = payloadRecord(
    await ctx.call("choose_option", { selector: FORM.role, option: "Editor", exact: true }),
    "choose_option",
  );
  const verify = await verifyValue(ctx, FORM.role, "editor");
  const failed = actionFailed("choose_option", action);
  if (failed) {
    return fail("choose_option could not choose Editor on the role control", {
      setup,
      setupVerify,
      action,
      verify,
    });
  }
  if (verifyOk(verify)) {
    return pass("choose_option chose the Editor label on the role control", {
      setup,
      setupVerify,
      action,
      verify,
    });
  }
  return fail("choose_option did not set the role value to editor", {
    setup,
    setupVerify,
    action,
    verify,
  });
});

const fill_form = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const fields = [
    { selector: FORM.name, value: "Grace Hopper" },
    { selector: FORM.email, value: "grace@example.test" },
    { selector: FORM.password, value: "test-password" },
    { selector: FORM.bio, value: "compiler pioneer" },
  ];
  const action = payloadRecord(
    await ctx.call("fill_form", { fields, submit: { selector: FORM.submit } }),
    "fill_form",
  );
  const failed = actionFailed("fill_form", action);
  if (failed) return failed;
  const nameVerify = await verifyValue(ctx, FORM.name, "Grace Hopper");
  const emailVerify = await verifyValue(ctx, FORM.email, "grace@example.test");
  const bioVerify = await verifyValue(ctx, FORM.bio, "compiler pioneer");
  const attr = await verifyAttribute(ctx, FORM.result, "data-submitted", "1");
  const result = await formResult(ctx);
  const parsed = recordAt(result, "parsed");
  if (
    verifyOk(nameVerify) &&
    verifyOk(emailVerify) &&
    verifyOk(bioVerify) &&
    verifyOk(attr) &&
    parsed &&
    parsed.name === "Grace Hopper" &&
    parsed.email === "grace@example.test" &&
    parsed.bio === "compiler pioneer"
  ) {
    return pass("fill_form filled multiple fields and submitted the reflected JSON", {
      action,
      verifies: { nameVerify, emailVerify, bioVerify, attr },
      result,
    });
  }
  return fail("fill_form did not produce the expected filled-and-submitted state", {
    action,
    verifies: { nameVerify, emailVerify, bioVerify, attr },
    result,
  });
});

const wait_for = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const token = "never-wait-token-7b1c";
  const action = payloadRecord(
    await ctx.call("wait_for", { text: token, timeoutMs: 120, mode: "none" }),
    "wait_for",
  );
  const search = payloadRecord(
    await ctx.call("text_search", { text: token, exact: true, maxMatches: 3 }),
    "text_search",
  );
  const formVisible = payloadRecord(
    await ctx.call("verify_visible", { selector: FORM.signup }),
    "verify_visible",
  );
  if (action.ok === false && numberAt(search, "count") === 0 && verifyOk(formVisible)) {
    return pass("wait_for took the bounded timeout path for absent text", {
      action,
      search,
      formVisible,
    });
  }
  return fail("wait_for did not report the expected absent-text timeout path", {
    action,
    search,
    formVisible,
  });
});

const execute = exercise(async (ctx) => {
  await ctx.goto("/forms");
  const planned = payloadRecord(
    await ctx.call("plan", { query: "Submit", verb: "click", ttlMs: 60_000 }),
    "plan",
  );
  if (planned.ok !== true) return fail("execute setup plan returned ok:false", planned);
  const descriptor = recordAt(planned, "descriptor");
  if (!descriptor) return fail("execute setup plan did not return a descriptor", planned);
  const action = payloadRecord(await ctx.call("execute", { descriptor }), "execute");
  const failed = actionFailed("execute", action);
  if (failed) return failed;
  const attr = await verifyAttribute(ctx, FORM.result, "data-submitted", "1");
  const result = await formResult(ctx);
  if (verifyOk(attr)) {
    return pass("execute dispatched a planned submit click and the form reacted", {
      planned,
      action,
      attr,
      result,
    });
  }
  return fail("execute did not dispatch the planned submit click", { planned, action, attr, result });
});

const exercises = {
  click,
  fill,
  press,
  shortcut,
  hover,
  select,
  choose_option,
  fill_form,
  wait_for,
  execute,
} satisfies ExerciseMap;

export default exercises;
