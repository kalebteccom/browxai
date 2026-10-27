// Device and app lifecycle for the native engines (RFC 0008) — `ios-app` and
// `android-app` share one tool surface.
//
// WHY THESE ARE TOOLS AND NOT `open_session` OPTIONS. RFC 0008 §2 put the device
// and the app on the session options — `open_session({native: {deviceId, appId,
// appPath}})` — and building it showed that to be the wrong shape. An emulator
// cold-boot is 30-90 seconds. An agent has to SEE which devices exist before it
// can name one. Installing an APK fails in ways an agent must be able to read and
// retry (`INSTALL_FAILED_INSUFFICIENT_STORAGE`, a wrong ABI, an unsigned build).
// Folding all of that into session creation makes `open_session` a call that can
// take 90 seconds and fail six ways, or one that silently picks a device. So
// lifecycle is tools, and `open_session` leases a device that is already up.
//
// THE SPLIT IS SESSION-SCOPE. `device_*` runs BEFORE a session exists and takes
// no session; `app_*` drives the device the current session leased, so it takes
// one and reaches it through `requireNative`, which refuses on any other engine
// with a sentence naming it.
//
// ONE SURFACE, TWO ENGINES, AND THE GAPS REFUSE. The `app_*` verbs route through
// `NativeLifecycle` on the session handle, which each native adapter implements
// over its own platform tooling — `adb` on `android-app`, `simctl` on `ios-app`.
// Where a platform has no primitive the verb throws `NativeUnsupportedError`
// naming the engine and what is missing: `app_uninstall` and `app_reset` do that
// on `ios-app`, because a simulator has no per-app data clear and browxai does
// not uninstall apps from a device the session leases rather than owns. A
// structural refusal is the point — `app_reset` answering `ok:true` having
// cleared nothing is the plausible-empty the sub-interface gate exists to catch.
//
// `device_boot` and `device_shutdown` are adb/AVD-scoped and say so. An `ios-app`
// session boots its own simulator at session creation and never shuts one down,
// because a session that powers off a device it may not have booted destroys
// state outside its own lifetime. `device_list` reports both platforms.
//
// EVERY TOOL HERE IS GATED ON `native-device`, and so is session creation
// (`engineRequiresCapability`). Two gates for one posture is deliberate: the
// session gate is the one that cannot be reached around, and the per-tool gate is
// what `capability-gate.test.ts` enumerates.

import { SESSION_ARG } from "./schemas.js";
import { AndroidEmulatorAdapter } from "../engine/adapters/android-app/emulator.js";
import { listSimulators } from "../engine/adapters/ios/simulator.js";
import { requireNative } from "../engine/session-native.js";
import { resolveWorkspaceReadPath } from "../util/workspace.js";
import type {
  ConfigHost,
  GateHost,
  RegisterHost,
  ServerServicesHost,
  SessionHost,
  TargetHost,
  ToolResponse,
} from "./host.js";

/** The one renderer. A success body and a refusal body are both JSON text, and
 *  a refusal always carries `error` so a caller classifies it by shape. */
function json(body: object): ToolResponse {
  return { content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }] };
}

function failure(err: unknown): ToolResponse {
  return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
}

/**
 * The absolute path of the bundle `app_install` hands to adb / simctl. It must
 * sit under $BROWX_WORKSPACE, like every other file a tool reads, and its real
 * path must too. Every refusal reads the same, so the answer does not say
 * whether a path outside the workspace exists.
 */
export function resolveAppBundlePath(workspaceRoot: string, apkPath: string): string {
  const refuse = (): never => {
    throw new Error(
      `app_install: \`apkPath\` must name a bundle inside $BROWX_WORKSPACE (got "${apkPath}"). ` +
        "Copy the .apk or .app into the workspace and pass its workspace-relative path.",
    );
  };
  if (apkPath.length === 0 || apkPath.startsWith("-")) return refuse();
  try {
    return resolveWorkspaceReadPath(workspaceRoot, apkPath, "app_install");
  } catch {
    return refuse();
  }
}

/**
 * The ten device / app lifecycle tools. Named for what they do to the DEVICE and
 * to the APP, matching the vocabulary a mobile-QA agent already has
 * (`agent-device`'s `boot` / `shutdown` / `devices` / `install` / `reinstall` /
 * `apps` / `appstate` / `open` / `close`), spelled in browxai's `<noun>_<verb>`
 * convention so they sort beside the tools they compose with.
 */
export function registerNativeDeviceTools(
  host: RegisterHost & GateHost & SessionHost & TargetHost & ServerServicesHost & ConfigHost,
): void {
  const { z, register, gateCheck, entryFor, targetFor } = host;
  const emulator = (): AndroidEmulatorAdapter => new AndroidEmulatorAdapter();

  register(
    "device_list",
    {
      capability: "native-device",
      description:
        'List what there is to drive on this machine: every Android device and emulator `adb` sees, the AVDs defined here, and every iOS simulator `simctl` knows. Each Android device reports serial, state, model and API level; an `unauthorized` or `offline` device is listed with that state, since the state is what you need to act on. Each simulator reports udid, name, runtime and state. A platform that is absent (no Android SDK, no Xcode) gives an empty list and never fails the call. Takes no session: call it before `open_session({engine:"android-app"})` or `open_session({engine:"ios-app"})`. Requires the `native-device` capability (off by default).',
      inputSchema: {},
    },
    async () => {
      const g = gateCheck("device_list");
      if (g) return g;
      try {
        const adapter = emulator();
        const [devices, avds, simulators] = await Promise.all([
          adapter.devices(),
          // A missing `emulator` binary is not a failure of `device_list`: a
          // machine with a physical phone attached and no emulator installed
          // still has devices worth listing.
          adapter.avds().catch(() => []),
          // Same reasoning across the platform line: a Linux CI box has no
          // `simctl`, and an absent toolchain is an empty list for THAT platform
          // rather than a failure of the whole question.
          listSimulators().catch(() => []),
        ]);
        return json({
          ok: true,
          devices,
          avds,
          simulators,
          ready: devices.filter((d) => d.state === "device").length,
          simulatorsBooted: simulators.filter((d) => d.state === "booted").length,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );

  register(
    "device_boot",
    {
      capability: "native-device",
      description:
        "Boot an Android emulator by AVD name and wait until it is usable: `sys.boot_completed` plus a working package manager, not just an adb connection (`adb wait-for-device` returns about a minute before the launcher exists, and a session opened then sees an empty hierarchy and looks like a broken app). Headless by default. It boots with `-no-snapshot-save`, so nothing this session installs or grants persists in the AVD. browxai never creates an AVD: the system image, device profile and disk size are yours to choose. A cold boot takes 30-90 seconds. iOS needs no boot step: an `ios-app` session boots the simulator it resolves at creation. Requires the `native-device` capability (off by default).",
      inputSchema: {
        avd: z
          .string()
          .describe("AVD name, as listed by `device_list`. Must already exist on this machine."),
        headless: z
          .boolean()
          .optional()
          .describe(
            "Default true (`-no-window`). Pass false to show the emulator window, which is what you want when a human is watching the run.",
          ),
      },
    },
    async ({ avd, headless }) => {
      const g = gateCheck("device_boot");
      if (g) return g;
      try {
        const device = await emulator().boot(avd, { headless });
        return json({ ok: true, device });
      } catch (err) {
        return failure(err);
      }
    },
  );

  register(
    "device_shutdown",
    {
      capability: "native-device",
      description:
        "Shut down a running Android emulator by serial (`emu kill`). Refuses on a physical device. Closing a session does not shut a device down, because a session leases a device and does not own it, so this is the explicit teardown. There is no iOS counterpart: an `ios-app` session never shuts a simulator down, since you may have booted it and a boot costs tens of seconds. Requires the `native-device` capability (off by default).",
      inputSchema: {
        serial: z.string().describe("Emulator serial, e.g. `emulator-5554`. From `device_list`."),
      },
    },
    async ({ serial }) => {
      const g = gateCheck("device_shutdown");
      if (g) return g;
      try {
        await emulator().shutdown(serial);
        return json({ ok: true, serial, shutdown: true });
      } catch (err) {
        return failure(err);
      }
    },
  );

  register(
    "app_list",
    {
      capability: "native-device",
      description:
        "List the app ids installed on the session's device. On `android-app`, third-party only by default, because the full list is ~200 system packages of noise. On `ios-app`, `simctl listapps` reports user and runtime apps in one list with no flag to separate them, so `includeSystem` has nothing to select on and the full list is what you get. Requires the `native-device` capability (off by default) and a native session.",
      inputSchema: {
        includeSystem: z
          .boolean()
          .optional()
          .describe(
            "Include system packages too. Default false. `android-app` only — an iOS simulator does not separate the two.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ includeSystem, session }) => {
      const g = gateCheck("app_list");
      if (g) return g;
      try {
        const handle = requireNative((await entryFor(session)).session);
        const apps = await handle.lifecycle.apps(includeSystem === true);
        return json({ ok: true, device: handle.deviceId, apps });
      } catch (err) {
        return failure(err);
      }
    },
  );

  register(
    "app_install",
    {
      capability: "native-device",
      description:
        "Install an app bundle from a path under $BROWX_WORKSPACE onto the session's device: an `.apk` on `android-app`, a `.app` on `ios-app`. `reinstall` keeps the app's data (`adb install -r`); without it, installing over an existing app fails. Installing an app is the broadest thing this engine does: the bundle is arbitrary code that runs on the device with the permissions it declares, so you choose the file and the `native-device` capability says you meant to. Failures report adb's own reason (wrong ABI, insufficient storage, unsigned build). Requires the `native-device` capability (off by default) and a native session.",
      inputSchema: {
        apkPath: z
          .string()
          .describe(
            "Workspace-relative path to the bundle on the HOST machine (not the device) — a `.apk` on `android-app`, a `.app` directory on `ios-app`. It must resolve inside $BROWX_WORKSPACE, symlinks included, like every file-reading tool. Passed to adb / simctl as its own argv entry, so it is never shell-interpreted.",
          ),
        reinstall: z
          .boolean()
          .optional()
          .describe(
            "`adb install -r` — replace an existing install, keeping its data. `android-app` only: `simctl install` already replaces in place and keeps the container, so there is no second mode to select on iOS.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ apkPath, reinstall, session }) => {
      const g = gateCheck("app_install");
      if (g) return g;
      try {
        const bundle = resolveAppBundlePath(host.workspace.root, apkPath);
        const handle = requireNative((await entryFor(session)).session);
        await handle.lifecycle.install(bundle, reinstall === true);
        return json({ ok: true, apkPath, reinstalled: reinstall === true });
      } catch (err) {
        return failure(err);
      }
    },
  );

  register(
    "app_uninstall",
    {
      capability: "native-device",
      description:
        "Uninstall an app from the session's device and remove its data. `android-app` only: on `ios-app` it refuses, naming the engine, because `simctl uninstall` could remove an app installed by hand on a device the session leases and does not own. Requires the `native-device` capability (off by default) and a native session.",
      inputSchema: {
        appId: z.string().describe("Package id, e.g. `com.acme.app`."),
        ...SESSION_ARG,
      },
    },
    async ({ appId, session }) => {
      const g = gateCheck("app_uninstall");
      if (g) return g;
      try {
        const handle = requireNative((await entryFor(session)).session);
        await handle.lifecycle.uninstall(appId);
        if (handle.app?.appId === appId) handle.app = undefined;
        return json({ ok: true, appId, uninstalled: true });
      } catch (err) {
        return failure(err);
      }
    },
  );

  register(
    "app_launch",
    {
      capability: "native-device",
      description:
        "Launch an app and point the session at it. On `android-app` it resolves the declared launcher activity first, so a missing package is reported as missing (`monkey -p <pkg>` reports success having done nothing), and returns the resolved component. On `ios-app` there is no activity. The app may still be on a splash screen when this returns: follow with `snapshot`, which reports `native-hierarchy-not-idle` while a spinner keeps the window busy. Requires the `native-device` capability (off by default) and a native session.",
      inputSchema: {
        appId: z.string().describe("Package / bundle id, e.g. `com.acme.app`. See `app_list`."),
        ...SESSION_ARG,
      },
    },
    async ({ appId, session }) => {
      const g = gateCheck("app_launch");
      if (g) return g;
      try {
        const handle = requireNative((await entryFor(session)).session);
        const launched = await handle.lifecycle.launch(appId);
        handle.app = launched;
        return json({ ok: true, ...launched });
      } catch (err) {
        return failure(err);
      }
    },
  );

  register(
    "app_terminate",
    {
      capability: "native-device",
      description:
        "Stop a running app on the session's device. On `android-app` this is `am force-stop`, not `am kill`, because kill only affects background processes and silently does nothing to the foreground app. On `ios-app` it is `simctl terminate`. App data survives; use `app_reset` to clear it where the platform has that. Requires the `native-device` capability (off by default) and a native session.",
      inputSchema: {
        appId: z.string().describe("Package id to stop."),
        ...SESSION_ARG,
      },
    },
    async ({ appId, session }) => {
      const g = gateCheck("app_terminate");
      if (g) return g;
      try {
        const handle = requireNative((await entryFor(session)).session);
        await handle.lifecycle.terminate(appId);
        return json({ ok: true, appId, terminated: true });
      } catch (err) {
        return failure(err);
      }
    },
  );

  register(
    "app_reset",
    {
      capability: "native-device",
      description:
        "Clear an app's data and its granted runtime permissions so a run starts clean. This is the native counterpart of `incognito`, which a native app lacks. Destructive: logins, local databases and cached files are gone. `android-app` only: on `ios-app` it refuses, naming the engine, because iOS has no per-app data clear and `simctl erase` wipes every app on the device. Requires the `native-device` capability (off by default) and a native session.",
      inputSchema: {
        appId: z.string().describe("Package id to clear."),
        ...SESSION_ARG,
      },
    },
    async ({ appId, session }) => {
      const g = gateCheck("app_reset");
      if (g) return g;
      try {
        const handle = requireNative((await entryFor(session)).session);
        await handle.lifecycle.reset(appId);
        return json({ ok: true, appId, reset: true });
      } catch (err) {
        return failure(err);
      }
    },
  );

  register(
    "app_foreground",
    {
      capability: "native-device",
      description:
        "Report which app owns the foreground: `{appId, activity?}`, plus the `app://…` target url that the session's snapshot and secret-scope check use. `activity` is present on `android-app` and absent on `ios-app`. It answers `null` during a window transition, which is a real state and not an error. Use it to confirm a launch landed and to notice that a system permission dialog replaced the app. Requires the `native-device` capability (off by default) and a native session.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("app_foreground");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const handle = requireNative(e.session);
        const foreground = await handle.lifecycle.foreground();
        return json({
          ok: true,
          device: handle.deviceId,
          foreground,
          url: await targetFor(e).url(),
          // What the SESSION thinks it is driving, which can differ from what is
          // frontmost: a permission dialog or a share sheet takes focus without
          // the app under test changing.
          appUnderTest: handle.app ?? null,
        });
      } catch (err) {
        return failure(err);
      }
    },
  );
}
