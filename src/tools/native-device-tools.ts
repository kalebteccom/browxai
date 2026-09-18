// Device and app lifecycle for the `android-app` engine (RFC 0008 P2).
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
// EVERY TOOL HERE IS GATED ON `native-device`, and so is session creation
// (`engineRequiresCapability`). Two gates for one posture is deliberate: the
// session gate is the one that cannot be reached around, and the per-tool gate is
// what `capability-gate.test.ts` enumerates.

import { SESSION_ARG } from "./schemas.js";
import { AndroidEmulatorAdapter } from "../engine/adapters/android-app/emulator.js";
import { requireNative } from "../engine/session-native.js";
import type {
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
 * The nine device / app lifecycle tools. Named for what they do to the DEVICE and
 * to the APP, matching the vocabulary a mobile-QA agent already has
 * (`agent-device`'s `boot` / `shutdown` / `devices` / `install` / `reinstall` /
 * `apps` / `appstate` / `open` / `close`), spelled in browxai's `<noun>_<verb>`
 * convention so they sort beside the tools they compose with.
 */
export function registerNativeDeviceTools(
  host: RegisterHost & GateHost & SessionHost & TargetHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, entryFor, targetFor } = host;
  const emulator = (): AndroidEmulatorAdapter => new AndroidEmulatorAdapter();

  register(
    "device_list",
    {
      capability: "native-device",
      description:
        'List every Android device and emulator adb can see, plus the AVDs defined on this machine. Each device reports its serial, state, model and API level; a device that is `unauthorized` or `offline` is LISTED with that state rather than hidden, because the state is the actionable part. Takes no session — this is what you call BEFORE `open_session({browserType:"android-app"})` to find out what there is to drive. Requires the off-by-default `native-device` capability.',
      inputSchema: {},
    },
    async () => {
      const g = gateCheck("device_list");
      if (g) return g;
      try {
        const adapter = emulator();
        const [devices, avds] = await Promise.all([
          adapter.devices(),
          // A missing `emulator` binary is not a failure of `device_list`: a
          // machine with a physical phone attached and no emulator installed
          // still has devices worth listing.
          adapter.avds().catch(() => []),
        ]);
        return json({
          ok: true,
          devices,
          avds,
          ready: devices.filter((d) => d.state === "device").length,
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
        "Boot an Android emulator by AVD name and wait until it is USABLE — `sys.boot_completed` plus a working package manager, not merely an adb connection (`adb wait-for-device` returns about a minute before the launcher exists, and a session opened at that point dumps an empty hierarchy and looks like a broken app). Headless by default. Boots with `-no-snapshot-save`, so anything this session installs or grants never persists into the operator's AVD. browxai NEVER creates an AVD: the system image, device profile and disk allocation are the operator's choice. Can take 30-90 seconds on a cold boot. Requires `native-device`.",
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
        "Shut down a running emulator by serial (`emu kill`). REFUSES on a physical device: browxai does not power off the operator's phone. Closing a session does NOT shut a device down — a session leases a device, it does not own it — so this is the explicit teardown. Requires `native-device`.",
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
        "List the app ids installed on the session's device. Third-party only by default, because the full list is ~200 system packages of noise. Requires `native-device` and a native session.",
      inputSchema: {
        includeSystem: z
          .boolean()
          .optional()
          .describe("Include system packages too. Default false."),
        ...SESSION_ARG,
      },
    },
    async ({ includeSystem, session }) => {
      const g = gateCheck("app_list");
      if (g) return g;
      try {
        const handle = requireNative((await entryFor(session)).session);
        const apps = await handle.device.packages(includeSystem !== true);
        return json({ ok: true, serial: handle.device.serial, apps });
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
        "Install an APK from a host path onto the session's device. `reinstall` keeps the app's existing data (`adb install -r`); without it, installing over an existing app fails. INSTALLING AN APPLICATION IS THE BROADEST THING THIS ENGINE DOES — the APK is arbitrary code that then runs on the device with whatever permissions it declares, so the operator chooses the file and the `native-device` capability is what says they meant to. Reports adb's own failure reason (a wrong ABI, insufficient storage, an unsigned build) rather than a bare non-zero exit. Requires `native-device` and a native session.",
      inputSchema: {
        apkPath: z
          .string()
          .describe(
            "Path to the .apk on the HOST machine (not the device). Passed to adb as its own argv entry, so it is never shell-interpreted.",
          ),
        reinstall: z
          .boolean()
          .optional()
          .describe("`adb install -r` — replace an existing install, keeping its data."),
        ...SESSION_ARG,
      },
    },
    async ({ apkPath, reinstall, session }) => {
      const g = gateCheck("app_install");
      if (g) return g;
      try {
        const handle = requireNative((await entryFor(session)).session);
        await handle.device.install(apkPath, reinstall === true);
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
        "Uninstall an app from the session's device, removing its data with it. Requires `native-device` and a native session.",
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
        await handle.device.uninstall(appId);
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
        "Launch an app at its declared launcher activity and point the session at it. Resolves the activity first, so a missing package is reported as a missing package — `monkey -p <pkg>` reports success having done nothing. Returns the resolved component. The app may still be on a splash screen when this returns: follow with `snapshot`, which surfaces `native-hierarchy-not-idle` while an indeterminate spinner keeps the window busy. Requires `native-device` and a native session.",
      inputSchema: {
        appId: z.string().describe("Package id, e.g. `com.acme.app`. See `app_list`."),
        ...SESSION_ARG,
      },
    },
    async ({ appId, session }) => {
      const g = gateCheck("app_launch");
      if (g) return g;
      try {
        const handle = requireNative((await entryFor(session)).session);
        const activity = await handle.device.launchApp(appId);
        handle.app = { appId, activity };
        return json({ ok: true, appId, activity });
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
        "Force-stop an app on the session's device. `am force-stop`, not `am kill`: kill only targets background processes and silently no-ops on the foreground app, which would make this report success for a close that did not happen. Data survives — use `app_reset` to clear it. Requires `native-device` and a native session.",
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
        await handle.device.terminateApp(appId);
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
        "Clear an app's data AND its granted runtime permissions, so a run starts from a known state. This is the native answer to `incognito`, which an Android app has no equivalent of — there is no second browsing context to isolate into. DESTRUCTIVE: logins, local databases and cached files are gone. Requires `native-device` and a native session.",
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
        await handle.device.clearApp(appId);
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
        "Report which app owns the foreground window right now, as `{appId, activity}`, plus the `app://<package>/<activity>` target url the session's snapshot and secret-scope check use. Answers `null` during a window transition, which is a real state and not an error. This is how an agent confirms a launch landed, and how it notices the app under test was replaced by a system permission dialog. Requires `native-device` and a native session.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("app_foreground");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const handle = requireNative(e.session);
        const foreground = await handle.device.foreground();
        return json({
          ok: true,
          serial: handle.device.serial,
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
