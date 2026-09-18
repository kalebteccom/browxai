// The five native substrates, driven against a faked device.
//
// The fake is the DUMP, not the substrate. `NativeScreen`, the walker, the query
// matcher and every substrate run for real; only `dump()` and the input verbs are
// substituted. So an assertion here is an assertion about shipped code.

import { describe, it, expect } from "vitest";
import { RefRegistry } from "./refs.js";
import { ACTION_MAX_AGE_MS, NativeScreen } from "./native-screen.js";
import { NativeElementSubstrate } from "./element-substrate-android-app.js";
import { NativeSnapshotSubstrate } from "./snapshot-substrate-android-app.js";
import { NativeTargetSubstrate, nativeTargetUrl } from "./target-substrate-android-app.js";
import { NativeActionSubstrate, type NativeInputIO } from "./action-substrate-android-app.js";
import { NativeCaptureSubstrate } from "./capture-substrate-android-app.js";
import { walk } from "./a11y-types.js";
import { cropPng, pngSize } from "./native-png-crop.js";
import { deflateSync, crc32 } from "node:zlib";

// ─── fixtures ─────────────────────────────────────────────────────────────────

function dumpOf(inner: string): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${inner}</hierarchy>`;
}

function nodeXml(attrs: Record<string, string>, children = ""): string {
  const base: Record<string, string> = {
    index: "0",
    text: "",
    "resource-id": "",
    class: "android.view.View",
    package: "com.acme.app",
    "content-desc": "",
    checkable: "false",
    checked: "false",
    clickable: "false",
    enabled: "true",
    focusable: "false",
    focused: "false",
    scrollable: "false",
    "long-clickable": "false",
    password: "false",
    selected: "false",
    bounds: "[0,0][100,50]",
    ...attrs,
  };
  const s = Object.entries(base)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return children ? `<node ${s}>${children}</node>` : `<node ${s} />`;
}

const SUBMIT = nodeXml({
  class: "android.widget.Button",
  "resource-id": "com.acme.app:id/submit",
  "content-desc": "Place order",
  clickable: "true",
  bounds: "[100,200][300,280]",
});

const SCREEN = dumpOf(nodeXml({ class: "android.widget.FrameLayout" }, SUBMIT));

/** A screen source over a list of successive dumps: each `read` that misses the
 *  TTL takes the next one, so a test can make the screen change under an action. */
function screenOver(...dumps: string[]): { screen: NativeScreen; dumps: number } {
  let i = 0;
  const state = { dumps: 0 };
  const screen = new NativeScreen({
    dump: async () => {
      state.dumps += 1;
      const d = dumps[Math.min(i, dumps.length - 1)]!;
      if (i < dumps.length - 1) i += 1;
      return d;
    },
  });
  return {
    screen,
    get dumps(): number {
      return state.dumps;
    },
  };
}

function recordingInput(): NativeInputIO & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    tap: async (x, y) => void calls.push(`tap ${x} ${y}`),
    swipe: async (f, t, ms) => void calls.push(`swipe ${f.x},${f.y} -> ${t.x},${t.y} ${ms}`),
    motionEvent: async (p, x, y) => void calls.push(`motion ${p} ${x} ${y}`),
    typeText: async (v) => void calls.push(`text ${v}`),
    keyEvent: async (k) => void calls.push(`key ${k}`),
    openDeepLink: async (u) => void calls.push(`deeplink ${u}`),
    screenSize: async () => ({ width: 1080, height: 2220 }),
  };
}

// ─── the re-resolution contract ───────────────────────────────────────────────

describe("the re-resolution contract (RFC 0008 §3)", () => {
  it("ACTION_MAX_AGE_MS is zero, so an action never reads a cached screen", () => {
    // The performance temptation here points straight at the defect this engine
    // exists to avoid. Pinned as a constant so raising it is a deliberate,
    // visible change.
    expect(ACTION_MAX_AGE_MS).toBe(0);
  });

  it("a tap lands on the element's CURRENT box, not the one the ref was minted at", async () => {
    // THE BUG THE OWNER'S TRIAL FOUND. The competing tool replayed cached
    // coordinates, so a stale ref tapped whatever now occupied the old
    // rectangle, and reported success.
    const moved = dumpOf(
      nodeXml(
        { class: "android.widget.FrameLayout" },
        nodeXml({
          class: "android.widget.Button",
          "resource-id": "com.acme.app:id/submit",
          "content-desc": "Place order",
          clickable: "true",
          bounds: "[500,900][700,980]",
        }),
      ),
    );
    const { screen } = screenOver(SCREEN, moved);
    const refs = new RefRegistry();
    const snapshot = new NativeSnapshotSubstrate(screen);
    const composed = await snapshot.compose(refs, []);
    const ref = [...walk(composed.tree!)].find((w) => w.node.testId === "submit")!.node.ref;

    const io = recordingInput();
    const elements = new NativeElementSubstrate(screen, refs);
    await new NativeActionSubstrate(io, elements).click({ target: { ref } });

    // The button now sits at [500,900][700,980]; its centre is 600,940.
    expect(io.calls[0]).toBe("tap 600 940");
  });

  it("refuses a ref the screen no longer holds, naming it", async () => {
    const empty = dumpOf(nodeXml({ class: "android.widget.FrameLayout" }));
    const { screen } = screenOver(SCREEN, empty);
    const refs = new RefRegistry();
    const composed = await new NativeSnapshotSubstrate(screen).compose(refs, []);
    const ref = [...walk(composed.tree!)].find((w) => w.node.testId === "submit")!.node.ref;

    const io = recordingInput();
    const elements = new NativeElementSubstrate(screen, refs);
    const result = await new NativeActionSubstrate(io, elements).click({ target: { ref } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(ref);
    expect(io.calls, "nothing may be tapped when the ref matched nothing").toEqual([]);
  });
});

// ─── ambiguity ────────────────────────────────────────────────────────────────

describe("ambiguity refuses on native (RFC 0009 amendment 2026-09-16)", () => {
  const twins = dumpOf(
    nodeXml(
      { class: "android.widget.FrameLayout" },
      nodeXml({
        class: "android.widget.Button",
        "resource-id": "com.acme.app:id/row",
        "content-desc": "Delete",
        clickable: "true",
        bounds: "[0,0][100,50]",
      }) +
        nodeXml({
          class: "android.widget.Button",
          "resource-id": "com.acme.app:id/row",
          "content-desc": "Delete",
          clickable: "true",
          bounds: "[0,60][100,110]",
        }),
    ),
  );

  it("a selector matching two elements taps nothing and says how many it matched", async () => {
    // Web preserves a silent first-match pick for compatibility. A native engine
    // has no legacy, and acting on the first of two is exactly the mistap that
    // got the competing tool rejected.
    const { screen } = screenOver(twins);
    const io = recordingInput();
    const elements = new NativeElementSubstrate(screen, new RefRegistry());
    const result = await new NativeActionSubstrate(io, elements).click({
      target: { selector: "~row" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/matched 2 elements/);
    expect(io.calls).toEqual([]);
  });

  it("verify_count still answers the count, because the count IS the question", async () => {
    const { screen } = screenOver(twins);
    const elements = new NativeElementSubstrate(screen, new RefRegistry());
    await expect(elements.count({ kind: "selector", selector: "~row" })).resolves.toEqual({
      kind: "count",
      n: 2,
    });
  });

  it("a probe leaves the per-element fields absent and records why", async () => {
    const { screen } = screenOver(twins);
    const elements = new NativeElementSubstrate(screen, new RefRegistry());
    const resolved = await elements.resolve({ kind: "selector", selector: "~row" });
    expect(resolved.kind).toBe("element");
    if (resolved.kind !== "element") return;
    const reading = await elements.probe(resolved.el, { matches: true, visible: true });
    expect(reading.kind).toBe("reading");
    if (reading.kind !== "reading") return;
    expect(reading.matches).toBe(2);
    // Answering `visible` from an arbitrary member of an ambiguous set is the
    // mistap in report form.
    expect(reading.visible).toBeUndefined();
    expect(reading.failures?.element).toMatch(/matched 2 elements/);
  });
});

// ─── the element substrate's reads ────────────────────────────────────────────

describe("NativeElementSubstrate", () => {
  it("resolves without touching the device, so a handle costs no dump", async () => {
    const source = screenOver(SCREEN);
    const refs = new RefRegistry();
    await new NativeSnapshotSubstrate(source.screen).compose(refs, []);
    const before = source.dumps;
    await new NativeElementSubstrate(source.screen, refs).resolve({
      kind: "selector",
      selector: "~submit",
    });
    expect(source.dumps).toBe(before);
  });

  it("refuses a ref that was never minted, distinctly from one that went stale", async () => {
    const { screen } = screenOver(SCREEN);
    const elements = new NativeElementSubstrate(screen, new RefRegistry());
    const r = await elements.resolve({ kind: "ref", ref: "e99" });
    expect(r.kind).toBe("refusal");
    if (r.kind !== "refusal") return;
    // W3C WebDriver's split, carried because an agent does different things in
    // each case: re-find, or re-snapshot.
    expect(r.reason).toBe("no-such-element");
  });

  it("reads bounds, visibility, text and the native attributes in one dump", async () => {
    const { screen } = screenOver(SCREEN);
    const elements = new NativeElementSubstrate(screen, new RefRegistry());
    const resolved = await elements.resolve({ kind: "selector", selector: "~submit" });
    if (resolved.kind !== "element") throw new Error("expected a resolution");
    const [bounds, reading] = await Promise.all([
      elements.bounds(resolved.el),
      elements.probe(resolved.el, { visible: true, enabled: true, attribute: "testID" }),
    ]);
    expect(bounds).toEqual({ kind: "bounds", rect: { x: 100, y: 200, width: 200, height: 80 } });
    if (reading.kind !== "reading") throw new Error("expected a reading");
    expect(reading.visible).toBe(true);
    expect(reading.enabled).toBe(true);
    expect(reading.attribute).toBe("submit");
  });

  it("answers null for an attribute a native view does not have", async () => {
    // `href` has a real answer of "no" on a view with a fixed attribute set.
    const { screen } = screenOver(SCREEN);
    const elements = new NativeElementSubstrate(screen, new RefRegistry());
    const resolved = await elements.resolve({ kind: "selector", selector: "~submit" });
    if (resolved.kind !== "element") throw new Error("expected a resolution");
    const reading = await elements.probe(resolved.el, { attribute: "href" });
    if (reading.kind !== "reading") throw new Error("expected a reading");
    expect(reading.attribute).toBeNull();
  });
});

// ─── snapshot ─────────────────────────────────────────────────────────────────

describe("NativeSnapshotSubstrate", () => {
  it("emits the composed snapshot shape the read core already consumes", async () => {
    const { screen } = screenOver(SCREEN);
    const composed = await new NativeSnapshotSubstrate(screen).compose(new RefRegistry(), []);
    expect(composed.tree).not.toBeNull();
    expect(composed.stats.tier).toBe("a11y");
    // No DOM-walk tier on this engine, so the three DOM counters are zero and
    // the tier is never `mixed`.
    expect(composed.stats.domWalkEntries).toBe(0);
  });

  it("warns when an app is thin on testIDs, which is the fixable list RFC 0008 asks for", async () => {
    const unlabelled = dumpOf(
      nodeXml(
        { class: "android.widget.FrameLayout" },
        Array.from({ length: 6 }, (_, i) =>
          nodeXml({
            class: "android.widget.Button",
            "content-desc": `Button ${i}`,
            clickable: "true",
          }),
        ).join(""),
      ),
    );
    const { screen } = screenOver(unlabelled);
    const composed = await new NativeSnapshotSubstrate(screen).compose(new RefRegistry(), []);
    expect(composed.warnings.join(" ")).toMatch(/carry no testID/);
  });

  it("says the screen carried nothing addressable", async () => {
    const { screen } = screenOver(dumpOf(nodeXml({ class: "android.widget.FrameLayout" })));
    const composed = await new NativeSnapshotSubstrate(screen).compose(new RefRegistry(), []);
    expect(composed.stats.tier).toBe("empty");
    expect(composed.warnings.join(" ")).toMatch(/no addressable element/);
  });

  it("a11yTree keeps the layout scaffolding the action delta needs", async () => {
    const { screen } = screenOver(SCREEN);
    const substrate = new NativeSnapshotSubstrate(screen);
    const refs = new RefRegistry();
    const pruned = await substrate.compose(refs, []);
    const full = await substrate.a11yTree(refs, []);
    expect([...walk(full!)].length).toBeGreaterThanOrEqual([...walk(pruned.tree!)].length);
  });
});

// ─── target ───────────────────────────────────────────────────────────────────

describe("NativeTargetSubstrate", () => {
  it("formats the native target url the secret scope is checked against", () => {
    // RFC 0008 §6: a secret registered with `scope: "com.acme.app"` must refuse
    // to materialise into another app's session, through the SAME
    // case-insensitive substring containment the URL path uses.
    expect(
      nativeTargetUrl({ packageName: "com.acme.app", activity: "com.acme.app.CheckoutActivity" }),
    ).toBe("app://com.acme.app/CheckoutActivity");
  });

  it("names the unknown case", () => {
    expect(nativeTargetUrl(null)).toBe("app://unknown");
  });

  it("reports the screen's activity as the title", async () => {
    const target = new NativeTargetSubstrate({
      foreground: async () => ({
        packageName: "com.acme.app",
        activity: "com.acme.app.MainActivity",
      }),
    });
    await expect(target.title()).resolves.toBe("MainActivity");
    await expect(target.url()).resolves.toBe("app://com.acme.app/MainActivity");
  });
});

// ─── actions ──────────────────────────────────────────────────────────────────

describe("NativeActionSubstrate", () => {
  const elementsOver = (
    dump: string,
  ): { io: ReturnType<typeof recordingInput>; sub: NativeActionSubstrate } => {
    const { screen } = screenOver(dump);
    const io = recordingInput();
    return {
      io,
      sub: new NativeActionSubstrate(io, new NativeElementSubstrate(screen, new RefRegistry())),
    };
  };

  it("navigate opens a deep link, because a native screen has no address bar", async () => {
    const { io, sub } = elementsOver(SCREEN);
    const r = await sub.navigate({ url: "myapp://checkout/42" });
    expect(r.ok).toBe(true);
    expect(io.calls).toEqual(["deeplink myapp://checkout/42"]);
  });

  it("fill taps the field first, because `input text` goes to whatever has focus", async () => {
    const { io, sub } = elementsOver(SCREEN);
    await sub.fill({ target: { selector: "~submit" }, value: "hello" });
    expect(io.calls).toEqual(["tap 200 240", "text hello"]);
  });

  it("fill warns that registered secrets do not materialise on this engine", async () => {
    // An agent that registered a secret has no other way to learn it was typed
    // literally.
    const { sub } = elementsOver(SCREEN);
    const r = await sub.fill({ target: { selector: "~submit" }, value: "<PASSWORD>" });
    expect(r.warnings.join(" ")).toMatch(/Registered secrets do NOT materialise/);
  });

  it("press maps a named key onto its Android keycode", async () => {
    const { io, sub } = elementsOver(SCREEN);
    await sub.press({ key: "back" });
    expect(io.calls).toEqual(["key KEYCODE_BACK"]);
  });

  it("press types a single printable character, matching the web engines", async () => {
    const { io, sub } = elementsOver(SCREEN);
    await sub.press({ key: "a" });
    expect(io.calls).toEqual(["text a"]);
  });

  it("press refuses an unknown multi-character key by name", async () => {
    const { sub } = elementsOver(SCREEN);
    const r = await sub.press({ key: "Meta+Shift+K" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/is not an Android key/);
  });

  it("scroll drags the content the OPPOSITE way to the requested direction", async () => {
    // Scrolling a list DOWN means dragging the content UP. Getting this
    // backwards is the classic native-automation bug.
    const { io, sub } = elementsOver(SCREEN);
    await sub.scroll({ to: "bottom" });
    // Centre is 540,1110; a 0.6 screen-height scroll down drags to y = 1110-1332,
    // clamped to 1.
    expect(io.calls[0]).toMatch(/^swipe 540,1110 -> 540,1 /);
  });

  it("scroll refuses without a direction", async () => {
    const { sub } = elementsOver(SCREEN);
    const r = await sub.scroll({});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/needs a direction/);
  });

  it("go_back is the platform BACK key; go_forward has no analogue and refuses", async () => {
    const { io, sub } = elementsOver(SCREEN);
    await sub.goBack();
    expect(io.calls).toEqual(["key KEYCODE_BACK"]);
    const forward = await sub.goForward();
    expect(forward.ok).toBe(false);
    expect(forward.error).toMatch(/back-only/);
  });

  it("hover, select, chooseOption, setViewport and waitFor each refuse with a reason", async () => {
    const { sub } = elementsOver(SCREEN);
    for (const r of [
      await sub.hover(),
      await sub.select(),
      await sub.chooseOption(),
      await sub.setViewport(),
      await sub.waitFor(),
    ]) {
      expect(r.ok).toBe(false);
      expect(r.error!.length).toBeGreaterThan(40);
    }
  });
});

describe("gestures — real primitives, and one honest refusal", () => {
  const sub = (): { io: ReturnType<typeof recordingInput>; s: NativeActionSubstrate } => {
    const { screen } = screenOver(SCREEN);
    const io = recordingInput();
    return {
      io,
      s: new NativeActionSubstrate(io, new NativeElementSubstrate(screen, new RefRegistry())),
    };
  };

  it("swipe is ONE platform call", async () => {
    const { io, s } = sub();
    const r = await s.gesture({ kind: "swipe", from: { x: 1, y: 2 }, to: { x: 3, y: 4 } });
    expect(r.kind).toBe("dispatched");
    expect(io.calls).toEqual(["swipe 1,2 -> 3,4 300"]);
  });

  it("swipe reports 0 steps, because the driver interpolates", async () => {
    // Echoing the caller's `steps` would claim a fidelity this path does not
    // have.
    const { s } = sub();
    const r = await s.gesture({
      kind: "swipe",
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
      steps: 20,
    });
    if (r.kind !== "dispatched") throw new Error("expected a dispatch");
    expect((r.report as { steps: number }).steps).toBe(0);
  });

  it("touch maps the three phases onto motionevent", async () => {
    const { io, s } = sub();
    await s.gesture({ kind: "touch", phase: "start", coords: { x: 5, y: 6 } });
    await s.gesture({ kind: "touch", phase: "move", coords: { x: 7, y: 8 } });
    await s.gesture({ kind: "touch", phase: "end", coords: { x: 7, y: 8 } });
    expect(io.calls).toEqual(["motion DOWN 5 6", "motion MOVE 7 8", "motion UP 7 8"]);
  });

  it("touch refuses a phase with no coordinates, because the platform has no `all up` form", async () => {
    const { s } = sub();
    const r = await s.gesture({ kind: "touch", phase: "end" });
    expect(r.kind).toBe("refusal");
  });

  it("pinch refuses, naming why there is no fallback", async () => {
    // `adb shell input` has no two-finger primitive. Two concurrent `input
    // swipe` calls produce two independent single-pointer streams, which an app
    // sees as two unrelated drags. A gesture that reported success having done
    // something else is the failure this engine exists to avoid.
    const { io, s } = sub();
    const r = await s.gesture({ kind: "pinch", coords: { x: 1, y: 2 }, scale: 2 });
    expect(r.kind).toBe("refusal");
    if (r.kind !== "refusal") return;
    expect(r.engine).toBe("android-app");
    expect(r.hint).toMatch(/native-pinch-needs-multitouch-driver/);
    expect(io.calls, "a refused pinch dispatches nothing").toEqual([]);
  });
});

// ─── capture ──────────────────────────────────────────────────────────────────

/** Build a solid-colour RGBA PNG, so a crop can be checked by reading pixels. */
function solidPng(width: number, height: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = x % 256;
      raw[o + 1] = y % 256;
      raw[o + 2] = 0;
      raw[o + 3] = 255;
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, "ascii");
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("cropPng", () => {
  it("crops to the requested rectangle", () => {
    const cropped = cropPng(solidPng(400, 400), { x: 100, y: 200, width: 200, height: 80 });
    expect(pngSize(cropped)).toEqual({ width: 200, height: 80 });
  });

  it("clamps a rect that overhangs the frame", () => {
    // A UiAutomator node laid out under the navigation bar reports a box that
    // extends past the display. Refusing over one clipped row would be worse
    // than returning the visible part.
    const cropped = cropPng(solidPng(100, 100), { x: 50, y: 50, width: 200, height: 200 });
    expect(pngSize(cropped)).toEqual({ width: 50, height: 50 });
  });

  it("throws for a rect entirely outside the frame", () => {
    expect(() => cropPng(solidPng(100, 100), { x: 500, y: 500, width: 10, height: 10 })).toThrow(
      /png-crop-unsupported/,
    );
  });
});

describe("NativeCaptureSubstrate", () => {
  const capture = (dump = SCREEN): NativeCaptureSubstrate => {
    const { screen } = screenOver(dump);
    return new NativeCaptureSubstrate(
      { screenshot: async () => solidPng(1080, 2220) },
      new NativeElementSubstrate(screen, new RefRegistry()),
      {
        save: () => {
          throw new Error("not exercised");
        },
      },
    );
  };

  it("returns the full frame as an inline PNG", async () => {
    const r = await capture().screenshot({ format: "png", fullPage: false, describe: false });
    expect(r.kind).toBe("image");
    if (r.kind !== "image") return;
    expect(r.mimeType).toBe("image/png");
    expect(pngSize(Buffer.from(r.data, "base64"))).toEqual({ width: 1080, height: 2220 });
  });

  it("crops an element capture to the bounds the element substrate just read", async () => {
    const r = await capture().screenshot({
      format: "png",
      fullPage: false,
      describe: false,
      resolveTarget: () => ({ selector: "~submit" }),
    });
    if (r.kind !== "image") throw new Error(`expected an image, got ${r.kind}`);
    expect(pngSize(Buffer.from(r.data, "base64"))).toEqual({ width: 200, height: 80 });
  });

  it("refuses jpeg, because browxai ships no image encoder to transcode with", async () => {
    const r = await capture().screenshot({ format: "jpeg", fullPage: false, describe: false });
    expect(r.kind).toBe("refusal");
  });

  it("refuses pdf, and reports no video to flush", async () => {
    const pdf = await capture().pdf();
    expect(pdf.kind).toBe("refusal");
    // `null` is "nothing to flush", which is what teardown already does for a
    // session with no recorder. It is no claim that a recording was made.
    await expect(capture().prepareVideoSave()).resolves.toBeNull();
  });

  it("offers no pageText, so the handler can tell `nothing to sweep` from `swept nothing`", async () => {
    const r = await capture().screenshot({ format: "png", fullPage: false, describe: false });
    if (r.kind !== "image") throw new Error("expected an image");
    expect(r.pageText).toBeUndefined();
  });
});
