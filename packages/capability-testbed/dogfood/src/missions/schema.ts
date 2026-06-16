import { MANIFEST, HARNESS_CAPABILITIES } from "../../../src/harness/manifest.js";
import { EXERCISES } from "../../../src/harness/exercises/index.js";
import type { Capability } from "../../../src/harness/types.js";
import "../../../src/server/pages/index.js";
import { surfaces } from "../../../src/server/registry.js";

export type SurfaceId = ReturnType<typeof surfaces>[number]["id"];

export interface DogfoodMission {
  readonly id: string;
  readonly capabilityTags: readonly Capability[];
  readonly surfaces: readonly string[];
  readonly goal: string;
  readonly oracle: {
    readonly exerciseTools: readonly string[];
    readonly sourceFiles: readonly string[];
  };
  readonly expectedTools: readonly string[];
  readonly kRuns: number;
}

export interface CatalogValidation {
  readonly manifestTools: readonly string[];
  readonly rowBackedCapabilities: readonly string[];
  readonly rowlessCapabilities: readonly string[];
  readonly surfaces: readonly string[];
}

function setOf(values: Iterable<string>): Set<string> {
  return new Set(values);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function difference(a: Set<string>, b: Set<string>): string[] {
  return sorted([...a].filter((value) => !b.has(value)));
}

function assertKebabCase(value: string, label: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${label} must be kebab-case: ${value}`);
  }
}

function assertSubset(label: string, actual: Iterable<string>, expected: Set<string>): void {
  const extra = sorted([...actual].filter((value) => !expected.has(value)));
  if (extra.length > 0) {
    throw new Error(`${label} contains unknown values: ${extra.join(", ")}`);
  }
}

function assertSetEquals(label: string, actual: Set<string>, expected: Set<string>): void {
  const missing = difference(expected, actual);
  const extra = difference(actual, expected);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${label} mismatch` +
        (missing.length > 0 ? `; missing: ${missing.join(", ")}` : "") +
        (extra.length > 0 ? `; extra: ${extra.join(", ")}` : ""),
    );
  }
}

export function validateCatalog(catalog: readonly DogfoodMission[]): CatalogValidation {
  const manifestTools = setOf(MANIFEST.map((row) => row.tool));
  const manifestCapabilities = setOf(MANIFEST.map((row) => row.capability));
  const harnessCapabilities = setOf([...HARNESS_CAPABILITIES, "control"]);
  const surfaceIds = setOf(surfaces().map((surface) => surface.id));
  const exerciseTools = setOf(Object.keys(EXERCISES));
  const ids = new Set<string>();

  const unionExpected = new Set<string>();
  const unionSurfaces = new Set<string>();
  const unionCapabilities = new Set<string>();

  for (const mission of catalog) {
    assertKebabCase(mission.id, "mission id");
    if (ids.has(mission.id)) throw new Error(`duplicate mission id: ${mission.id}`);
    ids.add(mission.id);
    if (mission.kRuns <= 0 || !Number.isInteger(mission.kRuns)) {
      throw new Error(`mission ${mission.id} has invalid kRuns: ${mission.kRuns}`);
    }
    assertSubset(`mission ${mission.id} surfaces`, mission.surfaces, surfaceIds);
    assertSubset(
      `mission ${mission.id} capabilityTags`,
      mission.capabilityTags,
      harnessCapabilities,
    );
    assertSubset(`mission ${mission.id} expectedTools`, mission.expectedTools, manifestTools);
    assertSubset(
      `mission ${mission.id} oracle.exerciseTools`,
      mission.oracle.exerciseTools,
      exerciseTools,
    );

    for (const tool of mission.expectedTools) unionExpected.add(tool);
    for (const surface of mission.surfaces) unionSurfaces.add(surface);
    for (const capability of mission.capabilityTags) unionCapabilities.add(capability);
  }

  assertSetEquals("catalog surfaces", unionSurfaces, surfaceIds);
  assertSetEquals("catalog expectedTools", unionExpected, manifestTools);
  assertSetEquals(
    "catalog row-backed capabilityTags",
    new Set([...unionCapabilities].filter((capability) => manifestCapabilities.has(capability))),
    manifestCapabilities,
  );

  return {
    manifestTools: sorted(manifestTools),
    rowBackedCapabilities: sorted(manifestCapabilities),
    rowlessCapabilities: sorted(
      [...harnessCapabilities].filter((capability) => !manifestCapabilities.has(capability)),
    ),
    surfaces: sorted(surfaceIds),
  };
}

export function selectMissions(
  catalog: readonly DogfoodMission[],
  selected: string,
): readonly DogfoodMission[] {
  if (selected === "all") return catalog;
  const mission = catalog.find((entry) => entry.id === selected);
  if (!mission) {
    throw new Error(
      `unknown mission "${selected}"; expected one of ${catalog.map((m) => m.id).join(", ")}`,
    );
  }
  return [mission];
}
