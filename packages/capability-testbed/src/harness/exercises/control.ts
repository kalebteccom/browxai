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

function numberAt(record: JsonRecord | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function configAt(data: JsonRecord | undefined): JsonRecord | undefined {
  return isRecord(data?.config) ? data.config : undefined;
}

function unique(prefix: string, ctx: ExerciseCtx): string {
  return `${prefix}-${ctx.session.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

const open_session = exercise(async (ctx) => {
  const session = unique("control-open", ctx);
  const result = dataRecord(
    await ctx.client.callTool("open_session", {
      session,
      mode: "incognito",
      viewport: { width: 640, height: 480 },
    }),
  );
  const listed = dataRecord(await ctx.call("list_sessions"));
  await ctx.client.callTool("close_session", { session });
  const found = records(listed?.sessions).find((entry) => entry.id === session);
  if (result?.ok === true && result.session === session && found) {
    return pass("open_session created a new incognito session visible to list_sessions", {
      result,
      found,
    });
  }
  return fail("open_session did not create a visible session", { result, listed });
});

const close_session = exercise(async (ctx) => {
  const session = unique("control-close", ctx);
  await ctx.client.callTool("open_session", { session, mode: "incognito" });
  const closed = dataRecord(await ctx.client.callTool("close_session", { session }));
  const listed = dataRecord(await ctx.call("list_sessions"));
  const stillOpen = records(listed?.sessions).some((entry) => entry.id === session);
  if (closed?.ok === true && closed.session === session && closed.wasOpen === true && !stillOpen) {
    return pass("close_session closed a previously open session", { closed, listed });
  }
  return fail("close_session did not close the target session", { closed, listed });
});

const close_sessions = exercise(async (ctx) => {
  const prefix = unique("control-bulk", ctx);
  const first = `${prefix}-a`;
  const second = `${prefix}-b`;
  await ctx.client.callTool("open_session", { session: first, mode: "incognito" });
  await ctx.client.callTool("open_session", { session: second, mode: "incognito" });
  const closed = dataRecord(await ctx.client.callTool("close_sessions", { prefix }));
  const listed = dataRecord(await ctx.call("list_sessions"));
  const remaining = records(listed?.sessions).filter((entry) => stringAt(entry, "id")?.startsWith(prefix));
  if (closed?.ok === true && numberAt(closed, "count") === 2 && remaining.length === 0) {
    return pass("close_sessions closed both sessions matching the prefix", { closed, listed });
  }
  return fail("close_sessions did not close the expected prefixed sessions", {
    closed,
    remaining,
  });
});

const list_sessions = exercise(async (ctx) => {
  const result = dataRecord(await ctx.call("list_sessions"));
  const found = records(result?.sessions).find((entry) => entry.id === ctx.session);
  if (found && typeof found.mode === "string" && "url" in found) {
    return pass("list_sessions includes the bound exercise session", { found });
  }
  return fail("list_sessions did not include the bound exercise session", result);
});

const batch = exercise(async (ctx) => {
  const result = dataRecord(
    await ctx.call("batch", {
      calls: [
        {
          tool: "navigate",
          args: { session: ctx.session, url: `${ctx.baseUrl}/core` },
          label: "open-core",
        },
        {
          tool: "find",
          args: { session: ctx.session, query: "Ping", maxCandidates: 4, visibleOnly: true },
          label: "find-ping",
        },
      ],
    }),
  );
  const verify = dataRecord(
    await ctx.call("verify_text", {
      selector: '[data-testid="greeting"]',
      text: "Hello, browxai",
      exact: true,
    }),
  );
  if (numberAt(result, "completed") === 2 && result?.failedAt === null && verify?.ok === true) {
    return pass("batch ran navigate and find and left the core page verifiable", {
      batch: result,
      verify,
    });
  }
  return fail("batch did not complete the navigate/find sequence", { batch: result, verify });
});

const get_config = exercise(async (ctx) => {
  const result = dataRecord(await ctx.call("get_config", { scope: "resolved" }));
  const config = configAt(result);
  if (result?.scope === "resolved" && Array.isArray(config?.capabilities)) {
    return pass("get_config returned the resolved config with capabilities", result);
  }
  return fail("get_config did not return the resolved config shape", result);
});

const set_config = exercise(async (ctx) => {
  const marker = unique("set-config", ctx);
  const written = dataRecord(
    await ctx.call("set_config", {
      scope: "project",
      patch: { unstable: { capabilityTestbedControl: marker } },
    }),
  );
  const project = dataRecord(await ctx.call("get_config", { scope: "project" }));
  const projectConfig = configAt(project);
  const unstable = isRecord(projectConfig?.unstable) ? projectConfig.unstable : undefined;
  await ctx.call("reset_config", { scope: "project" });
  if (
    written?.ok === true &&
    Array.isArray(written.written) &&
    written.written.includes("unstable") &&
    stringAt(unstable, "capabilityTestbedControl") === marker
  ) {
    return pass("set_config persisted a project-layer unstable marker", { written, project });
  }
  return fail("set_config did not persist the project-layer marker", { written, project });
});

const reset_config = exercise(async (ctx) => {
  const marker = unique("reset-config", ctx);
  await ctx.call("set_config", {
    scope: "project",
    patch: { unstable: { capabilityTestbedReset: marker } },
  });
  const before = dataRecord(await ctx.call("get_config", { scope: "project" }));
  const reset = dataRecord(await ctx.call("reset_config", { scope: "project" }));
  const after = dataRecord(await ctx.call("get_config", { scope: "project" }));
  const beforeConfig = configAt(before);
  const beforeUnstable = isRecord(beforeConfig?.unstable) ? beforeConfig.unstable : undefined;
  const afterConfig = configAt(after);
  if (
    stringAt(beforeUnstable, "capabilityTestbedReset") === marker &&
    reset?.ok === true &&
    reset.cleared === "project" &&
    Object.keys(afterConfig ?? {}).length === 0
  ) {
    return pass("reset_config cleared the project config layer after a test marker", {
      before,
      reset,
      after,
    });
  }
  return fail("reset_config did not clear the project config layer", { before, reset, after });
});

const list_approvals = exercise(async (ctx) => {
  await ctx.call("approve_actions", { scopes: ["byob_action"], ttlSeconds: 30 });
  const result = dataRecord(await ctx.call("list_approvals"));
  const grant = records(result?.approvals).find((entry) => entry.scope === "byob_action");
  if (grant && numberAt(grant, "remainingMs") !== undefined) {
    return pass("list_approvals returned the live byob_action grant", { grant });
  }
  return fail("list_approvals did not return the expected grant", result);
});

const approve_actions = exercise(async (ctx) => {
  const approved = dataRecord(
    await ctx.call("approve_actions", {
      scopes: ["navigate_off_allowlist"],
      ttlSeconds: 30,
    }),
  );
  const listed = dataRecord(await ctx.call("list_approvals"));
  const grant = records(listed?.approvals).find((entry) => entry.scope === "navigate_off_allowlist");
  if (
    approved?.ok === true &&
    Array.isArray(approved.granted) &&
    approved.granted.includes("navigate_off_allowlist") &&
    grant
  ) {
    return pass("approve_actions created a grant visible to list_approvals", {
      approved,
      grant,
    });
  }
  return fail("approve_actions did not create a visible approval grant", { approved, listed });
});

const map: ExerciseMap = {
  open_session,
  close_session,
  close_sessions,
  list_sessions,
  batch,
  get_config,
  set_config,
  reset_config,
  list_approvals,
  approve_actions,
};

export default map;
