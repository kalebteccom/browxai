import { describe, it, expect, vi } from "vitest";

// Stub only the OS-clipboard side-effect; keep ClipboardBuffer real.
vi.mock("./clipboard.js", async (orig) => {
  const actual = (await orig()) as typeof import("./clipboard.js");
  return { ...actual, osClipboardWrite: vi.fn(async () => ({ ok: true, tool: "mock" })) };
});

import { classifyChord, runShortcut } from "./shortcut.js";
import { ClipboardBuffer, osClipboardWrite } from "./clipboard.js";

describe("classifyChord", () => {
  it("maps accel+c/x/v to copy/cut/paste, case-insensitive", () => {
    expect(classifyChord("Control+C")).toBe("copy");
    expect(classifyChord("meta+c")).toBe("copy");
    expect(classifyChord("Control+X")).toBe("cut");
    expect(classifyChord("Meta+V")).toBe("paste");
  });
  it("treats non-accel and other keys as 'other'", () => {
    expect(classifyChord("Enter")).toBe("other");
    expect(classifyChord("c")).toBe("other"); // no modifier
    expect(classifyChord("Control+Shift+K")).toBe("other");
  });
});

function fakePage(selection = "copied-text") {
  const presses: string[] = [];
  const page = {
    keyboard: { press: vi.fn(async (c: string) => void presses.push(c)) },
    evaluate: vi.fn(async (script: string) => {
      if (script.includes("return { events: s.events")) {
        return {
          events: [
            { type: "keydown", key: "c", defaultPrevented: true, target: null },
            { type: "copy", key: "c", defaultPrevented: false, target: null },
          ],
          active: { tag: "div", testId: "editor" },
        };
      }
      if (script.includes("selectionStart")) return selection;
      return undefined;
    }),
  };
  return { page, presses };
}
const refs = {} as never;

describe("runShortcut — observability", () => {
  it("returns active element + events and marks handled when a copy/keydown-prevented fired", async () => {
    const { page, presses } = fakePage();
    const r = await runShortcut(
      page as never,
      refs,
      { keys: "Control+C" },
      {
        clipboardEnabled: false,
        clipboard: new ClipboardBuffer(),
      },
    );
    expect(presses).toEqual(["Control+C"]);
    expect(r.activeElement).toEqual({ tag: "div", testId: "editor" });
    expect(r.handled).toBe(true);
    expect(r.events.map((e) => e.type)).toContain("copy");
  });

  it("dispatches an ordered sequence in order", async () => {
    const { page, presses } = fakePage();
    await runShortcut(
      page as never,
      refs,
      { keys: ["Control+A", "Control+C"] },
      {
        clipboardEnabled: false,
        clipboard: new ClipboardBuffer(),
      },
    );
    expect(presses).toEqual(["Control+A", "Control+C"]);
  });

  it("clipboard disabled: keys + observability work, no buffer/OS write, note present", async () => {
    const { page } = fakePage();
    const buf = new ClipboardBuffer();
    const r = await runShortcut(
      page as never,
      refs,
      { keys: "Control+C" },
      {
        clipboardEnabled: false,
        clipboard: buf,
      },
    );
    expect(buf.get()).toBeNull();
    expect(osClipboardWrite).not.toHaveBeenCalled();
    expect(r.clipboardNote).toMatch(/clipboard capability disabled/);
  });
});

describe("runShortcut — per-session clipboard (capability on)", () => {
  it("copy captures the selection into the per-session buffer + transactional OS write", async () => {
    vi.mocked(osClipboardWrite).mockClear();
    const { page } = fakePage("the selected text");
    const buf = new ClipboardBuffer();
    const r = await runShortcut(
      page as never,
      refs,
      { keys: "Control+C" },
      {
        clipboardEnabled: true,
        clipboard: buf,
      },
    );
    expect(buf.get()).toMatchObject({ text: "the selected text", op: "copy" });
    expect(osClipboardWrite).toHaveBeenCalledWith("the selected text");
    expect(r.clipboard).toMatchObject({ op: "copy", capturedChars: 17, osSync: true });
  });

  it("paste writes THIS session's buffer to the OS clipboard just before the keystroke", async () => {
    vi.mocked(osClipboardWrite).mockClear();
    const { page, presses } = fakePage();
    const buf = new ClipboardBuffer();
    buf.set("session-A-content", "copy");
    const r = await runShortcut(
      page as never,
      refs,
      { keys: "Control+V" },
      {
        clipboardEnabled: true,
        clipboard: buf,
      },
    );
    expect(osClipboardWrite).toHaveBeenCalledWith("session-A-content");
    expect(presses).toEqual(["Control+V"]);
    expect(r.clipboard).toMatchObject({ op: "paste", fromSessionBuffer: true, chars: 17 });
  });

  it("paste with an empty session buffer does not touch the OS clipboard", async () => {
    vi.mocked(osClipboardWrite).mockClear();
    const { page } = fakePage();
    const r = await runShortcut(
      page as never,
      refs,
      { keys: "Control+V" },
      {
        clipboardEnabled: true,
        clipboard: new ClipboardBuffer(),
      },
    );
    expect(osClipboardWrite).not.toHaveBeenCalled();
    expect(r.clipboard).toBeUndefined();
  });
});
