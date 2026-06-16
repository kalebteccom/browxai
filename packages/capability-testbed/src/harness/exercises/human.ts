import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass } from "../types.js";

type JsonRecord = Record<string, unknown>;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const CORE = {
  ping: '[data-testid="ping"]',
  status: '[data-testid="status"]',
} as const;

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

function boxAt(value: unknown): Box | undefined {
  if (!isRecord(value)) return undefined;
  const x = numberAt(value, "x");
  const y = numberAt(value, "y");
  const width = numberAt(value, "width");
  const height = numberAt(value, "height");
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height };
}

function center(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function unique(prefix: string, ctx: ExerciseCtx): string {
  return `${prefix}-${ctx.session.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

async function findPing(ctx: ExerciseCtx): Promise<JsonRecord | undefined> {
  const result = await ctx.call("find", { query: "Ping", maxCandidates: 8, visibleOnly: true });
  const data = dataRecord(result);
  return records(data?.candidates).find((candidate) => candidate.testId === "ping");
}

async function verifyStatusPong(ctx: ExerciseCtx): Promise<JsonRecord | undefined> {
  const result = await ctx.call("verify_text", {
    selector: CORE.status,
    text: "pong",
    exact: true,
  });
  return dataRecord(result);
}

const await_human = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = await ctx.call("await_human", {
    kind: "acknowledge",
    prompt: "Capability testbed timeout probe",
    timeoutMs: 75,
  });
  const data = dataRecord(result);
  if (data?.kind === "acknowledge" && data.timedOut === true && data.value === null) {
    return pass("await_human returned the bounded timeout path", data);
  }
  return fail("await_human did not return a well-formed timeout result", data ?? result);
});

const name_ref = exercise(async (ctx) => {
  await ctx.goto("/core");
  const candidate = await findPing(ctx);
  const ref = stringAt(candidate, "ref");
  if (!ref) return fail("find did not return a ref for the Ping button", candidate);
  const name = unique("ping-btn", ctx);
  const named = dataRecord(await ctx.call("name_ref", { name, ref }));
  const listed = payload(await ctx.call("list_named_refs"));
  const match = records(listed).find((entry) => entry.name === name && entry.ref === ref);
  if (named?.ok === true && match) {
    return pass("name_ref bound the Ping ref and list_named_refs read it back", { named, match });
  }
  return fail("name_ref was not visible through list_named_refs", { named, listed });
});

const name_region = exercise(async (ctx) => {
  await ctx.goto("/core");
  const candidate = await findPing(ctx);
  const box = boxAt(candidate?.bbox);
  if (!box) return fail("find did not return a usable Ping button bbox", candidate);
  const name = unique("ping-region", ctx);
  const named = dataRecord(await ctx.call("name_region", { name, box }));
  const resolved = dataRecord(await ctx.call("region", { name }));
  if (named?.ok === true && resolved?.ok === true && boxAt(resolved.box)) {
    return pass("name_region stored a bbox that region resolved by name", { named, resolved });
  }
  return fail("name_region did not resolve through region", { named, resolved });
});

const region = exercise(async (ctx) => {
  await ctx.goto("/core");
  const candidate = await findPing(ctx);
  const box = boxAt(candidate?.bbox);
  if (!box) return fail("find did not return a usable Ping button bbox", candidate);
  const name = unique("region-read", ctx);
  await ctx.call("name_region", { name, box });
  const result = await ctx.call("region", { name });
  const data = dataRecord(result);
  const resolvedBox = boxAt(data?.box);
  const resolvedCenter = isRecord(data?.center) ? data.center : undefined;
  if (data?.ok === true && resolvedBox && numberAt(resolvedCenter, "x") !== undefined) {
    return pass("region returned the stored bbox and computed center", data);
  }
  return fail("region did not return a well-formed named region", data ?? result);
});

const start_recording = exercise(async (ctx) => {
  await ctx.goto("/core");
  const flowName = unique("start-recording", ctx);
  const started = dataRecord(await ctx.call("start_recording", { flowName }));
  await ctx.call("click", { selector: CORE.ping });
  const verified = await verifyStatusPong(ctx);
  const ended = dataRecord(await ctx.call("end_recording"));
  if (stringAt(started, "name") === flowName && verified?.ok === true && numberAt(ended, "stepCount")) {
    return pass("start_recording armed recording and captured a real click step", {
      started,
      verified,
      ended,
    });
  }
  return fail("start_recording did not produce a recorded action flow", { started, verified, ended });
});

const end_recording = exercise(async (ctx) => {
  await ctx.goto("/core");
  const flowName = unique("end-recording", ctx);
  await ctx.call("start_recording", { flowName });
  await ctx.call("click", { selector: CORE.ping });
  const verified = await verifyStatusPong(ctx);
  const ended = dataRecord(await ctx.call("end_recording"));
  const yaml = stringAt(ended, "yaml");
  if (ended?.name === flowName && numberAt(ended, "stepCount") && yaml?.includes("click")) {
    return pass("end_recording emitted YAML for the captured click", { ended, verified });
  }
  return fail("end_recording did not emit a usable recording draft", { ended, verified });
});

const record_annotate = exercise(async (ctx) => {
  await ctx.goto("/core");
  const flowName = unique("annotated-flow", ctx);
  const note = `annotated ping ${ctx.session}`;
  await ctx.call("start_recording", { flowName });
  await ctx.call("click", { selector: CORE.ping });
  const annotation = dataRecord(await ctx.call("record_annotate", { copy: note, arrow: "top" }));
  const verified = await verifyStatusPong(ctx);
  const ended = dataRecord(await ctx.call("end_recording"));
  const yaml = stringAt(ended, "yaml");
  if (annotation?.ok === true && verified?.ok === true && yaml?.includes(note)) {
    return pass("record_annotate attached the note to the recorded step", {
      annotation,
      ended,
    });
  }
  return fail("record_annotate note was not present in the ended recording", {
    annotation,
    verified,
    ended,
  });
});

const find_feedback = exercise(async (ctx) => {
  await ctx.goto("/core");
  const candidate = await findPing(ctx);
  const ref = stringAt(candidate, "ref");
  if (!ref) return fail("find did not return a ref to feed back", candidate);
  const feedback = dataRecord(await ctx.call("find_feedback", { query: "Ping", ref }));
  const reread = await findPing(ctx);
  if (feedback?.ok === true && feedback.recorded && reread?.testId === "ping") {
    return pass("find_feedback accepted the Ping ref and find still resolves it", {
      feedback,
      reread,
    });
  }
  return fail("find_feedback did not accept the prior find candidate", { feedback, reread });
});

async function openAndClosePersistentProfile(
  ctx: ExerciseCtx,
  session: string,
  profile: string,
): Promise<JsonRecord | undefined> {
  const opened = dataRecord(
    await ctx.client.callTool("open_session", { session, mode: "persistent", profile }),
  );
  if (opened?.ok === true) {
    await ctx.client.callTool("navigate", { session, url: `${ctx.baseUrl}/core` });
  }
  await ctx.client.callTool("close_session", { session });
  return opened;
}

const profile_snapshot = exercise(async (ctx) => {
  const profile = unique("profile-snapshot-profile", ctx);
  const snapshot = unique("profile-snapshot", ctx);
  const seedSession = unique("profile-seed", ctx);
  await ctx.client.callTool("close_session", { session: ctx.session });
  const opened = await openAndClosePersistentProfile(ctx, seedSession, profile);
  const result = dataRecord(
    await ctx.client.callTool("profile_snapshot", { profile, snapshot }),
  );
  if (opened?.ok === true && result?.ok === true && result.action === "snapshot") {
    return pass("profile_snapshot copied a closed persistent profile", { opened, result });
  }
  return fail("profile_snapshot did not produce a successful closed-profile snapshot", {
    opened,
    result,
  });
});

const profile_restore = exercise(async (ctx) => {
  const profile = unique("profile-restore-profile", ctx);
  const snapshot = unique("profile-restore", ctx);
  const seedSession = unique("profile-restore-seed", ctx);
  await ctx.client.callTool("close_session", { session: ctx.session });
  const opened = await openAndClosePersistentProfile(ctx, seedSession, profile);
  const snap = dataRecord(await ctx.client.callTool("profile_snapshot", { profile, snapshot }));
  const restored = dataRecord(await ctx.client.callTool("profile_restore", { profile, snapshot }));
  const reopened = dataRecord(
    await ctx.client.callTool("open_session", { session: seedSession, mode: "persistent", profile }),
  );
  await ctx.client.callTool("close_session", { session: seedSession });
  if (
    opened?.ok === true &&
    snap?.ok === true &&
    restored?.ok === true &&
    restored.action === "restore" &&
    reopened?.ok === true
  ) {
    return pass("profile_restore restored a snapshot and the profile reopened", {
      snap,
      restored,
      reopened,
    });
  }
  return fail("profile_restore did not restore and reopen the persistent profile", {
    opened,
    snap,
    restored,
    reopened,
  });
});

const map: ExerciseMap = {
  await_human,
  end_recording,
  find_feedback,
  name_ref,
  name_region,
  profile_restore,
  profile_snapshot,
  record_annotate,
  region,
  start_recording,
};

export default map;
