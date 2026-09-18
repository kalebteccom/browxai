// The ios-app substrates, driven against a fake `NativeDriver`. The seam is the
// driver, so these tests exercise the real snapshot composition, the real
// re-resolution path and the real action verbs with no simulator and no
// WebDriverAgent — the shape `safaridriver-hybrid.test.ts` uses for its faked
// WebDriver client.
//
// The load-bearing case is `re-resolves before every dispatch`: the fake serves a
// DIFFERENT hierarchy on the second call, and the tap must land on the element's
// new position. That is the bug class RFC 0008 §3 exists to prevent, and it is
// invisible to a fake that always answers the same thing.

import { describe, it, expect } from "vitest";
import type {
  NativeAppInfo,
  NativeDriver,
  NativeNode,
  NativePoint,
  NativeSessionHandle,
} from "../engine/native-types.js";
import type { ElementToken } from "./element-substrate-types.js";
import { RefRegistry } from "./refs.js";
import { IosSnapshotSubstrate } from "./snapshot-substrate-ios.js";
import { IosElementSubstrate } from "./element-substrate-ios.js";
import { IosActionSubstrate } from "./action-substrate-ios.js";
import { IosCaptureSubstrate } from "./capture-substrate-ios.js";
import { IosTargetSubstrate } from "./target-substrate-ios.js";
import { IosEmulationSubstrate } from "./emulation-substrate-ios.js";
import { IosScriptSubstrate } from "./script-substrate-ios.js";
import { iosStorageSubstrate } from "./storage-substrate-ios.js";

interface Dispatched {
  kind: string;
  args: unknown;
}

function node(partial: Partial<NativeNode> & { type: string }): NativeNode {
  return {
    enabled: true,
    visible: true,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    children: [],
    ...partial,
  };
}

/** A screen whose submit button sits at `submitY`. Everything else is fixed, so a
 *  ref minted against one `submitY` and resolved against another isolates exactly
 *  the "the element moved" case. */
function screen(submitY: number): NativeNode {
  return node({
    type: "Application",
    label: "Checkout",
    rect: { x: 0, y: 0, width: 400, height: 800 },
    children: [
      node({
        type: "TextField",
        label: "Card number",
        value: "4242",
        rect: { x: 20, y: 200, width: 360, height: 44 },
      }),
      node({
        type: "Button",
        identifier: "checkout-submit",
        label: "Pay now",
        rect: { x: 20, y: submitY, width: 360, height: 48 },
      }),
      node({ type: "Button", label: "Cancel", rect: { x: 20, y: 720, width: 360, height: 48 } }),
    ],
  });
}

class FakeDriver implements NativeDriver {
  readonly platform = "ios" as const;
  readonly dispatched: Dispatched[] = [];
  /** Hierarchies served in order; the last one repeats once exhausted. */
  private readonly queue: NativeNode[];
  hierarchyCalls = 0;
  elementIds: Record<string, string | null> = { "checkout-submit": "E7" };

  constructor(...trees: NativeNode[]) {
    this.queue = trees.length ? trees : [screen(600)];
  }

  async hierarchy(): Promise<NativeNode> {
    const at = Math.min(this.hierarchyCalls, this.queue.length - 1);
    this.hierarchyCalls++;
    return this.queue[at]!;
  }
  async screenshot(): Promise<Buffer> {
    return Buffer.from("\x89PNG-fake");
  }
  async findByIdentifier(identifier: string): Promise<string | null> {
    return this.elementIds[identifier] ?? null;
  }
  async setValue(elementId: string, text: string): Promise<void> {
    this.dispatched.push({ kind: "setValue", args: { elementId, text } });
  }
  async typeText(text: string): Promise<void> {
    this.dispatched.push({ kind: "typeText", args: text });
  }
  async tap(at: NativePoint): Promise<void> {
    this.dispatched.push({ kind: "tap", args: at });
  }
  async swipe(from: NativePoint, to: NativePoint, durationMs: number): Promise<void> {
    this.dispatched.push({ kind: "swipe", args: { from, to, durationMs } });
  }
  async pinch(centre: NativePoint, scale: number, velocity: number): Promise<void> {
    this.dispatched.push({ kind: "pinch", args: { centre, scale, velocity } });
  }
  async pressButton(name: string): Promise<void> {
    this.dispatched.push({ kind: "button", args: name });
  }
  async openUrl(url: string): Promise<void> {
    this.dispatched.push({ kind: "openUrl", args: url });
  }
  async foregroundApp(): Promise<NativeAppInfo> {
    return { bundleId: "com.acme.checkout", name: "Checkout", pid: 42 };
  }
  async close(): Promise<void> {}
}

function handleFor(driver: NativeDriver): NativeSessionHandle {
  return {
    engine: "ios-app",
    platform: "ios",
    deviceId: "UDID-1",
    appId: "com.acme.checkout",
    driver,
    close: async () => {},
  };
}

interface Rig {
  driver: FakeDriver;
  handle: NativeSessionHandle;
  refs: RefRegistry;
  elements: IosElementSubstrate;
  actions: IosActionSubstrate;
}

function rig(...trees: NativeNode[]): Rig {
  const driver = new FakeDriver(...trees);
  const handle = handleFor(driver);
  const refs = new RefRegistry();
  const elements = new IosElementSubstrate(handle, refs);
  return { driver, handle, refs, elements, actions: new IosActionSubstrate(handle, elements) };
}

/** Mint refs the way `snapshot` does, so the element substrate is driven against
 *  a registry a real session would have. */
async function snapshotRefs(r: Rig): Promise<Map<string, string>> {
  const composed = await new IosSnapshotSubstrate(r.handle).compose(r.refs, []);
  const byName = new Map<string, string>();
  const stack = composed.tree ? [composed.tree] : [];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.name) byName.set(n.name, n.ref);
    stack.push(...n.children);
  }
  return byName;
}

describe("IosSnapshotSubstrate", () => {
  it("composes the hierarchy into an A11yNode tree with role, name and refs", async () => {
    const r = rig();
    const composed = await new IosSnapshotSubstrate(r.handle).compose(r.refs, []);
    expect(composed.tree!.name).toBe("app://com.acme.checkout/Checkout");
    const roles = composed.tree!.children.map((c) => `${c.role}:${c.name}`);
    expect(roles).toEqual(["textbox:Card number", "button:Pay now", "button:Cancel"]);
    expect(composed.tree!.children.every((c) => /^e\d+$/.test(c.ref))).toBe(true);
  });

  it("reports the a11y tier — the hierarchy IS the accessibility tree", async () => {
    const r = rig();
    const composed = await new IosSnapshotSubstrate(r.handle).compose(r.refs, []);
    expect(composed.stats.tier).toBe("a11y");
    expect(composed.stats.domWalkEntries).toBe(0);
  });

  it("names its source in a warning on every snapshot", async () => {
    const r = rig();
    const composed = await new IosSnapshotSubstrate(r.handle).compose(r.refs, []);
    expect(composed.warnings[0]).toMatch(/XCUITest accessibility hierarchy/);
  });

  it("says `pierce` has no meaning here", async () => {
    const r = rig();
    const composed = await new IosSnapshotSubstrate(r.handle).compose(r.refs, [], {
      pierce: "closed",
    });
    expect(composed.warnings.join(" ")).toMatch(/no DOM and no shadow root/);
  });

  it("warns when NO element carries an identifier, with the counts", async () => {
    // browxai cannot make an element addressable that the app never labelled. The
    // warning is the app team's fix list.
    const unlabelled = node({
      type: "Application",
      rect: { x: 0, y: 0, width: 400, height: 800 },
      children: [node({ type: "Button", label: "Pay now" })],
    });
    const r = rig(unlabelled);
    const composed = await new IosSnapshotSubstrate(r.handle).compose(r.refs, []);
    expect(composed.warnings.join(" ")).toMatch(
      /no element on this screen carries an accessibility identifier/,
    );
    expect(composed.warnings.join(" ")).toMatch(/1 of 2 carry a label/);
  });
});

describe("IosElementSubstrate re-resolves against a FRESH hierarchy", () => {
  it("resolves an identified ref to the element's NEW position after it moves", async () => {
    // Two different screens: the ref is minted against the first and every later
    // read runs against the second. An implementation that cached the frame would
    // answer 600 here.
    const r = rig(screen(600), screen(300), screen(300));
    const refs = await snapshotRefs(r);
    const resolved = await r.elements.resolve({ kind: "ref", ref: refs.get("Pay now")! });
    expect(resolved.kind).toBe("element");
    const bounds = await r.elements.bounds((resolved as { kind: "element"; el: ElementToken }).el);
    expect(bounds).toMatchObject({ kind: "bounds", rect: { y: 300 } });
  });

  it("reports an unidentified ref as STALE once it moves", async () => {
    const moved = node({
      type: "Application",
      rect: { x: 0, y: 0, width: 400, height: 800 },
      children: [
        node({ type: "Button", label: "Inserted", rect: { x: 0, y: 0, width: 10, height: 10 } }),
        node({
          type: "TextField",
          label: "Card number",
          rect: { x: 20, y: 200, width: 360, height: 44 },
        }),
        node({
          type: "Button",
          identifier: "checkout-submit",
          label: "Pay now",
          rect: { x: 20, y: 600, width: 360, height: 48 },
        }),
        node({ type: "Button", label: "Cancel", rect: { x: 20, y: 720, width: 360, height: 48 } }),
      ],
    });
    const r = rig(screen(600), moved, moved);
    const refs = await snapshotRefs(r);
    const cancel = refs.get("Cancel")!;
    const bounds = await r.elements.bounds({
      __brand: "element",
      query: { kind: "ref", ref: cancel },
    });
    expect(bounds).toMatchObject({ kind: "refusal", reason: "stale-element" });
    expect((bounds as { hint: string }).hint).toMatch(/testID/);
  });

  it("refuses an ambiguous query, naming the count", async () => {
    const twins = node({
      type: "Application",
      rect: { x: 0, y: 0, width: 400, height: 800 },
      children: [
        node({ type: "Button", label: "Delete", rect: { x: 0, y: 10, width: 40, height: 40 } }),
        node({ type: "Button", label: "Delete", rect: { x: 0, y: 90, width: 40, height: 40 } }),
      ],
    });
    const r = rig(twins);
    const bounds = await r.elements.bounds({
      __brand: "element",
      query: { kind: "selector", selector: 'role=button[name="Delete"]' },
    });
    expect(bounds).toMatchObject({ kind: "refusal", reason: "unaddressable-target" });
    expect((bounds as { error: string }).error).toMatch(/matches 2 elements/);
  });

  it("distinguishes a ref the registry never minted from a stale one", async () => {
    const r = rig();
    const resolved = await r.elements.resolve({ kind: "ref", ref: "e999" });
    expect(resolved).toMatchObject({ kind: "refusal", reason: "no-such-element", ref: "e999" });
  });

  it("probes visibility, enabled-ness, text, value and attributes", async () => {
    const r = rig();
    await snapshotRefs(r);
    const read = await r.elements.probe(
      { __brand: "element", query: { kind: "selector", selector: "~checkout-submit" } },
      {
        matches: true,
        visible: true,
        enabled: true,
        text: true,
        value: true,
        attribute: "accessibilityIdentifier",
      },
    );
    expect(read).toEqual({
      kind: "reading",
      matches: 1,
      visible: true,
      enabled: true,
      text: "Pay now",
      value: null,
      attribute: "checkout-submit",
    });
  });

  it("answers `matches` for an ambiguous query — it IS the question", async () => {
    const twins = node({
      type: "Application",
      children: [
        node({ type: "Button", label: "Delete" }),
        node({ type: "Button", label: "Delete" }),
      ],
    });
    const r = rig(twins);
    const read = await r.elements.probe(
      { __brand: "element", query: { kind: "selector", selector: 'role=button[name="Delete"]' } },
      { matches: true },
    );
    expect(read).toEqual({ kind: "reading", matches: 2 });
  });

  it("counts matches for verify_count", async () => {
    const r = rig();
    expect(await r.elements.count({ kind: "selector", selector: "role=button" })).toEqual({
      kind: "count",
      n: 2,
    });
  });

  it("refuses a selector it cannot turn into a query", async () => {
    const r = rig();
    const resolved = await r.elements.resolve({ kind: "selector", selector: "[colour=red]" });
    expect(resolved).toMatchObject({ kind: "refusal", reason: "unaddressable-target" });
  });
});

describe("IosActionSubstrate", () => {
  it("taps the centre of the element the FRESH resolution returned", async () => {
    const r = rig(screen(600), screen(300), screen(300));
    const refs = await snapshotRefs(r);
    const res = await r.actions.click({ target: { ref: refs.get("Pay now")! } });
    expect(res.ok).toBe(true);
    // Centre of {x:20, y:300, w:360, h:48} on the SECOND hierarchy — not the 624
    // the ref was minted against.
    expect(r.driver.dispatched).toEqual([{ kind: "tap", args: { x: 200, y: 324 } }]);
  });

  it("dispatches a coords target without asking the driver for a hierarchy", async () => {
    const r = rig();
    await r.actions.click({ target: { coords: { x: 11, y: 22 } } });
    expect(r.driver.hierarchyCalls).toBe(0);
    expect(r.driver.dispatched).toEqual([{ kind: "tap", args: { x: 11, y: 22 } }]);
  });

  it('refuses `dispatch: "direct"` — every tap here already lands on a freshly measured point', async () => {
    const r = rig();
    const res = await r.actions.click({ target: { coords: { x: 1, y: 2 } }, dispatch: "direct" });
    expect(res.ok).toBe(false);
  });

  it("fills through the element-scoped set-value when the element is identified", async () => {
    // RFC 0008 §6: no shell string, and no keyboard, so no character-preview
    // bubble for a screen recording to catch.
    const r = rig();
    await snapshotRefs(r);
    const res = await r.actions.fill({
      target: { selector: "~checkout-submit" },
      value: "hunter2",
    });
    expect(res.ok).toBe(true);
    expect(r.driver.dispatched).toEqual([
      { kind: "setValue", args: { elementId: "E7", text: "hunter2" } },
    ]);
  });

  it("falls back to tap-and-type with a LOUD warning when there is no identifier", async () => {
    const r = rig();
    const res = await r.actions.fill({
      target: { selector: 'role=textbox[name="Card number"]' },
      value: "4111",
    });
    expect(res.ok).toBe(true);
    expect(r.driver.dispatched.map((d) => d.kind)).toEqual(["tap", "typeText"]);
    expect(res.warnings.join(" ")).toMatch(/character preview/);
  });

  it("maps press to the simulator's hardware buttons, and keys to text", async () => {
    const r = rig();
    await r.actions.press({ key: "home" });
    await r.actions.press({ key: "Enter" });
    expect(r.driver.dispatched).toEqual([
      { kind: "button", args: "home" },
      { kind: "typeText", args: "\n" },
    ]);
  });

  it('refuses `press({key:"back"})`, which is an Android idiom', async () => {
    const r = rig();
    const res = await r.actions.press({ key: "back" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/iOS has no hardware back key/);
  });

  it("navigates by URL scheme, and refuses a bare path", async () => {
    const r = rig();
    const deep = await r.actions.navigate({ url: "myapp://checkout/42" });
    expect(deep.ok).toBe(true);
    expect(r.driver.dispatched).toEqual([{ kind: "openUrl", args: "myapp://checkout/42" }]);
    const bare = await r.actions.navigate({ url: "/checkout/42" });
    expect(bare.ok).toBe(false);
    expect(bare.error).toMatch(/URL SCHEME/);
  });

  it("scrolls down by dragging the content UP", async () => {
    // The inversion every touch surface has, and the one place a sign error would
    // silently scroll the wrong way.
    const r = rig();
    const res = await r.actions.scroll({ by: { y: 300 } });
    expect(res.ok).toBe(true);
    const swipe = r.driver.dispatched[0]!.args as { from: NativePoint; to: NativePoint };
    expect(swipe.from.y).toBeGreaterThan(swipe.to.y);
    expect(swipe.from.x).toBe(swipe.to.x);
  });

  it("performs scroll-to-edge as bounded repeats and says so", async () => {
    const r = rig();
    const res = await r.actions.scroll({ to: "bottom" });
    expect(r.driver.dispatched).toHaveLength(8);
    expect(res.warnings.join(" ")).toMatch(/bounded best effort/);
  });

  it("refuses scroll-into-view, naming the primitive it would need", async () => {
    const r = rig();
    const res = await r.actions.scroll({ target: { ref: "e1" } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/container-aware scroll/);
  });

  it("dispatches swipe and pinch as XCUITest primitives", async () => {
    const r = rig();
    const swiped = await r.actions.gesture({
      kind: "swipe",
      from: { x: 10, y: 700 },
      to: { x: 10, y: 100 },
      durationMs: 250,
    });
    expect(swiped.kind).toBe("dispatched");
    // ONE primitive with a duration, so one step. Echoing a requested step count
    // would be inventing evidence.
    expect(swiped).toMatchObject({ report: { steps: 1, durationMs: 250 } });
    const pinched = await r.actions.gesture({
      kind: "pinch",
      coords: { x: 200, y: 400 },
      scale: 2,
    });
    expect(pinched).toMatchObject({ kind: "dispatched", report: { scale: 2 } });
    expect(r.driver.dispatched.map((d) => d.kind)).toEqual(["swipe", "pinch"]);
  });

  it("refuses the raw touch pipeline, which XCUITest genuinely does not have", async () => {
    const r = rig();
    const res = await r.actions.gesture({ kind: "touch", phase: "start", coords: { x: 1, y: 2 } });
    expect(res).toMatchObject({ kind: "refusal", engine: "ios-app" });
    expect((res as { hint: string }).hint).toMatch(/no raw touch-down/);
    expect(r.driver.dispatched).toEqual([]);
  });

  it("names the missing primitive for every verb it refuses", async () => {
    const r = rig();
    for (const res of [
      // Each verb IGNORES its arguments, the way `SafariActionSubstrate`'s
      // refusals do: the answer does not depend on what was asked.
      await r.actions.hover(),
      await r.actions.select(),
      await r.actions.goBack(),
      await r.actions.goForward(),
      await r.actions.setViewport(),
      await r.actions.waitFor(),
      await r.actions.chooseOption(),
    ]) {
      expect(res.ok).toBe(false);
      expect(res.error!.length, res.error).toBeGreaterThan(60);
    }
  });
});

describe("IosCaptureSubstrate", () => {
  const req = { format: "png" as const, fullPage: false, describe: false };

  it("returns the simulator's PNG inline", async () => {
    const r = rig();
    const capture = new IosCaptureSubstrate(r.handle, () => {
      throw new Error("not reached");
    });
    const res = await capture.screenshot(req);
    expect(res).toMatchObject({ kind: "image", mimeType: "image/png" });
  });

  it("writes through the workspace saver in `path` mode", async () => {
    const r = rig();
    const capture = new IosCaptureSubstrate(
      r.handle,
      (buf, args) => ({ ok: true, path: args.path, bytes: buf.length }) as never,
    );
    expect(await capture.screenshot({ ...req, path: "shots/a.png" })).toMatchObject({
      kind: "saved",
    });
  });

  it("refuses element-scoped capture and jpeg, naming the missing decoder", async () => {
    const r = rig();
    const capture = new IosCaptureSubstrate(r.handle, () => ({}) as never);
    const scoped = await capture.screenshot({ ...req, resolveTarget: () => ({ ref: "e1" }) });
    expect(scoped).toMatchObject({ kind: "refusal" });
    expect((scoped as { error: string }).error).toMatch(/PNG decoder/);
    const jpeg = await capture.screenshot({ ...req, format: "jpeg" });
    expect(jpeg).toMatchObject({ kind: "refusal" });
  });

  it("reports no video flush", async () => {
    const r = rig();
    const capture = new IosCaptureSubstrate(r.handle, () => ({}) as never);
    expect(await capture.prepareVideoSave()).toBeNull();
  });
});

describe("IosTargetSubstrate", () => {
  it("reports the app scope a secret is matched against", async () => {
    // `SecretRegistry.materialize` checks scope by substring containment, so
    // `app://com.acme.checkout/Checkout` contains `com.acme.checkout` and a secret
    // scoped to that app materialises here and refuses in another's session.
    const r = rig();
    const target = new IosTargetSubstrate(r.handle);
    expect(await target.url()).toBe("app://com.acme.checkout/Checkout");
    expect("app://com.acme.checkout/Checkout").toContain("com.acme.checkout");
    expect(await target.title()).toBe("Checkout");
  });
});

describe("the absent ports refuse, each in the way its port can express", () => {
  it("emulation returns refusals naming the simctl command that would do it", async () => {
    const emulation = new IosEmulationSubstrate();
    for (const res of [
      await emulation.setGeolocation(),
      await emulation.setColorScheme(),
      await emulation.setReducedMotion(),
    ]) {
      expect(res).toMatchObject({ kind: "refusal" });
      expect((res as { error: string }).error).toMatch(/ios-app engine/);
    }
  });

  it("script throws, because any value it returned would look like a result", async () => {
    await expect(new IosScriptSubstrate().evaluate()).rejects.toThrow(/ios-script-unreachable/);
  });

  it("storage throws, because `[]` is indistinguishable from an empty cookie jar", () => {
    const storage = iosStorageSubstrate();
    // The engine tag reads normally so diagnostics do not trip the trap.
    expect(storage.engine).toBe("ios-app");
    expect(() => storage.cookiesList({})).toThrow(/ios-storage-unreachable/);
    expect(() => storage.idbListDatabases("idb_list_databases")).toThrow(/subInterfaceGate/);
  });
});
