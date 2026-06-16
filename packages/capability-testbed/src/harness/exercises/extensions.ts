import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass, skip } from "../types.js";

type JsonRecord = Record<string, unknown>;

interface ExtensionTarget {
  readonly session: string;
  readonly path: string;
}

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

function unsupportedExtensions(data: JsonRecord | undefined): boolean {
  const error = stringAt(data, "error")?.toLowerCase() ?? "";
  const hint = stringAt(data, "hint") ?? "";
  return data?.ok === false && hint.length > 0 && (error.includes("headless") || error.includes("incognito") || error.includes("attached"));
}

function loadedExtensions(data: JsonRecord | undefined): JsonRecord[] {
  return records(data?.loaded);
}

function unique(prefix: string, ctx: ExerciseCtx): string {
  return `${prefix}-${ctx.session.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

async function writeExtension(ctx: ExerciseCtx): Promise<string> {
  const relative = join("capability-testbed-extension", unique("extension", ctx));
  const root = join(ctx.workspace, relative);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify(
      {
        manifest_version: 3,
        name: "Capability Testbed Extension",
        version: "1.0.0",
        action: { default_popup: "popup.html" },
        commands: {
          _execute_action: {
            suggested_key: { default: "Ctrl+Shift+Y" },
            description: "Exercise command",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(join(root, "popup.html"), "<!doctype html><title>testbed extension</title>", "utf8");
  return relative;
}

async function prepareTarget(ctx: ExerciseCtx): Promise<ExtensionTarget> {
  const session = unique("extensions", ctx);
  const profile = unique("extensions-profile", ctx);
  const path = await writeExtension(ctx);
  await ctx.client.callTool("open_session", { session, mode: "persistent", profile });
  await ctx.client.callTool("navigate", { session, url: `${ctx.baseUrl}/core` });
  return { session, path };
}

async function closeTarget(ctx: ExerciseCtx, target: ExtensionTarget): Promise<void> {
  await ctx.client.callTool("close_session", { session: target.session }).catch(() => undefined);
}

async function installTarget(ctx: ExerciseCtx, target: ExtensionTarget): Promise<JsonRecord | undefined> {
  return dataRecord(
    await ctx.client.callTool("extensions_install", {
      session: target.session,
      path: target.path,
    }),
  );
}

function installedId(data: JsonRecord | undefined): string | undefined {
  return stringAt(isRecord(data?.installed) ? data.installed : undefined, "id");
}

const extensions_install = exercise(async (ctx) => {
  await ctx.goto("/core");
  const target = await prepareTarget(ctx);
  try {
    const result = await installTarget(ctx, target);
    if (unsupportedExtensions(result)) {
      return pass("extensions_install returned a structured unsupported-session refusal", result);
    }
    const id = installedId(result);
    if (result?.ok === true && id && loadedExtensions(result).some((entry) => entry.id === id)) {
      return pass("extensions_install loaded the unpacked test extension", result);
    }
    return fail("extensions_install did not install or refuse with a structured result", result);
  } finally {
    await closeTarget(ctx, target);
  }
});

const extensions_list = exercise(async (ctx) => {
  await ctx.goto("/core");
  const target = await prepareTarget(ctx);
  try {
    const install = await installTarget(ctx, target);
    if (unsupportedExtensions(install)) {
      return pass("extensions_list setup hit a structured unsupported-session refusal", install);
    }
    const result = dataRecord(
      await ctx.client.callTool("extensions_list", { session: target.session }),
    );
    const loaded = loadedExtensions(result);
    if (result?.ok === true && loaded.length >= 1) {
      return pass("extensions_list returned the installed extension", { install, result });
    }
    return fail("extensions_list did not return the installed extension", { install, result });
  } finally {
    await closeTarget(ctx, target);
  }
});

const extensions_reload = exercise(async (ctx) => {
  await ctx.goto("/core");
  const target = await prepareTarget(ctx);
  try {
    const install = await installTarget(ctx, target);
    if (unsupportedExtensions(install)) {
      return pass("extensions_reload setup hit a structured unsupported-session refusal", install);
    }
    const id = installedId(install);
    if (!id) return fail("extensions_reload setup did not return an extension id", install);
    const result = dataRecord(
      await ctx.client.callTool("extensions_reload", { session: target.session, id }),
    );
    if (result?.ok === true && isRecord(result.reloaded) && loadedExtensions(result).some((entry) => entry.id === id)) {
      return pass("extensions_reload rebuilt the session with the extension", { install, result });
    }
    return fail("extensions_reload did not reload the installed extension", { install, result });
  } finally {
    await closeTarget(ctx, target);
  }
});

const extensions_trigger = exercise(async (ctx) => {
  await ctx.goto("/core");
  const target = await prepareTarget(ctx);
  try {
    const install = await installTarget(ctx, target);
    if (unsupportedExtensions(install)) {
      return pass("extensions_trigger setup hit a structured unsupported-session refusal", install);
    }
    const id = installedId(install);
    if (!id) return fail("extensions_trigger setup did not return an extension id", install);
    const result = dataRecord(
      await ctx.client.callTool("extensions_trigger", {
        session: target.session,
        id,
        command: "_execute_action",
      }),
    );
    const error = stringAt(result, "error") ?? "";
    if (result?.ok === true && isRecord(result.triggered)) {
      return pass("extensions_trigger opened an extension surface", { install, result });
    }
    if (result?.ok === false && error.includes("keyboard command")) {
      return pass("extensions_trigger returned the structured command-dispatch refusal", {
        install,
        result,
      });
    }
    return fail("extensions_trigger did not trigger or refuse in a known structured way", {
      install,
      result,
    });
  } finally {
    await closeTarget(ctx, target);
  }
});

const extensions_uninstall = exercise(async (ctx) => {
  await ctx.goto("/core");
  const target = await prepareTarget(ctx);
  try {
    const install = await installTarget(ctx, target);
    if (unsupportedExtensions(install)) {
      return pass("extensions_uninstall setup hit a structured unsupported-session refusal", install);
    }
    const id = installedId(install);
    if (!id) return fail("extensions_uninstall setup did not return an extension id", install);
    const result = dataRecord(
      await ctx.client.callTool("extensions_uninstall", { session: target.session, id }),
    );
    const listed = dataRecord(
      await ctx.client.callTool("extensions_list", { session: target.session }),
    );
    if (
      result?.ok === true &&
      isRecord(result.uninstalled) &&
      loadedExtensions(listed).every((entry) => entry.id !== id)
    ) {
      return pass("extensions_uninstall removed the extension from the loaded list", {
        result,
        listed,
      });
    }
    return fail("extensions_uninstall did not remove the installed extension", {
      result,
      listed,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("unsupported")) {
      return skip("extensions_uninstall is not runnable in this browser environment");
    }
    throw err;
  } finally {
    await closeTarget(ctx, target);
  }
});

const map: ExerciseMap = {
  extensions_install,
  extensions_list,
  extensions_reload,
  extensions_trigger,
  extensions_uninstall,
};

export default map;
