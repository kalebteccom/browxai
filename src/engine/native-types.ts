// The native-target vocabulary — the vendor-free leaf RFC 0008's `ios-app` and
// `android-app` engines share. A view hierarchy node, a device row, an app row,
// the driver seam, and the session handle `BrowserSession.native?()` returns.
//
// It is a LEAF on purpose. `src/session/types.ts` names `NativeSessionHandle`, the
// `src/page/*-substrate-ios.ts` adapters name `NativeNode`, and the substrate
// ports may not reach a vendor type even transitively — so nothing here imports
// XCUITest, WebDriverAgent, UiAutomator or Playwright. Every declaration is plain
// data or a method over plain data, which is what lets both native engines and
// both platforms' substrates name it without a cycle.
//
// WHY A HIERARCHY NODE AND NOT AN `A11yNode` DIRECTLY. `A11yNode` carries a `ref`,
// and minting a ref is a snapshot-substrate decision that needs the session's
// `RefRegistry`. The driver is below that: it reports what the platform said —
// element type, accessibility identifier, label, value, frame — and the substrate
// above it composes the tree. Keeping the two apart is also what lets the element
// substrate re-resolve a ref against a FRESH dump without re-minting anything.

import type { EngineKind } from "./types.js";

/** Which mobile platform a native session drives. `android` here is the NATIVE
 *  app surface (`android-app`), not the shipped `android` engine, which is real
 *  Chrome-on-Android over adb + CDP. */
export type NativePlatform = "ios" | "android";

/** A point in the device's own screen coordinates (points on iOS, pixels on
 *  Android). Declared here rather than reused from `gesture-types.ts` because
 *  that module's `Point` is documented as CSS pixels in a viewport, and a native
 *  screen has neither. */
export interface NativePoint {
  x: number;
  y: number;
}

/** An element's frame in screen coordinates. */
export interface NativeRect extends NativePoint {
  width: number;
  height: number;
}

/** One node of a native view hierarchy.
 *
 *  The field names are the platform's own, deliberately: `identifier` is iOS's
 *  `accessibilityIdentifier` (what a React Native `testID` compiles to) and
 *  Android's resource id, `label` is the accessibility label, `type` is the
 *  element class. Renaming them to `role` / `name` / `testId` here would bury the
 *  lossy part of the mapping in the driver, where nothing can see it; the
 *  snapshot substrate does that translation in one named place instead. */
export interface NativeNode {
  /** Platform element type — `Button`, `StaticText`, `TextField` on iOS. */
  type: string;
  /** Accessibility identifier / testID. The tier-1 selector (RFC 0008 §3). */
  identifier?: string;
  /** Accessibility label — the human-readable name. */
  label?: string;
  /** Current value, for controls that carry one. */
  value?: string;
  /** Placeholder text, for text inputs. */
  placeholder?: string;
  enabled: boolean;
  /** Whether the platform reports the node as on-screen and hit-testable. */
  visible: boolean;
  focused?: boolean;
  selected?: boolean;
  rect: NativeRect;
  children: NativeNode[];
}

/** A simulator / emulator row. */
export interface NativeDeviceInfo {
  /** The device's stable id — a simulator UDID, an emulator serial. */
  id: string;
  name: string;
  /** `Booted` / `Shutdown` verbatim from the platform tool, lowercased. */
  state: string;
  /** OS runtime, e.g. `iOS 26.5`. */
  runtime: string;
  platform: NativePlatform;
}

/** An installed or foreground application. */
export interface NativeAppInfo {
  bundleId: string;
  name?: string;
  /** Present on a foreground report: the process id the platform reported. */
  pid?: number;
}

/** The driver seam — everything a native substrate needs from the platform,
 *  expressed over plain data.
 *
 *  ONE DUMP PER ACTION, NO CACHED HANDLES. `hierarchy()` is the only read of
 *  structure, and the element substrate calls it again immediately before every
 *  dispatch. That is RFC 0008 §3's re-resolution rule expressed as an interface:
 *  there is no "element handle" member to hold across calls, so the class of bug
 *  the owner's trial found — a stale ref resolving to whatever now occupies its
 *  old rectangle — has nowhere to live.
 *
 *  `findByIdentifier` is the one exception and it is scoped to the call that uses
 *  it: `fill` needs a driver-native element id for an element-SCOPED set-value,
 *  because composing a shell string from a materialised secret is the leak RFC
 *  0008 §6 forbids. The id is resolved and spent inside one `fill`. */
export interface NativeDriver {
  readonly platform: NativePlatform;
  /** The foreground app's full view hierarchy. */
  hierarchy(): Promise<NativeNode>;
  /** PNG bytes of the whole screen. */
  screenshot(): Promise<Buffer>;
  /** A driver-native element id for an accessibility identifier, or null when
   *  nothing matches. Spent within the call that resolved it. */
  findByIdentifier(identifier: string): Promise<string | null>;
  /** Element-scoped set-value. Never a shell string (RFC 0008 §6). */
  setValue(elementId: string, text: string): Promise<void>;
  /** Type into whatever currently holds keyboard focus. */
  typeText(text: string): Promise<void>;
  tap(at: NativePoint): Promise<void>;
  /** A platform-primitive drag. On iOS this is one `dragFromToForDuration`, not a
   *  synthesised sequence of touch events. */
  swipe(from: NativePoint, to: NativePoint, durationMs: number): Promise<void>;
  /** A platform-primitive two-finger pinch about `centre`. `scale > 1` zooms in. */
  pinch(centre: NativePoint, scale: number, velocity: number): Promise<void>;
  /** A hardware or software button — `home`, `lock`, `volumeup`, `return`. */
  pressButton(name: string): Promise<void>;
  /** The frontmost application. */
  foregroundApp(): Promise<NativeAppInfo>;
  close(): Promise<void>;
}

/** The native session handle — `BrowserSession.native?()`, mirroring `safari?()`.
 *  Carries the driver, the device it is leased to, the app under test and the
 *  platform, which is exactly what RFC 0008 §1.4 specifies. The native substrate
 *  bundle reads it the way the Safari bundle reads `e.session.safari!()`. */
export interface NativeSessionHandle {
  readonly engine: EngineKind;
  readonly platform: NativePlatform;
  /** Simulator UDID / emulator serial. */
  readonly deviceId: string;
  /** Bundle id of the app under test. */
  readonly appId: string;
  readonly driver: NativeDriver;
  close(): Promise<void>;
}

/** The secret-scope string a native session presents in place of a page URL.
 *  `SecretRegistry.materialize` checks scope by case-insensitive substring
 *  containment, so `app://com.acme.app/` contains `com.acme.app` and a secret
 *  registered with `scope: "com.acme.app"` materialises here and refuses in a
 *  different app's session — with no change to the check itself (RFC 0008 §1.5,
 *  §6). */
export function nativeScopeUrl(handle: Pick<NativeSessionHandle, "appId">, screen?: string): string {
  return `app://${handle.appId}/${screen ?? ""}`;
}
