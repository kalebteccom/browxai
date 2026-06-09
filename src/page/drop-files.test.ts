// Unit tests for drop_files. Covers both file modes (`path` + `contents`),
// workspace escape rejection, target resolution (ref / selector / coords),
// multiple files in one drop, and a focused jsdom-style page-side keystone
// that drives `dropFilesPageScript` directly so we prove the
// DataTransfer + dragenter/dragover/drop sequence lands without standing
// up a real Chromium.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dropFiles, dropFilesPageScript, type DropPayload } from "./drop-files.js";

const WS = join(tmpdir(), "browx-drop-files-test");

beforeEach(() => {
  if (existsSync(WS)) rmSync(WS, { recursive: true, force: true });
  mkdirSync(WS, { recursive: true });
});
afterEach(() => {
  if (existsSync(WS)) rmSync(WS, { recursive: true, force: true });
});

interface LocatorCallSpy {
  evaluate: ReturnType<typeof vi.fn>;
  boundingBox: ReturnType<typeof vi.fn>;
}

interface RefRegistryShape {
  locatorOf: (ref: string) => unknown;
  frameOf: (ref: string) => unknown;
}

function fakePage(
  opts: {
    withRef?: boolean;
    boundingBox?: { x: number; y: number; width: number; height: number } | null;
  } = {},
) {
  const hasBoxOverride = "boundingBox" in opts;
  const boundingBox = vi.fn(async () =>
    hasBoxOverride ? opts.boundingBox : { x: 100, y: 50, width: 200, height: 80 },
  );
  const locEvaluate = vi.fn(async (_fn: unknown, _arg: unknown) => ({
    eventsFired: ["dragenter", "dragover", "drop"],
    dropDispatched: true,
    hitTag: "div",
  }));
  const pageEvaluate = vi.fn(async (_fn: unknown, _arg: unknown) => ({
    eventsFired: ["dragenter", "dragover", "drop"],
    dropDispatched: true,
    hitTag: "div",
  }));
  const loc: LocatorCallSpy = { evaluate: locEvaluate, boundingBox };
  const page = {
    locator: () => ({ first: () => loc }),
    getByRole: () => ({ first: () => loc }),
    evaluate: pageEvaluate,
  };
  const refs: RefRegistryShape = opts.withRef
    ? {
        locatorOf: () => ({ role: "button", source: "a11y", cssPath: "div[data-testid='zone']" }),
        frameOf: () => undefined,
      }
    : { locatorOf: () => undefined, frameOf: () => undefined };
  return { page, refs, locEvaluate, pageEvaluate, boundingBox };
}

describe("drop_files — Node-side argument handling", () => {
  it("rejects empty files array", async () => {
    const { page, refs } = fakePage();
    await expect(
      dropFiles(page as never, refs as never, WS, { target: { selector: "#zone" }, files: [] }),
    ).rejects.toThrow(/non-empty array/);
  });

  it("rejects passing both `path` and `contents` on one file entry", async () => {
    const { page, refs } = fakePage();
    await expect(
      dropFiles(page as never, refs as never, WS, {
        target: { selector: "#zone" },
        files: [{ path: "x", contents: "AA==", name: "x" }],
      }),
    ).rejects.toThrow(/exactly one of `path` or `contents`/);
  });

  it("rejects neither `path` nor `contents` on a file entry", async () => {
    const { page, refs } = fakePage();
    await expect(
      dropFiles(page as never, refs as never, WS, {
        target: { selector: "#zone" },
        files: [{ name: "x" } as never],
      }),
    ).rejects.toThrow(/requires `path` or `contents`/);
  });

  it("rejects contents-mode without a `name`", async () => {
    const { page, refs } = fakePage();
    await expect(
      dropFiles(page as never, refs as never, WS, {
        target: { selector: "#zone" },
        files: [{ contents: "AA==" } as never],
      }),
    ).rejects.toThrow(/`name` is required in contents-mode/);
  });

  it("rejects a path that escapes the workspace (relative)", async () => {
    const { page, refs } = fakePage();
    await expect(
      dropFiles(page as never, refs as never, WS, {
        target: { selector: "#zone" },
        files: [{ path: "../../etc/passwd" }],
      }),
    ).rejects.toThrow(/inside \$BROWX_WORKSPACE/);
  });

  it("rejects a path that escapes the workspace (absolute)", async () => {
    const { page, refs } = fakePage();
    await expect(
      dropFiles(page as never, refs as never, WS, {
        target: { selector: "#zone" },
        files: [{ path: "/etc/hosts" }],
      }),
    ).rejects.toThrow(/inside \$BROWX_WORKSPACE/);
  });

  it("surfaces a clear error when a workspace path doesn't exist", async () => {
    const { page, refs } = fakePage();
    await expect(
      dropFiles(page as never, refs as never, WS, {
        target: { selector: "#zone" },
        files: [{ path: "missing.bin" }],
      }),
    ).rejects.toThrow(/files\[0\]\.path/);
  });

  it("rejects when the target element has no rendered box (ref/selector mode)", async () => {
    const { page, refs } = fakePage({ boundingBox: null });
    await expect(
      dropFiles(page as never, refs as never, WS, {
        target: { selector: "#zone" },
        files: [{ contents: "AAAA", name: "a.txt" }],
      }),
    ).rejects.toThrow(/no rendered box/);
  });
});

describe("drop_files — happy paths dispatch the expected payload", () => {
  it("contents-mode → single file → Locator.evaluate with the expected payload", async () => {
    const { page, refs, locEvaluate, boundingBox } = fakePage();
    const r = await dropFiles(page as never, refs as never, WS, {
      target: { selector: "#zone" },
      files: [
        {
          contents: Buffer.from("hello").toString("base64"),
          name: "hi.txt",
          mimeType: "text/plain",
        },
      ],
    });

    expect(r.ok).toBe(true);
    expect(r.target).toBe("selector #zone");
    expect(r.fileCount).toBe(1);
    expect(r.totalBytes).toBe(5);
    expect(r.files[0]).toEqual({
      name: "hi.txt",
      mode: "contents",
      bytes: 5,
      mimeType: "text/plain",
    });
    expect(r.eventsFired).toEqual(["dragenter", "dragover", "drop"]);
    expect(r.dropDispatched).toBe(true);

    expect(boundingBox).toHaveBeenCalled();
    expect(locEvaluate).toHaveBeenCalledOnce();
    const [, arg] = locEvaluate.mock.calls[0]!;
    const a = arg as { payload: DropPayload; src: string };
    expect(a.payload.byCoords).toBe(false);
    expect(a.payload.clientX).toBe(200); // 100 + 200/2
    expect(a.payload.clientY).toBe(90); // 50 + 80/2
    expect(a.payload.files.length).toBe(1);
    expect(a.payload.files[0]!.base64).toBe(Buffer.from("hello").toString("base64"));
    expect(a.src).toContain("dropFilesInPage");
  });

  it("path-mode → reads bytes from $BROWX_WORKSPACE, defaults name to basename", async () => {
    writeFileSync(join(WS, "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));
    const { page, refs, locEvaluate } = fakePage();
    const r = await dropFiles(page as never, refs as never, WS, {
      target: { selector: "#zone" },
      files: [{ path: "doc.pdf", mimeType: "application/pdf" }],
    });
    expect(r.files[0]).toEqual({
      name: "doc.pdf",
      mode: "path",
      bytes: 4,
      mimeType: "application/pdf",
    });
    const [, arg] = locEvaluate.mock.calls[0]!;
    const a = arg as { payload: DropPayload };
    // base64("\x25\x50\x44\x46") = "JVBERg==" (PDF magic)
    expect(a.payload.files[0]!.base64).toBe("JVBERg==");
  });

  it("ref-mode → routes through the registry's locator", async () => {
    writeFileSync(join(WS, "a.txt"), "abc");
    const { page, refs, locEvaluate } = fakePage({ withRef: true });
    const r = await dropFiles(page as never, refs as never, WS, {
      target: { ref: "e1" },
      files: [{ path: "a.txt" }],
    });
    expect(r.target).toBe("ref e1");
    expect(locEvaluate).toHaveBeenCalledOnce();
  });

  it("coords-mode → page.evaluate with byCoords:true and the literal coords", async () => {
    const { page, refs, locEvaluate, pageEvaluate } = fakePage();
    const r = await dropFiles(page as never, refs as never, WS, {
      target: { coords: { x: 42, y: 99 } },
      files: [{ contents: "AAAA", name: "x.bin" }],
    });
    expect(r.target).toBe("coords 42,99");
    expect(locEvaluate).not.toHaveBeenCalled();
    expect(pageEvaluate).toHaveBeenCalledOnce();
    const [, arg] = pageEvaluate.mock.calls[0]!;
    const a = arg as { payload: DropPayload };
    expect(a.payload.byCoords).toBe(true);
    expect(a.payload.clientX).toBe(42);
    expect(a.payload.clientY).toBe(99);
  });

  it("multi-file: many entries are dispatched in one drop with totalBytes summed", async () => {
    writeFileSync(join(WS, "a.txt"), "aaaa");
    const { page, refs, locEvaluate } = fakePage();
    const r = await dropFiles(page as never, refs as never, WS, {
      target: { selector: "#zone" },
      files: [
        { path: "a.txt" },
        { contents: Buffer.from("xyz").toString("base64"), name: "b.bin" },
      ],
    });
    expect(r.fileCount).toBe(2);
    expect(r.totalBytes).toBe(7); // 4 + 3
    expect(r.files.map((f) => f.name)).toEqual(["a.txt", "b.bin"]);
    expect(r.files.map((f) => f.mode)).toEqual(["path", "contents"]);
    expect(locEvaluate).toHaveBeenCalledOnce(); // ONE drop, not one per file
    const [, arg] = locEvaluate.mock.calls[0]!;
    const a = arg as { payload: DropPayload };
    expect(a.payload.files.length).toBe(2);
  });
});

// ---- Direct page-side script test (jsdom-style fake DOM) ----------------
//
// Drives `dropFilesPageScript` directly so we cover the DataTransfer +
// dragenter/dragover/drop synthesis without standing up a real Chromium.
// The full Chromium round-trip lives in the keystone.

describe("dropFilesPageScript — DataTransfer + event synthesis", () => {
  interface CapturedEvent {
    type: string;
    clientX: number;
    clientY: number;
    bubbles: boolean;
    cancelable: boolean;
    fileCount: number;
    fileNames: string[];
  }

  function fakeWindow(): {
    window: Record<string, unknown>;
    document: Record<string, unknown>;
    capturedTarget: { events: CapturedEvent[] };
  } {
    const events: CapturedEvent[] = [];
    const target = {
      tagName: "DIV",

      dispatchEvent(ev: any) {
        events.push({
          type: ev.type,
          clientX: ev.clientX,
          clientY: ev.clientY,
          bubbles: ev.bubbles,
          cancelable: ev.cancelable,
          fileCount: ev.dataTransfer?.files?.length ?? 0,
          fileNames: ev.dataTransfer?.files
            ? Array.from(ev.dataTransfer.files as ArrayLike<{ name: string }>).map((f) => f.name)
            : [],
        });
        return true;
      },
    };
    // Minimal File / DataTransfer / DragEvent shims that mirror Chromium's
    // public surface enough for the script to populate them.
    class FakeFile {
      name: string;
      type: string;
      bytes: Uint8Array;
      constructor(parts: Uint8Array[], name: string, opts?: { type?: string }) {
        this.name = name;
        this.type = opts?.type ?? "";
        this.bytes = parts[0] ?? new Uint8Array(0);
      }
    }
    class FakeDataTransfer {
      files: FakeFile[] = [];
      items = {
        add: (file: FakeFile) => {
          this.files.push(file);
        },
      };
      types: string[] = [];
    }
    class FakeDragEvent {
      type: string;
      bubbles: boolean;
      cancelable: boolean;
      composed: boolean;
      clientX: number;
      clientY: number;
      dataTransfer: FakeDataTransfer | null;
      constructor(type: string, init: Record<string, unknown>) {
        this.type = type;
        this.bubbles = (init.bubbles as boolean) ?? false;
        this.cancelable = (init.cancelable as boolean) ?? false;
        this.composed = (init.composed as boolean) ?? false;
        this.clientX = (init.clientX as number) ?? 0;
        this.clientY = (init.clientY as number) ?? 0;
        this.dataTransfer = (init.dataTransfer as FakeDataTransfer) ?? null;
      }
    }
    const document = {
      elementFromPoint: (_x: number, _y: number): any => target,
    };
    const window = {
      atob: (b64: string) => Buffer.from(b64, "base64").toString("binary"),
      Uint8Array,
      File: FakeFile,
      DataTransfer: FakeDataTransfer,
      DragEvent: FakeDragEvent,
      Event: class FakeEvent {
        type: string;
        bubbles: boolean;
        cancelable: boolean;
        constructor(type: string, init: Record<string, unknown> = {}) {
          this.type = type;
          this.bubbles = (init.bubbles as boolean) ?? false;
          this.cancelable = (init.cancelable as boolean) ?? false;
        }
      },
      document,
    };
    return { window, document, capturedTarget: { events } };
  }

  it("fires dragenter → dragover → drop with the populated DataTransfer (ref/selector mode)", () => {
    const { window, capturedTarget } = fakeWindow();
    const savedGlobals = {
      window: (globalThis as Record<string, unknown>).window,
      document: (globalThis as Record<string, unknown>).document,
    };
    try {
      (globalThis as Record<string, unknown>).window = window;
      (globalThis as Record<string, unknown>).document = window.document;
      // `el` is the target — bypass elementFromPoint.
      const el = (window.document as Record<string, unknown>).elementFromPoint as (
        x: number,
        y: number,
      ) => unknown;
      const target = el(0, 0);
      const result = dropFilesPageScript({
        el: target,
        payload: {
          clientX: 25,
          clientY: 40,
          byCoords: false,
          files: [
            {
              base64: Buffer.from("hi").toString("base64"),
              name: "hi.txt",
              mimeType: "text/plain",
            },
            {
              base64: Buffer.from("two").toString("base64"),
              name: "two.bin",
              mimeType: "application/octet-stream",
            },
          ],
        },
      });
      expect(result.eventsFired).toEqual(["dragenter", "dragover", "drop"]);
      expect(result.dropDispatched).toBe(true);
      expect(result.hitTag).toBe("div");
      expect(capturedTarget.events.map((e) => e.type)).toEqual(["dragenter", "dragover", "drop"]);
      // Each event carries the populated DataTransfer with BOTH files.
      for (const e of capturedTarget.events) {
        expect(e.fileCount).toBe(2);
        expect(e.fileNames).toEqual(["hi.txt", "two.bin"]);
        expect(e.clientX).toBe(25);
        expect(e.clientY).toBe(40);
        expect(e.bubbles).toBe(true);
        expect(e.cancelable).toBe(true);
      }
    } finally {
      (globalThis as Record<string, unknown>).window = savedGlobals.window;
      (globalThis as Record<string, unknown>).document = savedGlobals.document;
    }
  });

  it("byCoords:true → re-resolves target via elementFromPoint", () => {
    const { window, capturedTarget } = fakeWindow();
    const savedGlobals = {
      window: (globalThis as Record<string, unknown>).window,
      document: (globalThis as Record<string, unknown>).document,
    };
    try {
      (globalThis as Record<string, unknown>).window = window;
      (globalThis as Record<string, unknown>).document = window.document;
      const result = dropFilesPageScript({
        el: null,
        payload: {
          clientX: 10,
          clientY: 20,
          byCoords: true,
          files: [{ base64: "AAAA", name: "a.bin", mimeType: "application/octet-stream" }],
        },
      });
      expect(result.eventsFired).toEqual(["dragenter", "dragover", "drop"]);
      expect(capturedTarget.events.length).toBe(3);
    } finally {
      (globalThis as Record<string, unknown>).window = savedGlobals.window;
      (globalThis as Record<string, unknown>).document = savedGlobals.document;
    }
  });
});
