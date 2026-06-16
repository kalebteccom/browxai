import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Exercise, ExerciseCtx, ExerciseMap, ExerciseResult } from "../types.js";
import { fail, pass, skip } from "../types.js";

type JsonRecord = Record<string, unknown>;

const MEDIA = {
  fileInput: '[data-testid="file-input"]',
  dropZone: '[data-testid="drop-zone"]',
  fileOut: '[data-testid="file-out"]',
  downloadLink: '[data-testid="download-link"]',
  openPicker: '[data-testid="open-picker"]',
  fsaOut: '[data-testid="fsa-out"]',
  video: '[data-testid="video"]',
  paintCanvas: '[data-testid="paint-canvas"]',
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

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
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

function isStructuredRefusal(record: JsonRecord): boolean {
  return record.ok === false && typeof record.error === "string";
}

function baseDir(ctx: ExerciseCtx, purpose: string): string {
  const safeSession = ctx.session.replace(/[^A-Za-z0-9._-]/g, "_");
  return `capability-testbed/${safeSession}/${purpose}-${Date.now()}`;
}

function toBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function fromBase64(text: string): string {
  return Buffer.from(text, "base64").toString("utf8");
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

async function fileBytes(path: string): Promise<number> {
  const info = await stat(path);
  return info.size;
}

async function verifyVisible(ctx: ExerciseCtx, selector: string): Promise<JsonRecord> {
  const data = payloadRecord(await ctx.call("verify_visible", { selector }), "verify_visible");
  requireOk(data, "verify_visible");
  return data;
}

async function verifyText(
  ctx: ExerciseCtx,
  selector: string,
  text: string,
  exact = false,
): Promise<JsonRecord> {
  return payloadRecord(await ctx.call("verify_text", { selector, text, exact }), "verify_text");
}

async function waitForText(ctx: ExerciseCtx, text: string, timeoutMs = 3_000): Promise<JsonRecord> {
  await ctx.call("wait_for", { text, timeoutMs });
  return verifyText(ctx, MEDIA.fileOut, text, false);
}

async function waitForPickerText(
  ctx: ExerciseCtx,
  text: string,
  timeoutMs = 3_000,
): Promise<JsonRecord> {
  await ctx.call("wait_for", { text, timeoutMs });
  return verifyText(ctx, MEDIA.fsaOut, text, false);
}

async function findRef(ctx: ExerciseCtx, query: string, testId: string): Promise<string> {
  const result = await ctx.call("find", { query, maxCandidates: 8, visibleOnly: true });
  const data = payloadRecord(result, "find");
  const candidates = asRecords(data.candidates);
  const match = candidates.find((candidate) => candidate.testId === testId);
  const ref = match ? stringAt(match, "ref") : undefined;
  if (!ref) throw new Error(`find did not return a ref for testId=${testId}`);
  return ref;
}

async function waitForCapturedDownload(
  ctx: ExerciseCtx,
): Promise<{ listData: JsonRecord; download: JsonRecord; id: string }> {
  for (let attempt = 0; attempt < 15; attempt++) {
    const listData = payloadRecord(
      await ctx.call("downloads_capture", { on: true }),
      "downloads_capture",
    );
    requireOk(listData, "downloads_capture");
    const first = asRecords(listData.captured)[0];
    const id = first ? stringAt(first, "id") : undefined;
    if (first && id) return { listData, download: first, id };
    await delay(100);
  }
  throw new Error("download capture did not record a download id");
}

async function captureDownload(
  ctx: ExerciseCtx,
): Promise<{ armed: JsonRecord; listData: JsonRecord; download: JsonRecord; id: string }> {
  await ctx.goto("/media-files");
  await verifyVisible(ctx, MEDIA.downloadLink);
  const armed = payloadRecord(
    await ctx.call("downloads_capture", { on: true }),
    "downloads_capture",
  );
  requireOk(armed, "downloads_capture");
  await ctx.call("click", { selector: MEDIA.downloadLink });
  await verifyVisible(ctx, MEDIA.downloadLink);
  const captured = await waitForCapturedDownload(ctx);
  return { armed, ...captured };
}

async function verifyDirectVisible(
  ctx: ExerciseCtx,
  session: string,
  selector: string,
): Promise<JsonRecord> {
  const data = payloadRecord(
    await ctx.client.callTool("verify_visible", { session, selector }),
    "verify_visible",
  );
  requireOk(data, "verify_visible");
  return data;
}

async function closeQuietly(ctx: ExerciseCtx, session: string): Promise<void> {
  try {
    await ctx.client.callTool("close_session", { session });
  } catch {
    /* cleanup best effort */
  }
}

async function openRecordedSession(
  ctx: ExerciseCtx,
  purpose: string,
): Promise<{ ok: true; session: string; openData: JsonRecord } | { ok: false; openData: JsonRecord }> {
  const session = `file-io-video-${purpose}-${Date.now()}`;
  const openData = payloadRecord(
    await ctx.client.callTool("open_session", {
      session,
      mode: "incognito",
      recordVideo: {
        path: `${baseDir(ctx, purpose)}/recording.webm`,
        size: { width: 320, height: 240 },
      },
    }),
    "open_session",
  );
  if (openData.ok !== true) return { ok: false, openData };
  await ctx.client.callTool("navigate", { session, url: `${ctx.baseUrl}/media-files` });
  await verifyDirectVisible(ctx, session, MEDIA.video);
  return { ok: true, session, openData };
}

const upload_file = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  await verifyVisible(ctx, MEDIA.fileInput);
  const name = "upload.txt";
  const contents = "upload-payload";
  const bytes = Buffer.byteLength(contents, "utf8");
  const data = payloadRecord(
    await ctx.call("upload_file", {
      selector: MEDIA.fileInput,
      name,
      mimeType: "text/plain",
      content: toBase64(contents),
    }),
    "upload_file",
  );
  requireOk(data, "upload_file");
  const visible = await waitForText(ctx, `${name}:${bytes}`);
  if (visible.ok === true && data.name === name && data.bytes === bytes) {
    return pass("upload_file populated the file input and the page reported the file", {
      tool: data,
      visible,
    });
  }
  return fail("upload_file did not produce the expected page file readout", { tool: data, visible });
});

const drop_files = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  await verifyVisible(ctx, MEDIA.dropZone);
  const data = payloadRecord(
    await ctx.call("drop_files", {
      selector: MEDIA.dropZone,
      files: [
        {
          contents: toBase64("drop-payload"),
          name: "dropped.txt",
          mimeType: "text/plain",
        },
      ],
    }),
    "drop_files",
  );
  requireOk(data, "drop_files");
  const visible = await waitForText(ctx, "dropped:dropped.txt");
  if (visible.ok === true && data.dropDispatched === true && data.fileCount === 1) {
    return pass("drop_files dispatched a real drop and the page received the file name", {
      tool: data,
      visible,
    });
  }
  return fail("drop_files did not produce the expected page drop readout", { tool: data, visible });
});

const downloads_capture = exercise(async (ctx) => {
  const captured = await captureDownload(ctx);
  if (stringAt(captured.download, "suggestedFilename") === "report.txt") {
    return pass("downloads_capture recorded the page-initiated report download", captured);
  }
  return fail("downloads_capture did not list the report.txt download", captured);
});

const download_get = exercise(async (ctx) => {
  const captured = await captureDownload(ctx);
  const data = payloadRecord(await ctx.call("download_get", { id: captured.id }), "download_get");
  requireOk(data, "download_get");
  const content = stringAt(data, "content");
  if (content && fromBase64(content) === "download-file-contents") {
    return pass("download_get returned the captured report bytes", {
      captured,
      download: {
        id: data.id,
        suggestedFilename: data.suggestedFilename,
        sizeBytes: data.sizeBytes,
        path: data.path,
      },
    });
  }
  return fail("download_get did not return the expected report payload", { captured, data });
});

const fs_picker_respond = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  await verifyVisible(ctx, MEDIA.openPicker);
  const policy = payloadRecord(
    await ctx.call("set_fs_picker_policy", { mode: "allow" }),
    "set_fs_picker_policy",
  );
  requireOk(policy, "set_fs_picker_policy");
  await verifyVisible(ctx, MEDIA.openPicker);

  const staged = payloadRecord(
    await ctx.call("fs_picker_respond", {
      api: "showOpenFilePicker",
      files: [
        {
          contents: toBase64("picker-payload"),
          name: "picker.txt",
          mimeType: "text/plain",
        },
      ],
    }),
    "fs_picker_respond",
  );
  requireOk(staged, "fs_picker_respond");

  await ctx.call("click", { selector: MEDIA.openPicker });
  const opened = await waitForPickerText(ctx, "opened:picker.txt");
  if (opened.ok === true) {
    return pass("fs_picker_respond staged a file handle consumed by showOpenFilePicker", {
      policy,
      staged,
      opened,
    });
  }
  const typeError = await verifyText(ctx, MEDIA.fsaOut, "open-error:TypeError", false);
  if (typeError.ok === true) {
    return skip("File System Access picker API was unavailable in this browser context");
  }
  return fail("fs_picker_respond was not consumed by the page picker", { policy, staged, opened });
});

const page_archive = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  await verifyVisible(ctx, MEDIA.fileInput);
  const rel = baseDir(ctx, "page-archive");
  const data = payloadRecord(
    await ctx.call("page_archive", { format: "directory", path: rel }),
    "page_archive",
  );
  requireOk(data, "page_archive");
  await verifyVisible(ctx, MEDIA.fileInput);
  const outputPath = stringAt(data, "path");
  if (!outputPath) return fail("page_archive did not return an output path", data);
  const html = await readTextFile(join(outputPath, "index.html"));
  // The page title is "Media & files surface"; a faithful archive HTML-escapes
  // the ampersand ("Media &amp; files surface"), so assert an ampersand-agnostic
  // marker (the surface id + the visible-heading tail) rather than the raw text.
  if (html.includes('data-surface="media-files"') && html.includes("files surface")) {
    return pass("page_archive wrote an offline directory archive with index.html", {
      path: outputPath,
      sizeBytes: data.sizeBytes,
      indexBytes: Buffer.byteLength(html, "utf8"),
    });
  }
  return fail("page_archive index.html did not contain the media surface", { data, html });
});

const element_export = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  await verifyVisible(ctx, MEDIA.openPicker);
  const ref = await findRef(ctx, "showOpenFilePicker", "open-picker");
  const rel = `${baseDir(ctx, "element-export")}/open-picker.html`;
  const data = payloadRecord(
    await ctx.call("element_export", { ref, format: "single-file", intoDir: rel }),
    "element_export",
  );
  requireOk(data, "element_export");
  await verifyVisible(ctx, MEDIA.openPicker);
  const outputPath = stringAt(data, "path");
  if (!outputPath) return fail("element_export did not return an output path", data);
  const html = await readTextFile(outputPath);
  if (html.includes("showOpenFilePicker")) {
    return pass("element_export wrote a self-contained snippet for the picker button", {
      ref,
      path: outputPath,
      bytes: Buffer.byteLength(html, "utf8"),
    });
  }
  return fail("element_export output did not contain the picker button text", { data, html });
});

const dom_export = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  await verifyVisible(ctx, MEDIA.fileInput);
  const rel = `${baseDir(ctx, "dom-export")}/dom.jsonl`;
  const data = payloadRecord(
    await ctx.call("dom_export", { format: "jsonl", includeShadow: true, path: rel }),
    "dom_export",
  );
  requireOk(data, "dom_export");
  await verifyVisible(ctx, MEDIA.fileInput);
  const outputPath = stringAt(data, "path");
  if (!outputPath) return fail("dom_export did not return an output path", data);
  const dump = await readTextFile(outputPath);
  if (dump.includes("file-input") && dump.includes("drop-zone")) {
    return pass("dom_export wrote a JSONL DOM dump containing the media anchors", {
      path: outputPath,
      nodeCount: data.nodeCount,
      bytes: Buffer.byteLength(dump, "utf8"),
    });
  }
  return fail("dom_export JSONL did not include expected media anchors", { data, dump });
});

const asset_export = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  await verifyVisible(ctx, MEDIA.fileInput);
  const network = payload(await ctx.call("network_read", { limit: 20 }));
  const rel = baseDir(ctx, "asset-export");
  const data = payloadRecord(
    await ctx.call("asset_export", {
      filter: { status: [200] },
      intoDir: rel,
      maxCount: 5,
    }),
    "asset_export",
  );
  requireOk(data, "asset_export");
  await verifyVisible(ctx, MEDIA.fileInput);
  const intoDir = stringAt(data, "intoDir");
  const manifest = asRecords(data.manifest);
  const savedAs = manifest.map((entry) => stringAt(entry, "savedAs")).filter((v): v is string => !!v);
  if (!intoDir || savedAs.length === 0 || numberAt(data, "persistedCount") === 0) {
    return fail("asset_export did not persist matching network assets", { data, network });
  }
  const firstSaved = savedAs[0];
  if (!firstSaved) return fail("asset_export manifest did not contain a saved filename", data);
  const bytes = await fileBytes(join(intoDir, firstSaved));
  return pass("asset_export persisted at least one response from the session network ring", {
    intoDir,
    persistedCount: data.persistedCount,
    firstSaved,
    bytes,
  });
});

const screenshot_schedule = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  await verifyVisible(ctx, MEDIA.paintCanvas);
  const rel = baseDir(ctx, "screenshot-schedule");
  const data = payloadRecord(
    await ctx.call("screenshot_schedule", {
      everyMs: 100,
      count: 2,
      intoDir: rel,
      format: "png",
    }),
    "screenshot_schedule",
  );
  requireOk(data, "screenshot_schedule");
  await verifyVisible(ctx, MEDIA.paintCanvas);
  const paths = asStrings(data.paths);
  if (paths.length < 2) {
    return fail("screenshot_schedule did not return at least two screenshot paths", data);
  }
  const sizes = await Promise.all(paths.map((path) => fileBytes(path)));
  if (sizes.every((size) => size > 0)) {
    return pass("screenshot_schedule wrote bounded periodic screenshots", {
      count: data.count,
      paths,
      sizes,
    });
  }
  return fail("screenshot_schedule returned an empty screenshot file", { data, sizes });
});

const screenshot_on = exercise(async (ctx) => {
  await ctx.goto("/media-files");
  await verifyVisible(ctx, MEDIA.fileInput);
  const rel = baseDir(ctx, "screenshot-on");
  const observing = ctx.call("screenshot_on", {
    trigger: "navigation",
    durationMs: 800,
    intoDir: rel,
    format: "png",
  });
  await delay(150);
  await ctx.goto("/media-files?shot=1");
  await verifyVisible(ctx, MEDIA.fileInput);
  const data = payloadRecord(await observing, "screenshot_on");
  requireOk(data, "screenshot_on");
  const paths = asStrings(data.paths);
  if (paths.length === 0) {
    return fail("screenshot_on did not capture the triggered navigation", data);
  }
  const sizes = await Promise.all(paths.map((path) => fileBytes(path)));
  if (sizes.every((size) => size > 0)) {
    return pass("screenshot_on captured an event-driven screenshot for navigation", {
      trigger: data.trigger,
      paths,
      sizes,
    });
  }
  return fail("screenshot_on returned an empty screenshot file", { data, sizes });
});

const stop_video = exercise(async (ctx) => {
  const opened = await openRecordedSession(ctx, "stop-video");
  if (!opened.ok) {
    if (isStructuredRefusal(opened.openData)) {
      return skip(`recordVideo session was refused: ${String(opened.openData.error)}`);
    }
    return fail("open_session did not create a recorded session", opened.openData);
  }
  try {
    const data = payloadRecord(
      await ctx.client.callTool("stop_video", { session: opened.session }),
      "stop_video",
    );
    await verifyDirectVisible(ctx, opened.session, MEDIA.video);
    if (
      data.ok === true &&
      data.wasActive === true &&
      data.pendingFinalize === true &&
      data.finalizesOn === "close_session"
    ) {
      return pass("stop_video marked the active recorder for close-time finalization", {
        open: opened.openData,
        stop: data,
      });
    }
    return fail("stop_video did not return the expected pending-finalize state", {
      open: opened.openData,
      stop: data,
    });
  } finally {
    await closeQuietly(ctx, opened.session);
  }
});

const get_video = exercise(async (ctx) => {
  const opened = await openRecordedSession(ctx, "get-video");
  if (!opened.ok) {
    if (isStructuredRefusal(opened.openData)) {
      return skip(`recordVideo session was refused: ${String(opened.openData.error)}`);
    }
    return fail("open_session did not create a recorded session", opened.openData);
  }
  try {
    const stopped = payloadRecord(
      await ctx.client.callTool("stop_video", { session: opened.session }),
      "stop_video",
    );
    await verifyDirectVisible(ctx, opened.session, MEDIA.video);
    const data = payloadRecord(
      await ctx.client.callTool("get_video", { session: opened.session, format: "path" }),
      "get_video",
    );
    if (data.ok === true && numberAt(data, "bytes") !== undefined) {
      return pass("get_video returned finalized video metadata", {
        open: opened.openData,
        stopped,
        video: data,
      });
    }
    const error = stringAt(data, "error");
    if (data.ok === false && error?.includes("not yet on disk") === true) {
      return pass("get_video returned the expected structured pre-finalization state", {
        open: opened.openData,
        stopped,
        video: data,
      });
    }
    return fail("get_video did not return finalized metadata or a structured pre-finalization state", {
      open: opened.openData,
      stopped,
      video: data,
    });
  } finally {
    await closeQuietly(ctx, opened.session);
  }
});

const map: ExerciseMap = {
  upload_file,
  drop_files,
  downloads_capture,
  download_get,
  fs_picker_respond,
  page_archive,
  element_export,
  dom_export,
  asset_export,
  screenshot_schedule,
  screenshot_on,
  get_video,
  stop_video,
};

export default map;
