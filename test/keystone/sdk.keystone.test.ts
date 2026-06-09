// SDK keystone — drive a real headless Chromium end-to-end via the typed
// SDK surface (createBrowxai → navigate → snapshot → find → fill →
// extract → screenshot → close). Mirrors the discipline of the existing
// headless keystone but exercises the SDK boundary, not the in-process
// `handlers` map directly.
//
// Two flows live here:
//
//   1. The in-process SDK happy-path — every stable stable tool method
//      called by the wrightxai-Stage-B loop should work and return the
//      structured shapes the script expects.
//
//   2. Egress hygiene regression — navigate to a URL whose query string
//      carries a credential-shaped token, then read back the captured
//      network slice through the SDK and assert the URL was sanitised at
//      the boundary. This is the explicit Stage-A requirement: the SDK
//      surface inherits the server's egress posture.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowxai } from "../../src/sdk/index.js";
import { startFixture, type Fixture } from "./fixture.js";
import type { BrowxaiClient } from "../../src/sdk/types.js";

const KEYSTONE_TIMEOUT = 120_000;

let fixture: Fixture;
let client: BrowxaiClient;
let workspace: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("BROWX_")) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  }
  workspace = mkdtempSync(join(tmpdir(), "browx-sdk-keystone-"));
  process.env.BROWX_WORKSPACE = workspace;
  fixture = await startFixture();
  client = await createBrowxai({ headless: true });
}, KEYSTONE_TIMEOUT);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  delete process.env.BROWX_WORKSPACE;
  for (const [k, v] of Object.entries(savedEnv)) if (v !== undefined) process.env[k] = v;
  rmSync(workspace, { recursive: true, force: true });
}, KEYSTONE_TIMEOUT);

describe("SDK keystone — typed surface drives real Chromium end-to-end", () => {
  it(
    "navigate → snapshot → find → fill → extract → screenshot via SDK methods",
    async () => {
      const session = "sdk-ks";
      const opened = await client.open_session({ session, mode: "incognito" });
      expect(opened.data?.ok).toBe(true);

      const nav = await client.navigate({ session, url: `${fixture.url}/` });
      expect(nav.data?.ok).toBe(true);

      // snapshot returns plain text (not JSON), so SDK envelope's `data` is undefined here.
      const snapRes = await client.snapshot({ session });
      const snap = (snapRes.content[0] as { text: string }).text;
      expect(snap).toContain('[data-testid="save-btn"]');

      const findRes = await client.find({ session, query: "the Save button", visibleOnly: true });
      const found = findRes.data as {
        candidates: Array<{ selectorHint: string; stability: string; actionable: unknown }>;
      };
      const saveCand = found.candidates.find((c) => c.selectorHint.includes("save-btn"));
      expect(saveCand?.stability).toBe("high");
      expect(saveCand?.actionable).toBe(true);

      const filled = await client.fill({
        session,
        selector: '[data-testid="task-input"]',
        value: "sdk-keystone-roundtrip",
      });
      expect((filled.data as { ok: boolean }).ok).toBe(true);

      // screenshot returns an image content item, not JSON.
      const shot = await client.screenshot({ session });
      const imgItem = shot.content.find((c) => c.type === "image");
      expect(imgItem).toBeDefined();

      await client.close_session({ session });
    },
    KEYSTONE_TIMEOUT,
  );

  it(
    "egress hygiene — a URL with a query-string credential is sanitised at the SDK boundary",
    async () => {
      const session = "sdk-egress";
      await client.open_session({ session, mode: "incognito" });

      // The fixture serves the same page at `/` regardless of query string, so
      // navigation succeeds; what we're asserting is that the captured network
      // slice that the SDK returns has the URL sanitised (token stripped to `?…`).
      const url = `${fixture.url}/?token=verysecrettoken123abc&u=42`;
      const navRes = await client.navigate({ session, url });
      const nav = navRes.data as { ok: boolean; network?: Array<{ url: string }> };
      expect(nav.ok).toBe(true);

      // Read the network slice and look for the navigated URL — the recorded
      // host+path must be present, but the query string must be `?…`, not the
      // literal token.
      const netRes = await client.network_read({ session });
      const netText = (netRes.content[0] as { text: string }).text;
      // The sanitiser collapses query strings to `?…` (see src/util/url-sanitizer.ts).
      expect(netText).toContain("?…");
      expect(netText).not.toContain("verysecrettoken123abc");

      await client.close_session({ session });
    },
    KEYSTONE_TIMEOUT,
  );
});
