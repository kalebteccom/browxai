import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "../src/missions/catalog.js";
import { validateCatalog } from "../src/missions/schema.js";

test("catalog covers the manifest and registered surfaces", () => {
  const result = validateCatalog(CATALOG);
  assert.equal(result.manifestTools.length, 199);
  assert.ok(CATALOG.some((mission) => mission.id === "extensions-browser"));
  assert.ok(result.rowlessCapabilities.includes("byob-attach"));
});

// The registry holds 209 tools. The manifest holds 199 because these ten act on
// iOS simulators and Android emulators through the `native-device` capability,
// and this web-surface harness starts neither. The list is the whole gap.
const NATIVE_DEVICE_TOOLS = [
  "app_foreground",
  "app_install",
  "app_launch",
  "app_list",
  "app_reset",
  "app_terminate",
  "app_uninstall",
  "device_boot",
  "device_list",
  "device_shutdown",
] as const;

test("the manifest omits exactly the ten native-device tools the registry holds", () => {
  const result = validateCatalog(CATALOG);
  const inManifest = new Set(result.manifestTools);
  assert.deepEqual(
    NATIVE_DEVICE_TOOLS.filter((tool) => inManifest.has(tool)),
    [],
  );
  assert.equal(result.manifestTools.length + NATIVE_DEVICE_TOOLS.length, 209);
});
