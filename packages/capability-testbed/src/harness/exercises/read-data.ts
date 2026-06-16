import {
  type ExerciseCtx,
  type ExerciseMap,
  type ExerciseResult,
  fail,
  pass,
  skip,
} from "../types.js";

type JsonRecord = Record<string, unknown>;

const NETWORK = {
  json: '[data-testid="do-json"]',
  wsConnect: '[data-testid="ws-connect"]',
  wsSend: '[data-testid="ws-send"]',
  netOut: '[data-testid="net-out"]',
  wsOut: '[data-testid="ws-out"]',
} as const;

const STORAGE = {
  seed: '[data-testid="seed-storage"]',
  read: '[data-testid="read-storage"]',
  out: '[data-testid="storage-out"]',
} as const;

const CORE = {
  ping: '[data-testid="ping"]',
  status: '[data-testid="status"]',
} as const;

function exercise(fn: (ctx: ExerciseCtx) => Promise<ExerciseResult>) {
  return async (ctx: ExerciseCtx): Promise<ExerciseResult> => {
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

function booleanAt(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function requireOk(record: JsonRecord, label: string): void {
  if (record.ok !== true) throw new Error(`${label} did not return ok:true`);
}

function safeName(prefix: string, raw: string): string {
  const suffix = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const name = suffix ? `${prefix}-${suffix}` : prefix;
  return name.slice(0, 90);
}

function uniqueName(prefix: string, ctx: ExerciseCtx): string {
  return safeName(prefix, `${ctx.session}-${Date.now()}`);
}

async function verifyText(
  ctx: ExerciseCtx,
  selector: string,
  text: string,
  exact = false,
): Promise<JsonRecord> {
  const data = payloadRecord(await ctx.call("verify_text", { selector, text, exact }), "verify_text");
  requireOk(data, "verify_text");
  return data;
}

async function verifyAttribute(
  ctx: ExerciseCtx,
  selector: string,
  attr: string,
  value?: string,
): Promise<JsonRecord> {
  const args: Record<string, unknown> = { selector, attr };
  if (value !== undefined) args.value = value;
  const data = payloadRecord(await ctx.call("verify_attribute", args), "verify_attribute");
  requireOk(data, "verify_attribute");
  return data;
}

async function waitForText(ctx: ExerciseCtx, text: string): Promise<void> {
  await ctx.call("wait_for", { text, timeoutMs: 5000, maxResultTokens: 1000 });
}

async function seedStorage(ctx: ExerciseCtx): Promise<void> {
  await ctx.goto("/storage");
  await ctx.call("click", { selector: STORAGE.seed });
  await waitForText(ctx, "seeded");
  await verifyText(ctx, STORAGE.out, "seeded", true);
}

async function readSeededStorage(ctx: ExerciseCtx): Promise<void> {
  await ctx.call("click", { selector: STORAGE.read });
  await waitForText(ctx, "cache-value");
  await verifyText(ctx, STORAGE.out, "ls-value");
  await verifyText(ctx, STORAGE.out, "ss-value");
  await verifyText(ctx, STORAGE.out, "ck-key=ck-value");
  await verifyText(ctx, STORAGE.out, "idb-value");
  await verifyText(ctx, STORAGE.out, "cache-value");
}

function hasStorageEntry(entries: unknown, key: string, value: string): boolean {
  return asRecords(entries).some((entry) => entry.key === key && entry.value === value);
}

function hasCookie(cookies: unknown, name: string, value: string): boolean {
  return asRecords(cookies).some((cookie) => cookie.name === name && cookie.value === value);
}

function hasNamedRecord(records: unknown, name: string): boolean {
  return asRecords(records).some((record) => record.name === name);
}

const network_read = exercise(async (ctx) => {
  await ctx.goto("/network");
  await ctx.call("click", { selector: NETWORK.json });
  await waitForText(ctx, "json-payload");
  await verifyText(ctx, NETWORK.netOut, "json-payload");
  const data = payloadRecord(await ctx.call("network_read", { limit: 25 }), "network_read");
  const summary = recordAt(data, "summary");
  const requests = asRecords(data.requests);
  const hit = requests.find((request) => {
    const url = stringAt(request, "url") ?? "";
    return url.includes("/api/json") && request.method === "GET" && request.status === 200;
  });
  if (hit && numberAt(summary ?? {}, "total") !== undefined) {
    return pass("network_read captured the /api/json fetch after the page rendered its response", {
      request: hit,
      summary,
    });
  }
  return fail("network_read did not include the completed /api/json request", data);
});

const ws_read = exercise(async (ctx) => {
  await ctx.goto("/network");
  await ctx.call("click", { selector: NETWORK.wsConnect });
  await waitForText(ctx, "open");
  await ctx.call("click", { selector: NETWORK.wsSend });
  await waitForText(ctx, "recv:echo:hello");
  await verifyText(ctx, NETWORK.wsOut, "recv:echo:hello");
  const data = payloadRecord(await ctx.call("ws_read", { limit: 20, urlPattern: "/ws/echo" }), "ws_read");
  const frames = asRecords(data.frames);
  const payloads = frames.map((frame) => stringAt(frame, "payload") ?? "");
  const sawWelcome = payloads.includes("welcome");
  const sawSent = frames.some((frame) => frame.dir === "sent" && frame.payload === "hello");
  const sawEcho = frames.some((frame) => frame.dir === "recv" && frame.payload === "echo:hello");
  if (sawWelcome && sawSent && sawEcho) {
    return pass("ws_read captured the echo socket welcome, sent hello, and echoed response", {
      total: data.total,
      payloads,
    });
  }
  return fail("ws_read did not capture the expected echo socket frames", data);
});

const act_and_diff = exercise(async (ctx) => {
  await ctx.goto("/network");
  const setup = payloadRecord(
    await ctx.call("eval_js", {
      expr:
        "(() => { const btn = document.querySelector('[data-testid=\"do-json\"]'); " +
        "const out = document.querySelector('[data-testid=\"net-out\"]'); " +
        "if (!btn || !out) return false; " +
        "btn.addEventListener('click', () => out.setAttribute('data-diff-state', 'clicked'), { once: true }); " +
        "return true; })()",
    }),
    "eval_js",
  );
  requireOk(setup, "eval_js");
  if (setup.value !== true) return fail("act_and_diff setup could not attach a page-side click marker", setup);

  const data = payloadRecord(
    await ctx.call("act_and_diff", {
      action: { tool: "click", args: { selector: NETWORK.json } },
      scope: "body",
    }),
    "act_and_diff",
  );
  await waitForText(ctx, "json-payload");
  await verifyText(ctx, NETWORK.netOut, "json-payload");
  await verifyAttribute(ctx, NETWORK.netOut, "data-diff-state", "clicked");
  const diff = recordAt(data, "diff");
  const changed = asRecords(diff?.changed);
  const hit = changed.find((change) => {
    const attrDelta = recordAt(change, "attrDelta");
    const marker = attrDelta ? recordAt(attrDelta, "data-diff-state") : undefined;
    return change.testId === "net-out" && stringAt(marker ?? {}, "after") === "clicked";
  });
  if (hit) {
    return pass("act_and_diff captured a real data-* attribute change caused by the click", {
      change: hit,
      counts: recordAt(diff ?? {}, "counts"),
    });
  }
  return fail("act_and_diff did not report the net-out data-diff-state change", data);
});

const act_and_sample = exercise(async (ctx) => {
  await ctx.goto("/network");
  const data = payloadRecord(
    await ctx.call("act_and_sample", {
      action: { tool: "click", args: { selector: NETWORK.json } },
      selector: NETWORK.netOut,
      metric: "clientHeight",
      durationMs: 600,
      intervalMs: 50,
      summary: false,
    }),
    "act_and_sample",
  );
  await waitForText(ctx, "json-payload");
  await verifyText(ctx, NETWORK.netOut, "json-payload");
  const sample = recordAt(data, "sample");
  const count = sample ? numberAt(sample, "count") : undefined;
  if (sample?.metric === "clientHeight" && sample.scope === "element" && count !== undefined && count > 0) {
    return pass("act_and_sample clicked /api/json and captured a bounded net-out metric series", {
      count,
      summary: recordAt(sample, "summary"),
      actionObserved: isRecord(data.action),
    });
  }
  return fail("act_and_sample did not return a well-formed element metric trace", data);
});

const act_and_wait_for_network = exercise(async (ctx) => {
  await ctx.goto("/network");
  const data = payloadRecord(
    await ctx.call("act_and_wait_for_network", {
      action: { tool: "click", args: { selector: NETWORK.json } },
      match: { urlPattern: "/api/json", method: "GET", status: 200 },
      timeoutMs: 5000,
    }),
    "act_and_wait_for_network",
  );
  await waitForText(ctx, "json-payload");
  await verifyText(ctx, NETWORK.netOut, "json-payload");
  const network = recordAt(data, "network");
  if (
    network?.matched === true &&
    network.method === "GET" &&
    network.status === 200 &&
    (stringAt(network, "url") ?? "").includes("/api/json")
  ) {
    return pass("act_and_wait_for_network armed before the click and matched the /api/json response", {
      network,
    });
  }
  return fail("act_and_wait_for_network did not match the expected /api/json response", data);
});

const cross_session_sample = exercise(async (ctx) => {
  const sampleSession = uniqueName("read-data-sample-session", ctx);
  await ctx.client.callTool("open_session", { session: sampleSession, mode: "incognito" });
  try {
    await ctx.client.callTool("navigate", { session: sampleSession, url: `${ctx.baseUrl}/network` });
    const sampleSnapshot = firstText(await ctx.client.callTool("snapshot", { session: sampleSession, maxNodes: 60 }));
    if (!sampleSnapshot?.includes("Network surface")) {
      return fail("sample session did not navigate to the network surface", { sampleSnapshot });
    }
    await ctx.goto("/network");
    const data = payloadRecord(
      await ctx.call("cross_session_sample", {
        action: { tool: "click", args: { selector: NETWORK.json } },
        actionSession: ctx.session,
        sampleSession,
        metric: "clientHeight",
        durationMs: 350,
        intervalMs: 50,
      }),
      "cross_session_sample",
    );
    await waitForText(ctx, "json-payload");
    await verifyText(ctx, NETWORK.netOut, "json-payload");
    const sample = recordAt(data, "sample");
    const count = sample ? numberAt(sample, "count") : undefined;
    if (isRecord(data.action) && sample?.metric === "clientHeight" && count !== undefined && count > 0) {
      return pass("cross_session_sample drove one session while sampling another live session", {
        sampleSession,
        sampleCount: count,
        actionObserved: true,
      });
    }
    return fail("cross_session_sample did not return both action and sample evidence", data);
  } finally {
    try {
      await ctx.client.callTool("close_session", { session: sampleSession });
    } catch (err) {
      ctx.log(`failed to close sample session ${sampleSession}: ${String(err)}`);
    }
  }
});

const cookies_get = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(
    await ctx.call("cookies_get", { name: "ck-key", url: `${ctx.baseUrl}/storage` }),
    "cookies_get",
  );
  requireOk(data, "cookies_get");
  const cookie = recordAt(data, "cookie");
  if (cookie?.name === "ck-key" && cookie.value === "ck-value") {
    return pass("cookies_get returned the seeded ck-key cookie", { cookie });
  }
  return fail("cookies_get did not return the seeded ck-key cookie", data);
});

const cookies_list = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(
    await ctx.call("cookies_list", { urls: [`${ctx.baseUrl}/storage`] }),
    "cookies_list",
  );
  requireOk(data, "cookies_list");
  if (hasCookie(data.cookies, "ck-key", "ck-value")) {
    return pass("cookies_list included the seeded ck-key cookie", {
      count: data.count,
      cookies: data.cookies,
    });
  }
  return fail("cookies_list did not include the seeded ck-key cookie", data);
});

const localstorage_get = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(await ctx.call("localstorage_get", { key: "ls-key" }), "localstorage_get");
  requireOk(data, "localstorage_get");
  if (data.value === "ls-value" && stringAt(data, "origin") === ctx.baseUrl) {
    return pass("localstorage_get returned the seeded ls-key value for the current origin", data);
  }
  return fail("localstorage_get did not return ls-value for ls-key", data);
});

const localstorage_list = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(await ctx.call("localstorage_list"), "localstorage_list");
  requireOk(data, "localstorage_list");
  if (hasStorageEntry(data.entries, "ls-key", "ls-value")) {
    return pass("localstorage_list included the seeded ls-key entry", {
      count: data.count,
      origin: data.origin,
    });
  }
  return fail("localstorage_list did not include ls-key=ls-value", data);
});

const sessionstorage_get = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(await ctx.call("sessionstorage_get", { key: "ss-key" }), "sessionstorage_get");
  requireOk(data, "sessionstorage_get");
  if (data.value === "ss-value" && stringAt(data, "origin") === ctx.baseUrl) {
    return pass("sessionstorage_get returned the seeded ss-key value for the current origin", data);
  }
  return fail("sessionstorage_get did not return ss-value for ss-key", data);
});

const sessionstorage_list = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(await ctx.call("sessionstorage_list"), "sessionstorage_list");
  requireOk(data, "sessionstorage_list");
  if (hasStorageEntry(data.entries, "ss-key", "ss-value")) {
    return pass("sessionstorage_list included the seeded ss-key entry", {
      count: data.count,
      origin: data.origin,
    });
  }
  return fail("sessionstorage_list did not include ss-key=ss-value", data);
});

const idb_get = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(
    await ctx.call("idb_get", { dbName: "testbed-db", storeName: "kv", key: "idb-key" }),
    "idb_get",
  );
  requireOk(data, "idb_get");
  if (data.found === true && data.value === "idb-value") {
    return pass("idb_get returned the seeded IndexedDB value", data);
  }
  return fail("idb_get did not return idb-value for testbed-db/kv/idb-key", data);
});

const idb_list_databases = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(await ctx.call("idb_list_databases"), "idb_list_databases");
  requireOk(data, "idb_list_databases");
  if (booleanAt(data, "supported") === false) {
    return skip("idb_list_databases reports indexedDB.databases() unsupported on this engine");
  }
  const databases = asRecords(data.databases);
  const hit = databases.find((db) => db.name === "testbed-db");
  if (hit) {
    return pass("idb_list_databases included testbed-db after page seeding", {
      count: data.count,
      database: hit,
    });
  }
  return fail("idb_list_databases did not include testbed-db", data);
});

const idb_list_stores = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(await ctx.call("idb_list_stores", { dbName: "testbed-db" }), "idb_list_stores");
  requireOk(data, "idb_list_stores");
  const stores = Array.isArray(data.stores) ? data.stores : [];
  if (stores.includes("kv")) {
    return pass("idb_list_stores returned the seeded kv object store", {
      dbName: data.dbName,
      stores,
    });
  }
  return fail("idb_list_stores did not include the kv store", data);
});

const caches_get = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(
    await ctx.call("caches_get", { cacheName: "testbed-cache", url: "/cache-item" }),
    "caches_get",
  );
  requireOk(data, "caches_get");
  if (data.found === true && data.kind === "text" && data.text === "cache-value") {
    return pass("caches_get returned the seeded Cache API text response", data);
  }
  return fail("caches_get did not return cache-value from testbed-cache", data);
});

const caches_list = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(
    await ctx.call("caches_list", { cacheName: "testbed-cache", urlPattern: "/cache-item" }),
    "caches_list",
  );
  requireOk(data, "caches_list");
  const entries = asRecords(data.entries);
  const hit = entries.find((entry) => (stringAt(entry, "url") ?? "").endsWith("/cache-item"));
  if (hit) {
    return pass("caches_list included the seeded /cache-item request", {
      count: data.count,
      entry: hit,
    });
  }
  return fail("caches_list did not include /cache-item", data);
});

const caches_list_storages = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(await ctx.call("caches_list_storages"), "caches_list_storages");
  requireOk(data, "caches_list_storages");
  const names = Array.isArray(data.names) ? data.names : [];
  if (names.includes("testbed-cache")) {
    return pass("caches_list_storages included testbed-cache after page seeding", {
      count: data.count,
      names,
    });
  }
  return fail("caches_list_storages did not include testbed-cache", data);
});

const dump_storage_state = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const data = payloadRecord(await ctx.call("dump_storage_state"), "dump_storage_state");
  requireOk(data, "dump_storage_state");
  const state = recordAt(data, "state");
  const cookies = state ? asRecords(state.cookies) : [];
  const origins = state ? asRecords(state.origins) : [];
  const origin = origins.find((entry) => entry.origin === ctx.baseUrl);
  const localStorage = origin ? asRecords(origin.localStorage) : [];
  const hasLs = localStorage.some((entry) => entry.name === "ls-key" && entry.value === "ls-value");
  if (hasCookie(cookies, "ck-key", "ck-value") && hasLs) {
    return pass("dump_storage_state returned cookies and localStorage for the seeded origin", {
      cookies: data.cookies,
      origins: data.origins,
      origin,
    });
  }
  return fail("dump_storage_state did not include the seeded cookie and localStorage state", data);
});

const auth_list = exercise(async (ctx) => {
  await seedStorage(ctx);
  await readSeededStorage(ctx);
  const name = uniqueName("read-data-auth", ctx);
  const saved = payloadRecord(await ctx.call("auth_save", { name }), "auth_save");
  requireOk(saved, "auth_save");
  const data = payloadRecord(await ctx.call("auth_list"), "auth_list");
  requireOk(data, "auth_list");
  const slots = asRecords(data.slots);
  const slot = slots.find((entry) => entry.name === name && numberAt(entry, "bytes") !== undefined);
  if (slot) {
    return pass("auth_list included the auth state saved from the seeded storage page", {
      name,
      slot,
      count: data.count,
    });
  }
  return fail("auth_list did not include the saved auth-state slot", { name, data });
});

const artifact_get = exercise(async (ctx) => {
  await ctx.goto("/core");
  const name = uniqueName("read-data-artifact.txt", ctx);
  const content = `artifact payload for ${ctx.session}`;
  const saved = payloadRecord(await ctx.call("artifact_save", { name, content }), "artifact_save");
  requireOk(saved, "artifact_save");
  const data = payloadRecord(await ctx.call("artifact_get", { name }), "artifact_get");
  requireOk(data, "artifact_get");
  const listed = payloadRecord(await ctx.call("artifact_list"), "artifact_list");
  requireOk(listed, "artifact_list");
  if (data.name === name && data.content === content && hasNamedRecord(listed.artifacts, name)) {
    return pass("artifact_get returned the exact payload saved into the session artifact KV", {
      artifact: { name: data.name, size: data.size, encoding: data.encoding },
      listed: true,
    });
  }
  return fail("artifact_get did not round-trip the saved artifact payload", { data, listed });
});

const artifact_list = exercise(async (ctx) => {
  await ctx.goto("/core");
  const name = uniqueName("read-data-list-artifact.txt", ctx);
  const saved = payloadRecord(
    await ctx.call("artifact_save", { name, content: "artifact-list-payload" }),
    "artifact_save",
  );
  requireOk(saved, "artifact_save");
  const data = payloadRecord(await ctx.call("artifact_list"), "artifact_list");
  requireOk(data, "artifact_list");
  const artifact = asRecords(data.artifacts).find((entry) => entry.name === name);
  if (artifact) {
    return pass("artifact_list included the artifact saved in this session", {
      count: data.count,
      artifact,
    });
  }
  return fail("artifact_list did not include the saved artifact", { name, data });
});

const diagnostics_report = exercise(async (ctx) => {
  await ctx.goto("/core");
  const since = new Date(Date.now() - 5000).toISOString();
  const insight = `read-data diagnostics report ${ctx.session} ${Date.now()}`;
  const noted = payloadRecord(
    await ctx.call("diagnostics_note", {
      insight,
      category: "missing-primitive",
      severity: "info",
    }),
    "diagnostics_note",
  );
  requireOk(noted, "diagnostics_note");
  const data = payloadRecord(
    await ctx.call("diagnostics_report", { format: "summary", since, sessionId: ctx.session }),
    "diagnostics_report",
  );
  requireOk(data, "diagnostics_report");
  const summary = recordAt(data, "summary");
  const notesByCategory = summary ? recordAt(summary, "notesByCategory") : undefined;
  const noteCount = notesByCategory ? numberAt(notesByCategory, "missing-primitive") : undefined;
  if (data.format === "summary" && noteCount !== undefined && noteCount > 0) {
    return pass("diagnostics_report summarized the diagnostics note filed by this exercise", {
      noteCount,
      summaryKeys: summary ? Object.keys(summary) : [],
    });
  }
  return fail("diagnostics_report did not include the newly filed note category", data);
});

const diagnostics_search = exercise(async (ctx) => {
  await ctx.goto("/core");
  const since = new Date(Date.now() - 5000).toISOString();
  const insight = `read-data diagnostics search ${ctx.session} ${Date.now()}`;
  const noted = payloadRecord(
    await ctx.call("diagnostics_note", {
      insight,
      category: "ergonomic-friction",
      severity: "warn",
    }),
    "diagnostics_note",
  );
  requireOk(noted, "diagnostics_note");
  const data = payloadRecord(
    await ctx.call("diagnostics_search", {
      since,
      category: "ergonomic-friction",
      sessionId: ctx.session,
      limit: 50,
    }),
    "diagnostics_search",
  );
  requireOk(data, "diagnostics_search");
  const record = asRecords(data.records).find((entry) => entry.kind === "note" && entry.insight === insight);
  if (record) {
    return pass("diagnostics_search returned the diagnostics note filed by this exercise", {
      count: data.count,
      record,
    });
  }
  return fail("diagnostics_search did not return the newly filed diagnostics note", data);
});

const session_metrics = exercise(async (ctx) => {
  await ctx.goto("/core");
  await ctx.call("snapshot", { maxNodes: 50 });
  const data = payloadRecord(await ctx.call("session_metrics"), "session_metrics");
  requireOk(data, "session_metrics");
  const callsByTool = recordAt(data, "callsByTool");
  const snapshotCalls = callsByTool ? numberAt(callsByTool, "snapshot") : undefined;
  const navigateCalls = callsByTool ? numberAt(callsByTool, "navigate") : undefined;
  if (
    data.session === ctx.session &&
    snapshotCalls !== undefined &&
    snapshotCalls > 0 &&
    navigateCalls !== undefined &&
    navigateCalls > 0
  ) {
    return pass("session_metrics reported cumulative calls made earlier in this exercise", {
      callsByTool,
      sessionDurationMs: data.sessionDurationMs,
      tokensEstimateSum: data.tokensEstimateSum,
    });
  }
  return fail("session_metrics did not include the expected navigate/snapshot call counts", data);
});

const export_session_report = exercise(async (ctx) => {
  await ctx.goto("/network");
  await ctx.call("click", { selector: NETWORK.json });
  await waitForText(ctx, "json-payload");
  await verifyText(ctx, NETWORK.netOut, "json-payload");
  const data = payloadRecord(
    await ctx.call("export_session_report", { note: "read-data export session report exercise" }),
    "export_session_report",
  );
  requireOk(data, "export_session_report");
  const network = recordAt(data, "network");
  const liveSessions = asRecords(data.liveSessions);
  const live = liveSessions.find((session) => session.id === ctx.session);
  if (
    data.session === ctx.session &&
    (stringAt(data, "url") ?? "").includes("/network") &&
    network &&
    numberAt(network, "total") !== undefined &&
    live
  ) {
    return pass("export_session_report bundled url, network summary, and live-session evidence", {
      url: data.url,
      network,
      live,
    });
  }
  return fail("export_session_report did not include the expected session evidence", data);
});

const export_playwright_script = exercise(async (ctx) => {
  const flowName = uniqueName("read-data-flow", ctx);
  const started = payloadRecord(await ctx.call("start_recording", { flowName }), "start_recording");
  requireOk(started, "start_recording");
  try {
    await ctx.goto("/core");
    await ctx.call("click", { selector: CORE.ping });
    await verifyText(ctx, CORE.status, "pong", true);
    const data = payloadRecord(await ctx.call("export_playwright_script"), "export_playwright_script");
    requireOk(data, "export_playwright_script");
    const stats = recordAt(data, "stats");
    const source = stringAt(data, "source") ?? "";
    const steps = stats ? numberAt(stats, "steps") : undefined;
    if (data.name === flowName && steps !== undefined && steps >= 2 && source.includes("page.goto(")) {
      return pass("export_playwright_script lowered an active navigate+click recording to a spec string", {
        name: data.name,
        stats,
        sourceExcerpt: source.slice(0, 240),
      });
    }
    return fail("export_playwright_script did not include the recorded flow in its source", data);
  } finally {
    try {
      await ctx.call("end_recording");
    } catch (err) {
      ctx.log(`failed to end recording for ${flowName}: ${String(err)}`);
    }
  }
});

const plugins_info = exercise(async (ctx) => {
  await ctx.goto("/core");
  const list = payloadRecord(await ctx.call("plugins_list"), "plugins_list");
  requireOk(list, "plugins_list");
  const plugin = asRecords(list.plugins).find((entry) => typeof entry.name === "string");
  if (!plugin) {
    const data = payloadRecord(
      await ctx.call("plugins_info", { name: "read-data-missing-plugin" }),
      "plugins_info",
    );
    if (data.ok === false && typeof data.error === "string" && Array.isArray(data.declared)) {
      return pass("plugins_info returned a structured not-declared result when no plugins are loaded", data);
    }
    return fail("plugins_info did not return a structured missing-plugin result", data);
  }
  const name = stringAt(plugin, "name");
  if (!name) return fail("plugins_list returned a plugin row without a string name", plugin);
  const data = payloadRecord(await ctx.call("plugins_info", { name }), "plugins_info");
  requireOk(data, "plugins_info");
  if (data.name === name && typeof data.apiVersion === "string" && Array.isArray(data.tools)) {
    return pass("plugins_info returned manifest and tool metadata for a declared plugin", {
      name,
      apiVersion: data.apiVersion,
      toolCount: data.tools.length,
    });
  }
  return fail("plugins_info did not return the expected plugin metadata", data);
});

const plugins_list = exercise(async (ctx) => {
  await ctx.goto("/core");
  const data = payloadRecord(await ctx.call("plugins_list"), "plugins_list");
  requireOk(data, "plugins_list");
  if (typeof data.apiVersion === "string" && Array.isArray(data.plugins)) {
    return pass("plugins_list returned plugin runtime version and a plugin array", {
      apiVersion: data.apiVersion,
      pluginCount: data.plugins.length,
    });
  }
  return fail("plugins_list did not return the plugin runtime info shape", data);
});

const map: ExerciseMap = {
  network_read,
  ws_read,
  act_and_diff,
  act_and_sample,
  act_and_wait_for_network,
  cross_session_sample,
  cookies_get,
  cookies_list,
  localstorage_get,
  localstorage_list,
  sessionstorage_get,
  sessionstorage_list,
  idb_get,
  idb_list_databases,
  idb_list_stores,
  caches_get,
  caches_list,
  caches_list_storages,
  dump_storage_state,
  auth_list,
  artifact_get,
  artifact_list,
  diagnostics_report,
  diagnostics_search,
  session_metrics,
  export_session_report,
  export_playwright_script,
  plugins_info,
  plugins_list,
};

export default map;
