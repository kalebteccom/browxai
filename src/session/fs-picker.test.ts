import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FsPickerPolicyState,
  attachFsPickerPolicy,
  parseFsPickerPolicyArg,
  resolveWorkspaceFsPath,
  SUPPORTED_FS_PICKER_APIS,
  UNHANDLED_FS_PICKER_HINT,
  FS_PICKER_PAGE_SCRIPT,
  type FsPickerAskHandler,
  type FsPickerApi,
} from "./fs-picker.js";
import type { BrowserContext, Page } from "playwright-core";

// ---- fakes ----------------------------------------------------------------

function fakePage(): Page {
  return {
    url: () => "https://example.com/x",
    evaluate: vi.fn(async () => undefined),
  } as unknown as Page;
}

function fakeContext(
  opts: {
    bindings?: Map<string, (source: unknown, payload: string) => unknown>;
    initScripts?: string[];
    pages?: Page[];
  } = {},
): BrowserContext {
  const bindings = opts.bindings ?? new Map();
  const initScripts = opts.initScripts ?? [];
  const pages = opts.pages ?? [fakePage()];
  return {
    exposeBinding: async (name: string, fn: (source: unknown, payload: string) => unknown) => {
      bindings.set(name, fn);
    },
    addInitScript: async (script: { content: string }) => {
      initScripts.push(script.content);
    },
    pages: () => pages,
  } as unknown as BrowserContext;
}

// ---- parseFsPickerPolicyArg ----------------------------------------------

describe("parseFsPickerPolicyArg", () => {
  it("defaults to raise when undefined", () => {
    expect(parseFsPickerPolicyArg(undefined)).toEqual({ mode: "raise" });
  });
  it("parses each simple string mode", () => {
    for (const m of ["allow", "deny", "raise", "ask-human"] as const) {
      expect(parseFsPickerPolicyArg(m)).toEqual({ mode: m });
    }
  });
  it("accepts object form with perAPI overrides", () => {
    expect(
      parseFsPickerPolicyArg({
        mode: "raise",
        perAPI: { showSaveFilePicker: "allow", showOpenFilePicker: "deny" },
      }),
    ).toEqual({
      mode: "raise",
      perAPI: { showSaveFilePicker: "allow", showOpenFilePicker: "deny" },
    });
  });
  it("rejects unknown top-level modes", () => {
    expect(() => parseFsPickerPolicyArg("yes")).toThrow(/invalid/i);
  });
  it("rejects unknown per-API keys", () => {
    expect(() =>
      parseFsPickerPolicyArg({ mode: "raise", perAPI: { showFontPicker: "allow" } as never }),
    ).toThrow(/unknown API/);
  });
  it("rejects unknown per-API modes", () => {
    expect(() =>
      parseFsPickerPolicyArg({ mode: "raise", perAPI: { showSaveFilePicker: "yes" as never } }),
    ).toThrow(/invalid mode/);
  });
});

// ---- FsPickerPolicyState basics + mode resolution ------------------------

describe("FsPickerPolicyState", () => {
  it("defaults to raise", () => {
    const s = new FsPickerPolicyState();
    expect(s.current()).toEqual({ mode: "raise" });
    expect(s.modeFor("showSaveFilePicker")).toBe("raise");
  });

  it("modeFor honours per-API override over top-level", () => {
    const s = new FsPickerPolicyState({
      mode: "allow",
      perAPI: { showSaveFilePicker: "deny", showDirectoryPicker: "ask-human" },
    });
    expect(s.modeFor("showSaveFilePicker")).toBe("deny");
    expect(s.modeFor("showDirectoryPicker")).toBe("ask-human");
    expect(s.modeFor("showOpenFilePicker")).toBe("allow"); // falls back
  });

  it("set() flips policy for the NEXT call; prior records unchanged", () => {
    const s = new FsPickerPolicyState({ mode: "allow" });
    const t0 = Date.now();
    s.record({ api: "showSaveFilePicker", handledAs: "allowed", ts: t0 });
    s.set({ mode: "deny" });
    expect(s.current().mode).toBe("deny");
    expect(s.since(t0)).toHaveLength(1);
    expect(s.since(t0)[0]?.handledAs).toBe("allowed");
  });

  it("buffer is capped — oldest record evicted past cap", () => {
    const s = new FsPickerPolicyState({ mode: "allow" }, 3);
    const t = Date.now();
    for (let i = 0; i < 5; i++) {
      s.record({
        api: "showSaveFilePicker",
        suggestedName: `f${i}`,
        handledAs: "allowed",
        ts: t + i,
      });
    }
    const slice = s.since(0);
    expect(slice).toHaveLength(3);
    expect(slice.map((r) => r.suggestedName)).toEqual(["f2", "f3", "f4"]);
  });

  it("raisedSince() — true iff a raised record sits in the window", () => {
    const s = new FsPickerPolicyState();
    const t = Date.now();
    s.record({ api: "showSaveFilePicker", handledAs: "allowed", ts: t });
    expect(s.raisedSince(t)).toBe(false);
    s.record({ api: "showOpenFilePicker", handledAs: "raised", ts: t + 1 });
    expect(s.raisedSince(t)).toBe(true);
  });

  it("response queue is per-API and FIFO", () => {
    const s = new FsPickerPolicyState();
    s.pushResponse("showSaveFilePicker", [{ path: "out1.txt" }]);
    s.pushResponse("showSaveFilePicker", [{ path: "out2.txt" }]);
    s.pushResponse("showOpenFilePicker", [{ contents: "AA==" }]);
    expect(s.dequeueResponse("showSaveFilePicker")).toEqual([{ path: "out1.txt" }]);
    expect(s.dequeueResponse("showOpenFilePicker")).toEqual([{ contents: "AA==" }]);
    expect(s.dequeueResponse("showSaveFilePicker")).toEqual([{ path: "out2.txt" }]);
    expect(s.dequeueResponse("showSaveFilePicker")).toBeUndefined();
  });
});

// ---- exposed constants + hint --------------------------------------------

describe("UNHANDLED_FS_PICKER_HINT", () => {
  it("mentions both set knobs and the page-side rejection", () => {
    expect(UNHANDLED_FS_PICKER_HINT).toMatch(/open_session/);
    expect(UNHANDLED_FS_PICKER_HINT).toMatch(/set_fs_picker_policy/);
    expect(UNHANDLED_FS_PICKER_HINT).toMatch(/rejected page-side/);
    expect(UNHANDLED_FS_PICKER_HINT).toMatch(/fs_picker_respond/);
  });
});

// ---- workspace-escape rejection ------------------------------------------

describe("resolveWorkspaceFsPath", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "browx-fspath-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });
  it("accepts a path inside the workspace", () => {
    const r = resolveWorkspaceFsPath(ws, "sub/out.txt");
    expect(r.startsWith(ws)).toBe(true);
  });
  it("rejects path traversal escaping the workspace", () => {
    expect(() => resolveWorkspaceFsPath(ws, "../escape.txt")).toThrow(/inside \$BROWX_WORKSPACE/);
  });
  it("rejects an absolute path outside the workspace", () => {
    expect(() => resolveWorkspaceFsPath(ws, "/etc/passwd")).toThrow(/inside \$BROWX_WORKSPACE/);
  });
});

// ---- attachFsPickerPolicy — binding per mode -----------------------------

async function setupCheck(
  policy: ConstructorParameters<typeof FsPickerPolicyState>[0],
  ws: string,
  ask?: FsPickerAskHandler,
) {
  const state = new FsPickerPolicyState(policy);
  const bindings = new Map<string, (source: unknown, payload: string) => unknown>();
  const initScripts: string[] = [];
  const ctx = fakeContext({ bindings, initScripts });
  await attachFsPickerPolicy(ctx, state, ws, ask ?? (async () => null));
  const check = bindings.get("__browx_fs_picker_check");
  const write = bindings.get("__browx_fs_picker_write");
  if (!check || !write) throw new Error("bindings not installed");
  return { state, check, write, initScripts };
}

describe("attachFsPickerPolicy — check handler per mode", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "browx-fspol-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('deny → decision deny, records handledAs:"denied"', async () => {
    const { state, check } = await setupCheck({ mode: "deny" }, ws);
    const t = Date.now();
    const raw = await check(
      {},
      JSON.stringify({ api: "showSaveFilePicker", suggestedName: "a.txt" }),
    );
    expect(JSON.parse(String(raw))).toEqual({ decision: "deny" });
    const rec = state.since(t)[0];
    expect(rec?.api).toBe("showSaveFilePicker");
    expect(rec?.handledAs).toBe("denied");
    expect(rec?.suggestedName).toBe("a.txt");
  });

  it('raise → decision deny, records handledAs:"raised", flips raisedSince', async () => {
    const { state, check } = await setupCheck({ mode: "raise" }, ws);
    const t = Date.now();
    const raw = await check({}, JSON.stringify({ api: "showOpenFilePicker" }));
    expect(JSON.parse(String(raw))).toEqual({ decision: "deny" });
    expect(state.since(t)[0]?.handledAs).toBe("raised");
    expect(state.raisedSince(t)).toBe(true);
  });

  it("allow + queued response → decision allow with files[]", async () => {
    const { state, check } = await setupCheck({ mode: "allow" }, ws);
    state.pushResponse("showSaveFilePicker", [{ path: "out.txt" }]);
    const raw = await check(
      {},
      JSON.stringify({ api: "showSaveFilePicker", suggestedName: "ignored" }),
    );
    const parsed = JSON.parse(String(raw)) as {
      decision: string;
      files: Array<{ name: string; handleId: string }>;
    };
    expect(parsed.decision).toBe("allow");
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.name).toBe("out.txt");
    expect(parsed.files[0]!.handleId).toMatch(/^h\d+/);
  });

  it("allow + empty queue → still allow with one virtual file (no NPE on the page)", async () => {
    const { check } = await setupCheck({ mode: "allow" }, ws);
    const raw = await check({}, JSON.stringify({ api: "showSaveFilePicker" }));
    const parsed = JSON.parse(String(raw)) as { decision: string; files: Array<{ name: string }> };
    expect(parsed.decision).toBe("allow");
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.name).toBe("browxai-virtual");
  });

  it("allow on showOpenFilePicker → multi-file shape", async () => {
    const { state, check } = await setupCheck({ mode: "allow" }, ws);
    state.pushResponse("showOpenFilePicker", [
      { contents: "QUFB", name: "a.txt" },
      { contents: "QkJC", name: "b.txt" },
    ]);
    const raw = await check({}, JSON.stringify({ api: "showOpenFilePicker" }));
    const parsed = JSON.parse(String(raw)) as {
      decision: string;
      files: Array<{ name: string; contents: string }>;
    };
    expect(parsed.decision).toBe("allow");
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("allow on showDirectoryPicker → single virtual directory handle", async () => {
    const { state, check } = await setupCheck({ mode: "allow" }, ws);
    writeFileSync(join(ws, "placeholder"), ""); // workspace exists
    state.pushResponse("showDirectoryPicker", [{ path: "subdir" }]);
    const raw = await check({}, JSON.stringify({ api: "showDirectoryPicker" }));
    const parsed = JSON.parse(String(raw)) as { decision: string; files: Array<{ name: string }> };
    expect(parsed.decision).toBe("allow");
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]!.name).toBe("subdir");
  });

  it("ask-human + handler 'allow' files → decision allow", async () => {
    const ask: FsPickerAskHandler = async () => [{ path: "approved.txt" }];
    const { state, check } = await setupCheck({ mode: "ask-human" }, ws, ask);
    const t = Date.now();
    const raw = await check(
      {},
      JSON.stringify({ api: "showSaveFilePicker", suggestedName: "x.txt" }),
    );
    const parsed = JSON.parse(String(raw)) as { decision: string; files: Array<{ name: string }> };
    expect(parsed.decision).toBe("allow");
    expect(parsed.files[0]!.name).toBe("approved.txt");
    expect(state.since(t)[0]?.handledAs).toBe("asked-human");
  });

  it("ask-human + handler null → decision deny", async () => {
    const { check } = await setupCheck({ mode: "ask-human" }, ws, async () => null);
    const raw = await check({}, JSON.stringify({ api: "showSaveFilePicker" }));
    expect(JSON.parse(String(raw))).toEqual({ decision: "deny" });
  });

  it("ask-human handler throws → safe-by-default deny", async () => {
    const { check } = await setupCheck({ mode: "ask-human" }, ws, async () => {
      throw new Error("boom");
    });
    expect(
      JSON.parse(String(await check({}, JSON.stringify({ api: "showSaveFilePicker" })))),
    ).toEqual({ decision: "deny" });
  });

  it("per-API override wins over top-level", async () => {
    const { state, check } = await setupCheck(
      { mode: "allow", perAPI: { showSaveFilePicker: "deny" } },
      ws,
    );
    state.pushResponse("showOpenFilePicker", [{ contents: "QUE=" }]);
    expect(
      JSON.parse(String(await check({}, JSON.stringify({ api: "showSaveFilePicker" })))),
    ).toEqual({ decision: "deny" });
    const allowRaw = JSON.parse(
      String(await check({}, JSON.stringify({ api: "showOpenFilePicker" }))),
    ) as { decision: string };
    expect(allowRaw.decision).toBe("allow");
  });

  it("unknown API name → safe-by-default deny", async () => {
    const { check } = await setupCheck({ mode: "allow" }, ws);
    expect(JSON.parse(String(await check({}, JSON.stringify({ api: "showFontPicker" }))))).toEqual({
      decision: "deny",
    });
  });

  it("runtime set() takes effect on the very next check", async () => {
    const { state, check } = await setupCheck({ mode: "allow" }, ws);
    state.pushResponse("showSaveFilePicker", [{ path: "first.txt" }]);
    expect(
      (
        JSON.parse(String(await check({}, JSON.stringify({ api: "showSaveFilePicker" })))) as {
          decision: string;
        }
      ).decision,
    ).toBe("allow");
    state.set({ mode: "deny" });
    expect(
      JSON.parse(String(await check({}, JSON.stringify({ api: "showSaveFilePicker" })))),
    ).toEqual({ decision: "deny" });
  });

  it("each supported API can take each mode", async () => {
    for (const api of SUPPORTED_FS_PICKER_APIS) {
      const { check, state } = await setupCheck({ mode: "deny" }, ws);
      const t = Date.now();
      expect(JSON.parse(String(await check({}, JSON.stringify({ api })))).decision).toBe("deny");
      expect(state.since(t).at(-1)?.handledAs).toBe("denied");
      const { check: c2, state: s2 } = await setupCheck({ mode: "raise" }, ws);
      const t2 = Date.now();
      expect(JSON.parse(String(await c2({}, JSON.stringify({ api })))).decision).toBe("deny");
      expect(s2.since(t2).at(-1)?.handledAs).toBe("raised");
    }
  });

  it("workspace-escape on a queued response throws via the check handler", async () => {
    const { state, check } = await setupCheck({ mode: "allow" }, ws);
    state.pushResponse("showSaveFilePicker", [{ path: "../escape.txt" }]);
    const raw = await check({}, JSON.stringify({ api: "showSaveFilePicker" }));
    // Handler catches the error and returns deny so the page doesn't see a
    // promise rejection from the binding itself; the workspace-escape is the
    // safety contract.
    expect(JSON.parse(String(raw))).toEqual({ decision: "deny" });
  });
});

// ---- write handler — workspace-rooted disk writes ------------------------

describe("attachFsPickerPolicy — write handler routes to workspace", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "browx-fswrite-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("write → truncate-on-first-chunk → append → close persists to workspace path", async () => {
    const { state, check, write } = await setupCheck({ mode: "allow" }, ws);
    state.pushResponse("showSaveFilePicker", [{ path: "out.txt" }]);
    const raw = await check({}, JSON.stringify({ api: "showSaveFilePicker" }));
    const parsed = JSON.parse(String(raw)) as {
      decision: string;
      files: Array<{ handleId: string; name: string }>;
    };
    const handleId = parsed.files[0]!.handleId;

    // first write — truncates + writes
    await write({}, JSON.stringify({ handleId, op: "write", data: "hello " }));
    // second write — appends
    await write({}, JSON.stringify({ handleId, op: "write", data: "world" }));
    await write({}, JSON.stringify({ handleId, op: "close" }));

    const persisted = join(ws, "out.txt");
    expect(existsSync(persisted)).toBe(true);
    expect(readFileSync(persisted, "utf8")).toBe("hello world");
  });

  it("close-without-write still creates an empty file at the workspace path", async () => {
    const { state, check, write } = await setupCheck({ mode: "allow" }, ws);
    state.pushResponse("showSaveFilePicker", [{ path: "empty.bin" }]);
    const raw = await check({}, JSON.stringify({ api: "showSaveFilePicker" }));
    const parsed = JSON.parse(String(raw)) as {
      decision: string;
      files: Array<{ handleId: string }>;
    };
    const handleId = parsed.files[0]!.handleId;
    await write({}, JSON.stringify({ handleId, op: "close" }));
    const persisted = join(ws, "empty.bin");
    expect(existsSync(persisted)).toBe(true);
    expect(readFileSync(persisted).length).toBe(0);
  });

  it("binary (b64:) write decodes correctly", async () => {
    const { state, check, write } = await setupCheck({ mode: "allow" }, ws);
    state.pushResponse("showSaveFilePicker", [{ path: "bin.dat" }]);
    const raw = await check({}, JSON.stringify({ api: "showSaveFilePicker" }));
    const parsed = JSON.parse(String(raw)) as {
      decision: string;
      files: Array<{ handleId: string }>;
    };
    const handleId = parsed.files[0]!.handleId;
    // base64 "ABC" = QUJD
    await write({}, JSON.stringify({ handleId, op: "write", data: "b64:QUJD" }));
    await write({}, JSON.stringify({ handleId, op: "close" }));
    const persisted = join(ws, "bin.dat");
    expect(readFileSync(persisted, "utf8")).toBe("ABC");
  });

  it("write to an open-picker handle is a no-op (read-only virtual handle)", async () => {
    const { state, check, write } = await setupCheck({ mode: "allow" }, ws);
    state.pushResponse("showOpenFilePicker", [{ contents: "QUE=", name: "a.txt" }]);
    const raw = await check({}, JSON.stringify({ api: "showOpenFilePicker" }));
    const parsed = JSON.parse(String(raw)) as {
      decision: string;
      files: Array<{ handleId: string }>;
    };
    const handleId = parsed.files[0]!.handleId;
    await write({}, JSON.stringify({ handleId, op: "write", data: "should-be-dropped" }));
    await write({}, JSON.stringify({ handleId, op: "close" }));
    // Nothing landed on disk.
    expect(existsSync(join(ws, "a.txt"))).toBe(false);
  });

  it("ops after close are no-ops", async () => {
    const { state, check, write } = await setupCheck({ mode: "allow" }, ws);
    state.pushResponse("showSaveFilePicker", [{ path: "closeme.txt" }]);
    const raw = await check({}, JSON.stringify({ api: "showSaveFilePicker" }));
    const parsed = JSON.parse(String(raw)) as {
      decision: string;
      files: Array<{ handleId: string }>;
    };
    const handleId = parsed.files[0]!.handleId;
    await write({}, JSON.stringify({ handleId, op: "write", data: "first" }));
    await write({}, JSON.stringify({ handleId, op: "close" }));
    await write({}, JSON.stringify({ handleId, op: "write", data: "after-close" }));
    expect(readFileSync(join(ws, "closeme.txt"), "utf8")).toBe("first");
  });

  it("unknown handle id is a silent no-op", async () => {
    const { write } = await setupCheck({ mode: "allow" }, ws);
    // exposeBinding callback is sync; Playwright accepts sync or async handlers.
    expect(
      write({}, JSON.stringify({ handleId: "h-nonexistent", op: "write", data: "x" })),
    ).toBeUndefined();
  });

  it("nested dir is created on first write", async () => {
    const { state, check, write } = await setupCheck({ mode: "allow" }, ws);
    state.pushResponse("showSaveFilePicker", [{ path: "deep/nested/dir/out.txt" }]);
    const raw = await check({}, JSON.stringify({ api: "showSaveFilePicker" }));
    const parsed = JSON.parse(String(raw)) as {
      decision: string;
      files: Array<{ handleId: string }>;
    };
    const handleId = parsed.files[0]!.handleId;
    await write({}, JSON.stringify({ handleId, op: "write", data: "x" }));
    await write({}, JSON.stringify({ handleId, op: "close" }));
    expect(readFileSync(join(ws, "deep/nested/dir/out.txt"), "utf8")).toBe("x");
  });
});

// ---- attach idempotency + init-script wiring -----------------------------

describe("attachFsPickerPolicy — install plumbing", () => {
  let ws: string;
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "browx-fsinst-"));
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it("installs both bindings + the init script", async () => {
    const state = new FsPickerPolicyState();
    const bindings = new Map();
    const initScripts: string[] = [];
    const ctx = fakeContext({ bindings, initScripts });
    await attachFsPickerPolicy(ctx, state, ws, async () => null);
    expect(bindings.has("__browx_fs_picker_check")).toBe(true);
    expect(bindings.has("__browx_fs_picker_write")).toBe(true);
    expect(initScripts.length).toBe(1);
    expect(initScripts[0]).toBe(FS_PICKER_PAGE_SCRIPT);
  });

  it("idempotent on the same context — second call is a no-op", async () => {
    const state = new FsPickerPolicyState();
    const bindings = new Map();
    const initScripts: string[] = [];
    const ctx = fakeContext({ bindings, initScripts });
    await attachFsPickerPolicy(ctx, state, ws, async () => null);
    await attachFsPickerPolicy(ctx, state, ws, async () => null);
    await attachFsPickerPolicy(ctx, state, ws, async () => null);
    expect(initScripts.length).toBe(1);
  });

  it("evaluates the init script on every already-attached page", async () => {
    const state = new FsPickerPolicyState();
    const p1 = fakePage();
    const p2 = fakePage();
    const ctx = fakeContext({ pages: [p1, p2] });
    await attachFsPickerPolicy(ctx, state, ws, async () => null);
    expect(p1.evaluate).toHaveBeenCalledWith(FS_PICKER_PAGE_SCRIPT);
    expect(p2.evaluate).toHaveBeenCalledWith(FS_PICKER_PAGE_SCRIPT);
  });
});

// ---- the init script is browser-only JS ----------------------------------

describe("FS_PICKER_PAGE_SCRIPT", () => {
  it("contains the install guard so re-injection is a no-op", () => {
    expect(FS_PICKER_PAGE_SCRIPT).toMatch(/__browx_fs_picker_installed/);
  });

  it("replaces every governed entry point", () => {
    expect(FS_PICKER_PAGE_SCRIPT).toMatch(/showOpenFilePicker/);
    expect(FS_PICKER_PAGE_SCRIPT).toMatch(/showSaveFilePicker/);
    expect(FS_PICKER_PAGE_SCRIPT).toMatch(/showDirectoryPicker/);
  });

  it("consults the check binding and falls back to deny when missing", () => {
    expect(FS_PICKER_PAGE_SCRIPT).toMatch(/__browx_fs_picker_check/);
    expect(FS_PICKER_PAGE_SCRIPT).toMatch(/decision: "deny"/);
  });

  it("routes createWritable() ops through the write binding", () => {
    expect(FS_PICKER_PAGE_SCRIPT).toMatch(/__browx_fs_picker_write/);
    expect(FS_PICKER_PAGE_SCRIPT).toMatch(/createWritable/);
  });

  it("throws NotAllowedError on deny (matches the spec'd rejection name)", () => {
    expect(FS_PICKER_PAGE_SCRIPT).toMatch(/NotAllowedError/);
  });
});

const _typeOnly: FsPickerApi[] = []; // type-only smoke
void _typeOnly;
