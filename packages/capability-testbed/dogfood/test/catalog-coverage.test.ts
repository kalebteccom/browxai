import test from "node:test";
import assert from "node:assert/strict";
import { CATALOG } from "../src/missions/catalog.js";
import { validateCatalog } from "../src/missions/schema.js";

test("catalog covers the manifest and registered surfaces", () => {
  const result = validateCatalog(CATALOG);
  assert.equal(result.manifestTools.length, 198);
  assert.ok(CATALOG.some((mission) => mission.id === "extensions-browser"));
  assert.ok(result.rowlessCapabilities.includes("byob-attach"));
});
