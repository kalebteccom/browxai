// `IosXcuiDriver` — the `NativeDriver` implementation for the iOS Simulator.
// Reads and input go through WebDriverAgent (`WdaClient`); the whole-screen
// screenshot goes through `simctl`, which needs nothing extra installed.
//
// This file also holds the ONE place WebDriverAgent's source JSON becomes
// browxai's `NativeNode`. Keeping the conversion here rather than in the snapshot
// substrate is what keeps the substrate free of WebDriverAgent's field names, and
// it puts the lossy parts of the mapping in a single readable function instead of
// spread across a tree walk.

import type {
  NativeAppInfo,
  NativeDriver,
  NativeNode,
  NativePoint,
  NativeRect,
} from "../../native-types.js";
import type { IosSimulator } from "./simulator.js";
import { WdaClient } from "./wda-client.js";

/** WebDriverAgent's source-JSON node. Every field is optional and several are
 *  stringly typed (`isVisible` arrives as `"1"`, `"true"` or `true` depending on
 *  the WebDriverAgent build), which is why nothing here is read without a
 *  coercion. */
interface WdaNode {
  type?: string;
  name?: string;
  label?: string;
  rawIdentifier?: string | null;
  value?: unknown;
  placeholderValue?: string | null;
  isEnabled?: unknown;
  isVisible?: unknown;
  isFocused?: unknown;
  isSelected?: unknown;
  rect?: { x?: number; y?: number; width?: number; height?: number };
  children?: WdaNode[];
}

/** WebDriverAgent reports booleans as `true`, `"true"` or `"1"` depending on the
 *  build and the field. Anything else is false — an unreadable flag must not
 *  become a confident `true`. */
function flag(raw: unknown): boolean {
  return raw === true || raw === "true" || raw === "1" || raw === 1;
}

function rectOf(raw: WdaNode["rect"]): NativeRect {
  return {
    x: raw?.x ?? 0,
    y: raw?.y ?? 0,
    width: raw?.width ?? 0,
    height: raw?.height ?? 0,
  };
}

/** The accessibility identifier, and the one genuinely lossy read in the mapping.
 *
 *  WebDriverAgent 4.x and later report `rawIdentifier`, which IS
 *  `accessibilityIdentifier` verbatim — when it is present this is exact. Older
 *  builds report only `name`, which WebDriverAgent defines as "the identifier if
 *  it is non-empty, otherwise the label". So on an older build an element with an
 *  identifier and no label is indistinguishable from one with a label and no
 *  identifier, and the only signal left is whether `name` differs from `label`.
 *
 *  The fallback therefore claims an identifier only when `name` and `label`
 *  disagree. It UNDER-reports: an element whose identifier and label are the same
 *  string loses its identifier and falls back to the path-keyed ref, which is the
 *  honest status of an element browxai cannot tell apart. It never over-reports,
 *  which is the direction that would matter — a fabricated identifier would mint a
 *  ref that survives a layout change it should not have survived. */
export function identifierOf(node: WdaNode): string | undefined {
  const raw = node.rawIdentifier;
  if (typeof raw === "string" && raw.length > 0) return raw;
  const name = node.name;
  if (typeof name === "string" && name.length > 0 && name !== node.label) return name;
  return undefined;
}

/** `XCUIElementTypeButton` → `Button`. Older WebDriverAgent builds already strip
 *  the prefix, so this is idempotent. */
export function elementType(raw: string | undefined): string {
  if (!raw) return "Other";
  return raw.startsWith("XCUIElementType") ? raw.slice("XCUIElementType".length) : raw;
}

/** WebDriverAgent's source JSON → browxai's vendor-free `NativeNode` tree.
 *
 *  Bounded by construction: a hierarchy deeper than `maxDepth` is TRUNCATED, not
 *  rejected, matching the a11y walk's own containment ceiling. An XCUITest tree on
 *  a real screen is tens of levels; the cap is there for a malformed dump. */
export function toNativeTree(raw: unknown, maxDepth = 200): NativeNode {
  const convert = (node: WdaNode, depth: number): NativeNode => {
    const label = typeof node.label === "string" && node.label ? node.label : undefined;
    const value = node.value === null || node.value === undefined ? undefined : String(node.value);
    const placeholder =
      typeof node.placeholderValue === "string" && node.placeholderValue
        ? node.placeholderValue
        : undefined;
    return {
      type: elementType(node.type),
      ...(identifierOf(node) !== undefined ? { identifier: identifierOf(node) } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(placeholder !== undefined ? { placeholder } : {}),
      enabled: flag(node.isEnabled),
      visible: flag(node.isVisible),
      ...(node.isFocused !== undefined ? { focused: flag(node.isFocused) } : {}),
      ...(node.isSelected !== undefined ? { selected: flag(node.isSelected) } : {}),
      rect: rectOf(node.rect),
      children:
        depth >= maxDepth ? [] : (node.children ?? []).map((child) => convert(child, depth + 1)),
    };
  };
  return convert((raw ?? {}) as WdaNode, 0);
}

/** Seconds, because `dragfromtoforduration` takes seconds while every browxai
 *  gesture argument is milliseconds. */
const MS_PER_SEC = 1000;

export class IosXcuiDriver implements NativeDriver {
  readonly platform = "ios" as const;

  constructor(
    private readonly wda: WdaClient,
    private readonly sim: IosSimulator,
  ) {}

  async hierarchy(): Promise<NativeNode> {
    return toNativeTree(await this.wda.source());
  }

  /** simctl's screenshot, not WebDriverAgent's. It is the one read that works
   *  with no WebDriverAgent running, it needs no base64 round trip, and it
   *  captures the whole screen including anything drawn over the app. */
  async screenshot(): Promise<Buffer> {
    return this.sim.screenshot();
  }

  async findByIdentifier(identifier: string): Promise<string | null> {
    return this.wda.findByAccessibilityId(identifier);
  }

  async setValue(elementId: string, text: string): Promise<void> {
    await this.wda.setValue(elementId, text);
  }

  async typeText(text: string): Promise<void> {
    await this.wda.keys(text);
  }

  async tap(at: NativePoint): Promise<void> {
    await this.wda.tap(at.x, at.y);
  }

  async swipe(from: NativePoint, to: NativePoint, durationMs: number): Promise<void> {
    await this.wda.drag(from, to, durationMs / MS_PER_SEC);
  }

  /** XCUITest's pinch is element-scoped, so a whole-screen pinch applies to the
   *  application element. `centre` is unused: XCUITest pinches about the target
   *  element's own centre and exposes no origin argument, which is a real
   *  difference from the CDP path and is reported as a warning rather than
   *  silently ignored (see `ios-actions.ts`). */
  async pinch(_centre: NativePoint, scale: number, velocity: number): Promise<void> {
    const root = await this.wda.activeElementRoot();
    if (!root) throw new Error("ios-pinch-no-root: WebDriverAgent reported no application element");
    await this.wda.pinch(root, scale, velocity);
  }

  async pressButton(name: string): Promise<void> {
    await this.wda.pressButton(name);
  }

  async foregroundApp(): Promise<NativeAppInfo> {
    const info = await this.wda.activeAppInfo();
    return {
      bundleId: info.bundleId ?? "",
      ...(info.name !== undefined ? { name: info.name } : {}),
      ...(info.pid !== undefined ? { pid: info.pid } : {}),
    };
  }

  async close(): Promise<void> {
    await this.wda.deleteSession();
  }
}
