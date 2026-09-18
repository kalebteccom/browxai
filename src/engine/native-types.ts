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
  /** Open a URL scheme. This is what `navigate` means on a native target: there
   *  is no address bar, so the only navigation an app exposes is a deep link
   *  (RFC 0008 §2). */
  openUrl(url: string): Promise<void>;
  /** The frontmost application. */
  foregroundApp(): Promise<NativeAppInfo>;
  close(): Promise<void>;
}

/** The app under test, as the session currently understands it. */
export interface NativeAppTarget {
  /** Bundle id / package id, e.g. `com.acme.app`. */
  appId: string;
  /** The activity the last launch resolved to, where the platform has one.
   *  Android does; iOS does not, and leaves it absent rather than inventing a
   *  screen name the platform never reported. */
  activity?: string;
}

/** Raised by a `NativeLifecycle` verb the platform has no primitive for. A
 *  structural refusal naming the engine and what is missing — never a silent
 *  no-op and never a plausible empty, which is the whole point of the
 *  sub-interface gate this mirrors. */
export class NativeUnsupportedError extends Error {
  readonly engine: EngineKind;
  readonly verb: string;
  constructor(engine: EngineKind, verb: string, detail: string) {
    super(
      `native-verb-unsupported: \`${verb}\` has no implementation on the "${engine}" engine. ${detail}`,
    );
    this.name = "NativeUnsupportedError";
    this.engine = engine;
    this.verb = verb;
  }
}

/** Device and app lifecycle — the seam the `app_*` tool family drives, one
 *  implementation per native adapter.
 *
 *  It is separate from `NativeDriver` because the two answer different
 *  questions. The driver reads and drives the SCREEN of the app under test; this
 *  installs, launches, stops and enumerates APPLICATIONS, which is a posture
 *  broadening rather than a read (RFC 0008 §8) and is why the whole family sits
 *  behind `native-device`.
 *
 *  A verb the platform has no primitive for throws `NativeUnsupportedError`. It
 *  does NOT return an empty list or a silent success: `app_uninstall` reporting
 *  `{ok:true}` on an engine that uninstalled nothing is the failure mode the
 *  omitted-sub-interface gate exists to prevent, one layer down. */
export interface NativeLifecycle {
  /** Installed application ids on the session's device. */
  apps(includeSystem: boolean): Promise<string[]>;
  /** Install an application bundle from a HOST path. */
  install(bundlePath: string, reinstall: boolean): Promise<void>;
  /** Remove an application and its data. */
  uninstall(appId: string): Promise<void>;
  /** Launch an application and report what the platform resolved. */
  launch(appId: string): Promise<NativeAppTarget>;
  /** Stop a running application. Its data survives. */
  terminate(appId: string): Promise<void>;
  /** Clear an application's data and its granted runtime permissions. */
  reset(appId: string): Promise<void>;
  /** Which application owns the foreground right now, or null mid-transition. */
  foreground(): Promise<NativeAppTarget | null>;
}

/** The native session handle — `BrowserSession.native?()`, mirroring `safari?()`.
 *  Carries the platform, the device the session is leased to, the app under test
 *  and the app-lifecycle seam, which is RFC 0008 §1.4.
 *
 *  It carries NO transport member. The two native engines reach their screens
 *  through genuinely different seams — iOS through a `NativeDriver` over
 *  WebDriverAgent, Android through a shared `NativeScreen` over `uiautomator
 *  dump` — and each adapter extends this shape with its own, which its own
 *  substrate bundle is the only reader of. Putting one engine's transport on the
 *  shared handle would make the other engine carry a member nothing calls.
 *
 *  The native substrate bundle reads it the way the Safari bundle reads
 *  `e.session.safari!()`. */
export interface NativeSessionHandle {
  readonly engine: EngineKind;
  readonly platform: NativePlatform;
  /** Simulator UDID / emulator serial. */
  readonly deviceId: string;
  /** The app under test. MUTABLE: `app_launch` can point a live session at a
   *  different application without reopening it, and `app_uninstall` can leave a
   *  session with none. */
  app: NativeAppTarget | undefined;
  /** Device and app lifecycle. Every native session has one; its individual
   *  verbs refuse where the platform has no primitive. */
  readonly lifecycle: NativeLifecycle;
  close(): Promise<void>;
}

/** The iOS-flavoured handle: the generic shape plus the XCUITest driver its
 *  substrates read. Declared here, beside `NativeDriver`, because the
 *  `src/page/*-substrate-ios.ts` adapters name it and `src/page/**` may not
 *  import `src/engine/adapters/**`. */
export interface IosNativeHandle extends NativeSessionHandle {
  readonly driver: NativeDriver;
}

/** The secret-scope string a native session presents in place of a page URL.
 *  `SecretRegistry.materialize` checks scope by case-insensitive substring
 *  containment, so `app://com.acme.app/` contains `com.acme.app` and a secret
 *  registered with `scope: "com.acme.app"` would scope here and refuse in a
 *  different app's session — with no change to the check itself (RFC 0008 §1.5,
 *  §6). NOTE that no native `fill` reaches `materialize` today: substitution
 *  lives in the Playwright action core, so a `<NAME>` alias is typed literally on
 *  both native engines and `fill` warns that it was.
 *
 *  A session with no app under test reports `app://unknown`, which is a real
 *  state (`app_uninstall` of the app under test leaves it) and not an error. */
export function nativeScopeUrl(handle: Pick<NativeSessionHandle, "app">, screen?: string): string {
  if (!handle.app) return "app://unknown";
  return `app://${handle.app.appId}/${screen ?? ""}`;
}
