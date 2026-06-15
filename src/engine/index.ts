// The engine port — public surface of src/engine/. The session layer imports
// from here; tools never reach past the session into an adapter or Playwright
// directly. See docs/ai-context/architecture/engine-adapters.md.

export type {
  EngineKind,
  EngineCapabilities,
  EngineSession,
  EngineSubInterface,
  EngineLaunchHandles,
} from "./types.js";
export { ENGINE_KINDS } from "./types.js";
export {
  resolveBrowserType,
  EngineNotYetSupportedError,
  IMPLEMENTED_ENGINES,
  UnknownEngineError,
  validateEngine,
  resolveEngineSelection,
} from "./select.js";
export {
  capabilitiesFor,
  CHROMIUM_CAPABILITIES,
  FIREFOX_CAPABILITIES,
  WEBKIT_CAPABILITIES,
  ANDROID_CAPABILITIES,
  SAFARI_CAPABILITIES,
} from "./capabilities.js";
export { requireCdp, type CdpCapable } from "./session-cdp.js";
export { assertEngineSupports, DEEP_TOOLS, type EngineRefusal } from "./tool-gate.js";
export { PlaywrightChromiumAdapter } from "./adapters/playwright-chromium.js";
export type { PersistentLaunchSpec, EphemeralLaunchSpec } from "./adapters/playwright-chromium.js";
export {
  PlaywrightFirefoxAdapter,
  firefoxChannelFromEnv,
  MOZ_FIREFOX_CHANNEL,
} from "./adapters/playwright-firefox.js";
export type {
  FirefoxPersistentLaunchSpec,
  FirefoxEphemeralLaunchSpec,
} from "./adapters/playwright-firefox.js";
export { PlaywrightWebKitAdapter } from "./adapters/playwright-webkit.js";
export type {
  WebKitPersistentLaunchSpec,
  WebKitEphemeralLaunchSpec,
} from "./adapters/playwright-webkit.js";
export { AndroidCdpAdapter } from "./adapters/android-cdp.js";
export type { AndroidAttachHandles, AndroidAdapterDeps } from "./adapters/android-cdp.js";
export {
  SafaridriverHybridAdapter,
  SafariSessionBusyError,
  SafariRemoteAutomationDisabledError,
} from "./adapters/safaridriver-hybrid.js";
export type { SafariSessionHandle, SafariAdapterDeps } from "./adapters/safaridriver-hybrid.js";
export {
  CHROME_ANDROID_SOCKET,
  AdbNotInstalledError,
  NoAndroidDeviceError,
  ChromeSocketUnreachableError,
  devicesArgs,
  forwardArgs,
  forwardRemoveArgs,
  parseDevices,
  selectDevice,
  devToolsBaseUrl,
  versionUrl,
  extractWsUrl,
  pickFreePort,
  defaultAdbRunner,
  defaultFetcher,
} from "./adapters/adb.js";
export type { AdbDevice, AdbRunner, Fetcher } from "./adapters/adb.js";
