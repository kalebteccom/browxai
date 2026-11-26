import { describe, it, expect, vi } from "vitest";
import { pointProbe } from "./point_probe.js";
import { textCutFor } from "../util/frame-cap.js";
import { SecretRegistry } from "../util/secrets.js";

const cannedStack = {
  stack: [
    {
      tag: "div",
      testId: "audio-seg",
      pointerEvents: "auto",
      visibility: "visible",
      display: "block",
      zIndex: "5",
      cursor: "pointer",
      bbox: { x: 10, y: 20, width: 100, height: 30 },
    },
    {
      tag: "canvas",
      pointerEvents: "none",
      visibility: "visible",
      display: "block",
      zIndex: "0",
      cursor: "default",
      bbox: { x: 0, y: 0, width: 800, height: 400 },
    },
  ],
  scrollContainer: {
    tag: "div",
    classes: "timeline-scroll",
    pointerEvents: "auto",
    visibility: "visible",
    display: "block",
    zIndex: "auto",
    cursor: "default",
    bbox: null,
  },
  clickableAncestor: {
    tag: "button",
    role: "button",
    name: "Select clip",
    pointerEvents: "auto",
    visibility: "visible",
    display: "inline",
    zIndex: "auto",
    cursor: "pointer",
    bbox: null,
  },
};

function fakePage(withShot = true) {
  return {
    evaluate: vi.fn(async () => cannedStack),
    screenshot: withShot
      ? vi.fn(async () => Buffer.from("PNGDATA"))
      : vi.fn(async () => {
          throw new Error("no screenshot");
        }),
  };
}

describe("pointProbe", () => {
  it("returns the elementsFromPoint stack + scroll/clickable ancestors", async () => {
    const page = fakePage();
    const r = await pointProbe(page as never, { x: 120, y: 240 });
    expect(r.ok).toBe(true);
    expect(r.point).toEqual({ x: 120, y: 240 });
    expect(r.stack.map((s) => s.tag)).toEqual(["div", "canvas"]);
    expect(r.stack[0]!.testId).toBe("audio-seg");
    expect(r.scrollContainer?.classes).toBe("timeline-scroll");
    expect(r.clickableAncestor?.name).toBe("Select clip");
    expect(r.cropBase64).toBeUndefined(); // off by default
  });

  it("includes a base64 crop only when crop:true", async () => {
    const page = fakePage();
    const r = await pointProbe(page as never, { x: 5, y: 5 }, { crop: true });
    expect(r.cropBase64).toBe(Buffer.from("PNGDATA").toString("base64"));
    expect(page.screenshot).toHaveBeenCalledTimes(1);
  });

  it("crop failure is best-effort — probe still returns", async () => {
    const page = fakePage(false);
    const r = await pointProbe(page as never, { x: 5, y: 5 }, { crop: true });
    expect(r.ok).toBe(true);
    expect(r.cropBase64).toBeUndefined();
    expect(r.stack).toHaveLength(2);
  });
});

describe("pointProbe text over the cap", () => {
  const VALUE = "tok_" + "0123456789".repeat(10); // 104 characters
  const element = (name: string, nameFromText: boolean) => ({
    tag: "span",
    name,
    nameFromText,
    classes: "c".repeat(300).slice(0, 121),
    pointerEvents: "auto",
    visibility: "visible",
    display: "inline",
    zIndex: "auto",
    cursor: "auto",
    bbox: null,
  });

  it("masks a text-content name read past the 40-character cap", async () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: VALUE });
    const cut = textCutFor(secrets);
    let script = "";
    const page = {
      evaluate: vi.fn(async (s: string) => {
        script = s;
        const read = Number(/NAME_READ = (\d+)/.exec(s)![1]);
        return {
          stack: [element((VALUE + " label").slice(0, read), true)],
          scrollContainer: null,
          clickableAncestor: element("a".repeat(60), false),
        };
      }),
    };
    const r = await pointProbe(page as never, { x: 1, y: 1 }, { cut });
    expect(script).toContain(`NAME_READ = ${41 + cut.slack}`);
    expect(r.stack[0]!.name).toBe("<TOKEN> label");
    expect(r.stack[0]).not.toHaveProperty("nameFromText");
    // An aria-label name was read whole; it is left as it is.
    expect(r.clickableAncestor!.name).toBe("a".repeat(60));
    expect(r.stack[0]!.classes).toBe("c".repeat(120));
  });

  it("cuts a text-content name to 40 characters with no secret registered", async () => {
    const page = {
      evaluate: vi.fn(async () => ({
        stack: [element("n".repeat(41), true)],
        scrollContainer: null,
        clickableAncestor: null,
      })),
    };
    const r = await pointProbe(page as never, { x: 1, y: 1 });
    expect(r.stack[0]!.name).toBe("n".repeat(40));
  });
});
