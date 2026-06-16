import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass, skip } from "../types.js";

type JsonRecord = Record<string, unknown>;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const CORE = {
  greeting: '[data-testid="greeting"]',
  lede: '[data-testid="lede"]',
  needle: '[data-testid="needle"]',
  ping: '[data-testid="ping"]',
  status: '[data-testid="status"]',
  fruits: ".fruit",
  hidden: '[data-testid="hidden-el"]',
  value: '[data-testid="text-value"]',
  overflow: '[data-testid="overflow-box"]',
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

function imageEvidence(value: unknown): { count: number; bytes: number; mimeTypes: string[] } {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return { count: 0, bytes: 0, mimeTypes: [] };
  }
  let count = 0;
  let bytes = 0;
  const mimeTypes: string[] = [];
  for (const item of value.content) {
    if (
      isRecord(item) &&
      item.type === "image" &&
      typeof item.data === "string" &&
      item.data.length > 0
    ) {
      count++;
      bytes += item.data.length;
      if (typeof item.mimeType === "string") mimeTypes.push(item.mimeType);
    }
  }
  return { count, bytes, mimeTypes };
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

function payloadArray(value: unknown, label: string): unknown[] {
  const data = payload(value);
  if (!Array.isArray(data)) throw new Error(`${label} did not return a JSON array`);
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
  return (
    record.ok === false &&
    (typeof record.engine === "string" ||
      (typeof record.error === "string" && record.error.toLowerCase().includes("engine")))
  );
}

function boxFromRecord(value: unknown, label: string): Box {
  if (!isRecord(value)) throw new Error(`${label} did not include a box`);
  const x = numberAt(value, "x");
  const y = numberAt(value, "y");
  const width = numberAt(value, "width");
  const height = numberAt(value, "height");
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    throw new Error(`${label} box was malformed`);
  }
  return { x, y, width, height };
}

function centre(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function candidateRef(candidate: JsonRecord): string {
  const ref = stringAt(candidate, "ref");
  if (!ref) throw new Error("candidate did not include a ref");
  return ref;
}

function candidateBox(candidate: JsonRecord): Box {
  return boxFromRecord(candidate.bbox, "candidate");
}

async function findCandidate(ctx: ExerciseCtx, query: string, testId?: string): Promise<JsonRecord> {
  const result = await ctx.call("find", { query, maxCandidates: 8, visibleOnly: true });
  const data = payloadRecord(result, "find");
  const candidates = asRecords(data.candidates);
  if (candidates.length === 0) throw new Error(`find returned no candidates for ${query}`);
  if (testId) {
    for (const candidate of candidates) {
      if (candidate.testId === testId) return candidate;
    }
    throw new Error(`find returned candidates but none with testId=${testId}`);
  }
  const first = candidates[0];
  if (!first) throw new Error(`find returned no usable candidates for ${query}`);
  return first;
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

async function verifyTextByRef(
  ctx: ExerciseCtx,
  ref: string,
  text: string,
  exact = false,
): Promise<JsonRecord> {
  const result = await ctx.call("verify_text", { ref, text, exact });
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

async function verifyVisibleByRef(ctx: ExerciseCtx, ref: string): Promise<JsonRecord> {
  const result = await ctx.call("verify_visible", { ref });
  const data = payloadRecord(result, "verify_visible");
  requireOk(data, "verify_visible");
  return data;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasImage(value: unknown): boolean {
  return imageEvidence(value).count > 0;
}

function snapshotFixture(extraNodes: readonly number[]): JsonRecord {
  return {
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count", "trace_node_id", "detachedness"],
        node_types: [["hidden", "array", "object", "string"], "string", "number", "number", "number", "number", "number"],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [["context", "element", "property"], "string_or_number", "node"],
      },
      node_count: 1 + extraNodes.length / 7,
      edge_count: 0,
    },
    nodes: [0, 0, 1, 64, 0, 0, 0, ...extraNodes],
    edges: [],
    strings: ["(root)", "RetainedThing"],
  };
}

async function writeMemoryFixtures(ctx: ExerciseCtx): Promise<{ beforePath: string; afterPath: string }> {
  const dir = "capability-testbed-read-core";
  const beforePath = join(dir, "memory-before.heapsnapshot");
  const afterPath = join(dir, "memory-after.heapsnapshot");
  await mkdir(join(ctx.workspace, dir), { recursive: true });
  await writeFile(join(ctx.workspace, beforePath), JSON.stringify(snapshotFixture([])), "utf8");
  await writeFile(
    join(ctx.workspace, afterPath),
    JSON.stringify(snapshotFixture([2, 1, 2, 4096, 0, 0, 0])),
    "utf8",
  );
  return { beforePath, afterPath };
}

const snapshot = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = await ctx.call("snapshot", { maxNodes: 80 });
  const text = firstText(result);
  if (text?.includes("Hello, browxai") && text.includes('[data-testid="greeting"]')) {
    return pass("snapshot contains the core greeting and test-id anchor", {
      excerpt: text.slice(0, 500),
    });
  }
  return fail("snapshot did not contain the core greeting anchor", { text });
});

const find = exercise(async (ctx) => {
  await ctx.goto("/core");
  const candidate = await findCandidate(ctx, "Ping", "ping");
  const ref = candidateRef(candidate);
  await verifyTextByRef(ctx, ref, "Ping", true);
  return pass("find resolved the Ping button to a verifiable ref", {
    ref,
    selectorHint: candidate.selectorHint,
    bbox: candidate.bbox,
  });
});

const inspect = exercise(async (ctx) => {
  await ctx.goto("/core");
  await verifyVisible(ctx, CORE.overflow);
  const result = await ctx.call("inspect", {
    selector: CORE.overflow,
    styles: ["width", "height", "overflowX", "whiteSpace"],
  });
  const data = payloadRecord(result, "inspect");
  const box = boxFromRecord(data.box, "inspect");
  const overflowing = recordAt(data, "overflowing");
  if (data.found === true && box.width > 0 && overflowing?.x === true) {
    return pass("inspect surfaced geometry and horizontal overflow for the overflow box", {
      box,
      styles: data.styles,
      overflowing,
    });
  }
  return fail("inspect did not report the overflow box as horizontally overflowing", data);
});

const extract = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = await ctx.call("extract", {
    schema: {
      type: "object",
      properties: {
        fruits: {
          type: "array",
          "x-browx-source": { collection: ".fruit" },
          items: { type: "string", "x-browx-source": { text: true } },
        },
      },
    },
  });
  const data = payloadRecord(result, "extract");
  requireOk(data, "extract");
  const extracted = recordAt(data, "data");
  const fruits = Array.isArray(extracted?.fruits) ? extracted.fruits : [];
  const countResult = await ctx.call("verify_count", { selector: CORE.fruits, n: 3 });
  requireOk(payloadRecord(countResult, "verify_count"), "verify_count");
  if (fruits.join("|") === "apple|banana|cherry") {
    return pass("extract returned the three fruit rows as structured data", { fruits });
  }
  return fail("extract did not return the expected fruit list", data);
});

const text_search = exercise(async (ctx) => {
  await ctx.goto("/core");
  await verifyText(ctx, CORE.needle, "unique-needle-7f3a", true);
  const result = await ctx.call("text_search", {
    text: "unique-needle-7f3a",
    exact: true,
    maxMatches: 5,
  });
  const data = payloadRecord(result, "text_search");
  if (numberAt(data, "count") === 1 && asRecords(data.matches).some((m) => m.text === "unique-needle-7f3a")) {
    return pass("text_search found the unique needle exactly once", {
      count: data.count,
      matches: data.matches,
    });
  }
  return fail("text_search did not find the unique needle exactly once", data);
});

const point_probe = exercise(async (ctx) => {
  await ctx.goto("/core");
  const candidate = await findCandidate(ctx, "Ping", "ping");
  const ref = candidateRef(candidate);
  await verifyVisibleByRef(ctx, ref);
  const point = centre(candidateBox(candidate));
  const result = await ctx.call("point_probe", { coords: point });
  const data = payloadRecord(result, "point_probe");
  requireOk(data, "point_probe");
  const stack = asRecords(data.stack);
  const top = stack[0];
  if (top?.testId === "ping" || recordAt(data, "clickableAncestor")?.testId === "ping") {
    return pass("point_probe identified the Ping button at its center coordinate", {
      point,
      top,
      clickableAncestor: data.clickableAncestor,
    });
  }
  return fail("point_probe did not identify the Ping button under the probed point", data);
});

const overflow_detect = exercise(async (ctx) => {
  await ctx.goto("/core");
  const inspectResult = await ctx.call("inspect", { selector: CORE.overflow });
  const inspectData = payloadRecord(inspectResult, "inspect");
  if (recordAt(inspectData, "overflowing")?.x !== true) {
    return fail("setup overflow box was not overflowing according to inspect", inspectData);
  }
  const result = await ctx.call("overflow_detect", { scope: "document", types: ["clipped"], limit: 20 });
  const data = payloadRecord(result, "overflow_detect");
  requireOk(data, "overflow_detect");
  const findings = asRecords(data.findings);
  const hit = findings.find((finding) => stringAt(finding, "selector")?.includes("overflow-box"));
  if (hit && hit.type === "clipped") {
    return pass("overflow_detect flagged the clipped overflow test box", { finding: hit });
  }
  return fail("overflow_detect did not flag the clipped overflow test box", data);
});

const generate_locator = exercise(async (ctx) => {
  await ctx.goto("/core");
  const candidate = await findCandidate(ctx, "Ping", "ping");
  const ref = candidateRef(candidate);
  await verifyVisibleByRef(ctx, ref);
  const result = await ctx.call("generate_locator", { ref });
  const data = payloadRecord(result, "generate_locator");
  requireOk(data, "generate_locator");
  const playwright = stringAt(data, "playwright");
  if (playwright && playwright.includes("ping")) {
    return pass("generate_locator produced a Playwright locator for the Ping ref", {
      ref,
      playwright,
      stability: data.stability,
    });
  }
  return fail("generate_locator did not produce a Ping locator", data);
});

const list_named_refs = exercise(async (ctx) => {
  await ctx.goto("/core");
  const candidate = await findCandidate(ctx, "Ping", "ping");
  const ref = candidateRef(candidate);
  await ctx.call("name_ref", { name: "ping_button", ref });
  const result = await ctx.call("list_named_refs");
  const names = asRecords(payloadArray(result, "list_named_refs"));
  const found = names.find((entry) => entry.name === "ping_button" && entry.ref === ref);
  if (found) {
    return pass("list_named_refs included the name_ref binding for the Ping button", { found });
  }
  return fail("list_named_refs did not include the Ping button binding", { ref, names });
});

const screenshot = exercise(async (ctx) => {
  await ctx.goto("/core");
  await verifyVisible(ctx, CORE.greeting);
  const result = await ctx.call("screenshot", { selector: CORE.greeting, describe: true, scale: "css" });
  const evidence = imageEvidence(result);
  if (evidence.count > 0 && evidence.bytes > 0) {
    return pass("screenshot returned non-empty inline image bytes for the greeting element", evidence);
  }
  return fail("screenshot did not return a non-empty image", { evidence, text: firstText(result) });
});

const screenshot_region = exercise(async (ctx) => {
  await ctx.goto("/core");
  const candidate = await findCandidate(ctx, "Ping", "ping");
  const box = candidateBox(candidate);
  const result = await ctx.call("screenshot_region", { box });
  const evidence = imageEvidence(result);
  if (evidence.count > 0 && evidence.bytes > 0) {
    return pass("screenshot_region returned non-empty PNG bytes for the Ping button bbox", {
      box,
      ...evidence,
    });
  }
  return fail("screenshot_region did not return a non-empty image", { box, text: firstText(result) });
});

const screenshot_marks = exercise(async (ctx) => {
  await ctx.goto("/core");
  const candidate = await findCandidate(ctx, "Ping", "ping");
  const ref = candidateRef(candidate);
  const result = await ctx.call("screenshot_marks", { candidates: [candidate], label: "index" });
  const data = payloadRecord(result, "screenshot_marks");
  const mapping = recordAt(data, "mapping");
  const marks = asRecords(data.marks);
  if (mapping?.["1"] === ref && marks.length === 1 && hasImage(result)) {
    return pass("screenshot_marks returned a mark mapping and non-empty composed image", {
      ref,
      mapping,
      marks,
      image: imageEvidence(result),
    });
  }
  return fail("screenshot_marks did not return the expected mark mapping and image", {
    data,
    image: imageEvidence(result),
  });
});

const verify_visible = exercise(async (ctx) => {
  await ctx.goto("/core");
  const data = await verifyVisible(ctx, CORE.greeting);
  return pass("verify_visible confirmed the greeting is visible", data);
});

const verify_text = exercise(async (ctx) => {
  await ctx.goto("/core");
  const data = await verifyText(ctx, CORE.lede, "The quick brown fox jumps over the lazy dog.", true);
  return pass("verify_text confirmed the lede text exactly", data);
});

const verify_value = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = await ctx.call("verify_value", { selector: CORE.value, value: "prefilled" });
  const data = payloadRecord(result, "verify_value");
  requireOk(data, "verify_value");
  return pass("verify_value confirmed the readonly input value", data);
});

const verify_count = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = await ctx.call("verify_count", { selector: CORE.fruits, n: 3 });
  const data = payloadRecord(result, "verify_count");
  requireOk(data, "verify_count");
  return pass("verify_count confirmed the three fruit rows", data);
});

const verify_attribute = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = await ctx.call("verify_attribute", { selector: CORE.hidden, attr: "hidden" });
  const data = payloadRecord(result, "verify_attribute");
  requireOk(data, "verify_attribute");
  return pass("verify_attribute confirmed the hidden attribute is present", data);
});

const verify_predicate = exercise(async (ctx) => {
  await ctx.goto("/core");
  const search = payloadRecord(
    await ctx.call("text_search", { text: "unique-needle-7f3a", exact: true }),
    "text_search",
  );
  const result = await ctx.call("verify_predicate", {
    data: { value: { needleCount: search.count } },
    predicate: { kind: "equals", key: "value.needleCount", value: 1 },
  });
  const data = payloadRecord(result, "verify_predicate");
  requireOk(data, "verify_predicate");
  return pass("verify_predicate confirmed the text_search count using the fixed predicate vocabulary", {
    predicateData: { needleCount: search.count },
    verify: data,
  });
});

const watch = exercise(async (ctx) => {
  await ctx.goto("/core");
  const watching = ctx.call("watch", { durationMs: 600, sampleMs: 100 });
  await delay(120);
  await ctx.call("click", { selector: CORE.ping });
  await verifyText(ctx, CORE.status, "pong", true);
  const result = await watching;
  const data = payloadRecord(result, "watch");
  const regions = asRecords(data.regions);
  if (numberAt(data, "samples") && Array.isArray(data.regions) && isRecord(data.console) && isRecord(data.network)) {
    return pass("watch completed a bounded observation window while Ping changed the status", {
      samples: data.samples,
      regions,
      console: data.console,
      networkSummary: recordAt(recordAt(data, "network") ?? {}, "summary"),
    });
  }
  return fail("watch did not return a well-formed observation window", data);
});

const sample = exercise(async (ctx) => {
  await ctx.goto("/core");
  await verifyVisible(ctx, CORE.ping);
  const result = await ctx.call("sample", {
    selector: CORE.ping,
    metric: "bboxWidth",
    durationMs: 180,
    intervalMs: 50,
    summary: false,
  });
  const data = payloadRecord(result, "sample");
  const summary = recordAt(data, "summary");
  if (
    data.metric === "bboxWidth" &&
    data.scope === "element" &&
    numberAt(data, "count") !== undefined &&
    Number(data.count) > 0 &&
    summary
  ) {
    return pass("sample returned a bounded bboxWidth time series for the Ping button", {
      metric: data.metric,
      count: data.count,
      summary,
    });
  }
  return fail("sample did not return a well-formed element metric series", data);
});

const plan = exercise(async (ctx) => {
  await ctx.goto("/core");
  const result = await ctx.call("plan", { query: "Ping", verb: "click", ttlMs: 60_000 });
  const data = payloadRecord(result, "plan");
  // `plan` returns the bound descriptor nested under `descriptor`
  // ({ ok, descriptor: { id, ref, verb, args, evidence, expiresAt } }).
  const descriptor = recordAt(data, "descriptor");
  if (!descriptor) return fail("plan did not return a structured click descriptor", data);
  const ref = stringAt(descriptor, "ref");
  const evidence = recordAt(descriptor, "evidence");
  if (descriptor.verb === "click" && ref && evidence) {
    await verifyVisibleByRef(ctx, ref);
    return pass("plan returned a structured click descriptor for the Ping button without dispatching", {
      id: descriptor.id,
      ref,
      verb: descriptor.verb,
      evidence,
      expiresAt: descriptor.expiresAt,
    });
  }
  return fail("plan did not return a structured click descriptor", data);
});

const console_read = exercise(async (ctx) => {
  await ctx.goto("/console");
  await ctx.call("click", { selector: '[data-testid="emit-logs"]' });
  await verifyText(ctx, '[data-testid="console-status"]', "emitted", true);
  const result = await ctx.call("console_read", { limit: 20 });
  const rows = asRecords(payloadArray(result, "console_read"));
  const texts = rows.map((row) => stringAt(row, "text") ?? "").join("\n");
  const expected = ["btn-log", "btn-info", "btn-warn", "btn-error", "btn-debug"];
  const missing = expected.filter((needle) => !texts.includes(needle));
  if (missing.length === 0) {
    return pass("console_read captured all emitted console levels", {
      count: rows.length,
      observed: expected,
    });
  }
  return fail("console_read missed emitted console messages", { missing, rows });
});

const frames_list = exercise(async (ctx) => {
  await ctx.goto("/frames");
  const result = await ctx.call("frames_list");
  const data = payloadRecord(result, "frames_list");
  requireOk(data, "frames_list");
  const frames = asRecords(data.frames);
  if (frames.length === 0) return skip("frames_list returned no frames for the frames surface");
  const urls = frames.map((frame) => stringAt(frame, "url") ?? "");
  const hasNested =
    urls.some((url) => url.includes("/frames/child-a")) &&
    urls.some((url) => url.includes("/frames/child-b")) &&
    urls.some((url) => url.includes("/frames/grandchild"));
  if (frames.length >= 4 && hasNested) {
    return pass("frames_list returned the parent, two child frames, and the grandchild frame", {
      count: frames.length,
      urls,
    });
  }
  return fail("frames_list did not expose the expected nested frame tree", data);
});

const shadow_trees = exercise(async (ctx) => {
  await ctx.goto("/shadow");
  await verifyVisible(ctx, '[data-testid="open-host"]');
  const result = await ctx.call("shadow_trees", { maxHosts: 10 });
  const data = payloadRecord(result, "shadow_trees");
  if (unsupportedEngine(data)) return skip(`shadow_trees unsupported on engine: ${String(data.engine)}`);
  const trees = asRecords(data.trees);
  const open = trees.find((tree) => tree.hostTag === "open-card" && tree.mode === "open");
  if (open) {
    return pass("shadow_trees surfaced the open-card shadow root", {
      hostTag: open.hostTag,
      mode: open.mode,
      descendantCount: open.descendantCount,
      closedShadowAvailable: data.closedShadowAvailable,
      warnings: data.warnings,
    });
  }
  return fail("shadow_trees did not surface the open-card shadow root", data);
});

const perf_audit = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const auditing = ctx.call("perf_audit", {
    durationMs: 900,
    format: "summary",
    categories: ["layout-thrashing", "long-tasks"],
  });
  await delay(120);
  await ctx.call("click", { selector: '[data-testid="thrash"]' });
  await verifyText(ctx, '[data-testid="perf-out"]', "thrashed", true);
  const data = payloadRecord(await auditing, "perf_audit");
  if (unsupportedEngine(data)) return skip(`perf_audit unsupported on engine: ${String(data.engine)}`);
  requireOk(data, "perf_audit");
  const summary = recordAt(data, "summary");
  const evidence = recordAt(data, "evidence");
  if (summary && typeof summary.score === "number" && evidence && stringAt(evidence, "tracePath")) {
    return pass("perf_audit returned a structured summary and trace evidence", {
      score: summary.score,
      categoriesRun: data.categoriesRun,
      tracePath: evidence.tracePath,
      warnings: data.warnings,
    });
  }
  return fail("perf_audit did not return the expected structured audit shape", data);
});

const layout_thrash_trace = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const tracing = ctx.call("layout_thrash_trace", { durationMs: 900 });
  await delay(120);
  await ctx.call("click", { selector: '[data-testid="thrash"]' });
  await verifyText(ctx, '[data-testid="perf-out"]', "thrashed", true);
  const data = payloadRecord(await tracing, "layout_thrash_trace");
  if (unsupportedEngine(data)) return skip(`layout_thrash_trace unsupported on engine: ${String(data.engine)}`);
  requireOk(data, "layout_thrash_trace");
  const forced = numberAt(data, "forcedLayoutsCount");
  const eventsByOrigin = asRecords(data.eventsByOrigin);
  if (forced !== undefined && stringAt(data, "tracePath") && (forced > 0 || eventsByOrigin.length > 0)) {
    return pass("layout_thrash_trace captured forced layout evidence from the thrash button", {
      forcedLayoutsCount: forced,
      layoutShiftsCount: data.layoutShiftsCount,
      origins: eventsByOrigin.slice(0, 3),
      tracePath: data.tracePath,
    });
  }
  return fail("layout_thrash_trace returned no forced-layout evidence", data);
});

const memory_diff = exercise(async (ctx) => {
  const { beforePath, afterPath } = await writeMemoryFixtures(ctx);
  const result = await ctx.call("memory_diff", { beforePath, afterPath });
  const data = payloadRecord(result, "memory_diff");
  requireOk(data, "memory_diff");
  const growth = asRecords(data.retainerGrowth);
  const retained = growth.find((row) => row.node === "object:RetainedThing");
  const summary = recordAt(data, "summary");
  if (retained && numberAt(retained, "deltaBytes") === 4096 && numberAt(summary ?? {}, "totalGrowth") === 4096) {
    return pass("memory_diff reported retainer growth from valid heap snapshot fixtures", {
      beforePath,
      afterPath,
      retained,
      summary,
    });
  }
  return fail("memory_diff did not report the expected retainer growth", data);
});

const coverage_stop = exercise(async (ctx) => {
  await ctx.goto("/perf");
  const started = payloadRecord(await ctx.call("coverage_start"), "coverage_start");
  if (unsupportedEngine(started)) return skip(`coverage_start unsupported on engine: ${String(started.engine)}`);
  requireOk(started, "coverage_start");
  await ctx.call("click", { selector: '[data-testid="thrash"]' });
  await verifyText(ctx, '[data-testid="perf-out"]', "thrashed", true);
  const data = payloadRecord(await ctx.call("coverage_stop"), "coverage_stop");
  if (unsupportedEngine(data)) return skip(`coverage_stop unsupported on engine: ${String(data.engine)}`);
  requireOk(data, "coverage_stop");
  if (Array.isArray(data.jsCoverage) && Array.isArray(data.cssCoverage) && numberAt(data, "durationMs") !== undefined) {
    return pass("coverage_stop returned structured JS and CSS coverage after an armed interaction", {
      jsEntries: data.jsCoverage.length,
      cssEntries: data.cssCoverage.length,
      durationMs: data.durationMs,
    });
  }
  return fail("coverage_stop did not return structured coverage arrays", data);
});

const permission_state = exercise(async (ctx) => {
  await ctx.goto("/permissions");
  await verifyVisible(ctx, '[data-testid="query-perms"]');
  const result = await ctx.call("permission_state", {
    permissions: ["geolocation", "notifications", "camera", "made-up-permission"],
  });
  const data = payloadRecord(result, "permission_state");
  requireOk(data, "permission_state");
  const states = recordAt(data, "states");
  const geo = states ? stringAt(states, "geolocation") : undefined;
  const unknown = states ? stringAt(states, "made-up-permission") : undefined;
  if (geo && ["granted", "denied", "prompt", "unknown"].includes(geo) && unknown === "unknown") {
    return pass("permission_state returned geolocation and unknown-permission states", {
      origin: data.origin,
      states,
    });
  }
  return fail("permission_state did not return the expected states map", data);
});

const map: ExerciseMap = {
  snapshot,
  find,
  inspect,
  extract,
  text_search,
  point_probe,
  overflow_detect,
  generate_locator,
  list_named_refs,
  screenshot,
  screenshot_region,
  screenshot_marks,
  verify_visible,
  verify_text,
  verify_value,
  verify_count,
  verify_attribute,
  verify_predicate,
  watch,
  sample,
  plan,
  console_read,
  frames_list,
  shadow_trees,
  perf_audit,
  layout_thrash_trace,
  memory_diff,
  coverage_stop,
  permission_state,
};

export default map;
