// `native-device` denials on a default server, with no device and no browser.
//
// The keystones that drive the native engines (`android-app`, `ios-app`) are
// host-gated: they skip on every CI box, because no CI box has an emulator or a
// simulator. Their denial rows skipped with them, so nothing CI runs asserted that
// a default server refuses the ten device / app tools or a native session. The
// refusal fires before any device is touched (the per-tool `gateCheck`, and the
// engine gate at session creation in `session-registry.ts`), so it is pinned here
// in the default `pnpm test` lane against a real `createServer`.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../src/server.js";
import { TOOL_CAPABILITY } from "../../src/util/capabilities.js";

type Server = Awaited<ReturnType<typeof createServer>>;

const DEFAULT_SET = "read,navigation,action,human";

/** One plausible argument bag per tool. The gate runs before any argument is read. */
const NATIVE_TOOLS: Readonly<Record<string, Record<string, unknown>>> = {
  device_list: {},
  device_boot: { avd: "Pixel_8_API_35" },
  device_shutdown: { serial: "emulator-5554" },
  app_list: { session: "native-denied" },
  app_install: { apkPath: "apps/a.apk", session: "native-denied" },
  app_uninstall: { appId: "com.acme.app", session: "native-denied" },
  app_launch: { appId: "com.acme.app", session: "native-denied" },
  app_terminate: { appId: "com.acme.app", session: "native-denied" },
  app_reset: { appId: "com.acme.app", session: "native-denied" },
  app_foreground: { session: "native-denied" },
};

let server: Server;
let workspace: string | undefined;

async function defaultServer(): Promise<Server> {
  const prevCaps = process.env.BROWX_CAPABILITIES;
  const prevWs = process.env.BROWX_WORKSPACE;
  process.env.BROWX_CAPABILITIES = DEFAULT_SET;
  workspace = mkdtempSync(join(tmpdir(), "browxai-native-denials-"));
  process.env.BROWX_WORKSPACE = workspace;
  try {
    return await createServer({ headless: true });
  } finally {
    if (prevCaps === undefined) delete process.env.BROWX_CAPABILITIES;
    else process.env.BROWX_CAPABILITIES = prevCaps;
    if (prevWs === undefined) delete process.env.BROWX_WORKSPACE;
    else process.env.BROWX_WORKSPACE = prevWs;
  }
}

beforeAll(async () => {
  server = await defaultServer();
});

afterAll(async () => {
  await server.shutdown().catch(() => undefined);
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function parse(res: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  return JSON.parse(res.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("native-device denials on a default server", () => {
  it("the table names every tool registered under native-device", () => {
    const registered = [...TOOL_CAPABILITY]
      .filter(([, cap]) => cap === "native-device")
      .map(([tool]) => tool)
      .sort();
    expect(registered).toEqual(Object.keys(NATIVE_TOOLS).sort());
  });

  it.each(Object.entries(NATIVE_TOOLS))(
    "%s is refused with requiredCapability native-device",
    async (tool, args) => {
      const body = parse(await server.handlers[tool]!(args));
      expect(body.ok).toBe(false);
      expect(body.requiredCapability).toBe("native-device");
    },
  );

  it.each(["ios-app", "android-app"])(
    'open_session({engine:"%s"}) is refused and opens no session',
    async (engine) => {
      const body = parse(await server.handlers.open_session!({ session: "native", engine }));
      expect(body.ok).toBe(false);
      expect(body.requiredCapability).toBe("native-device");
      const listed = parse(await server.handlers.list_sessions!({}));
      expect(JSON.stringify(listed)).not.toContain('"native"');
    },
  );
});
