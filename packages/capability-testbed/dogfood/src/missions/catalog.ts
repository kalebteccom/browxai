import { MANIFEST } from "../../../src/harness/manifest.js";
import type { Capability, ManifestRow } from "../../../src/harness/types.js";
import type { DogfoodMission } from "./schema.js";

const unique = (tools: readonly string[]): string[] => [...new Set(tools)];

function toolsWhere(predicate: (row: ManifestRow) => boolean): string[] {
  return unique(MANIFEST.filter(predicate).map((row) => row.tool));
}

function surfaceTools(surface: string, capabilities?: readonly Capability[]): string[] {
  const capSet = capabilities ? new Set<Capability>(capabilities) : undefined;
  return toolsWhere(
    (row) => row.surface === surface && (capSet === undefined || capSet.has(row.capability)),
  );
}

function capabilityTools(capability: Capability): string[] {
  return toolsWhere((row) => row.capability === capability);
}

function rootTools(): string[] {
  return toolsWhere((row) => row.surface === undefined);
}

function mission(input: {
  id: string;
  capabilityTags: readonly Capability[];
  surfaces: readonly string[];
  goal: string;
  sourceFiles: readonly string[];
  tools: readonly string[];
  kRuns?: number;
}): DogfoodMission {
  const expectedTools = unique(input.tools);
  return {
    id: input.id,
    capabilityTags: input.capabilityTags,
    surfaces: input.surfaces,
    goal: input.goal,
    oracle: {
      sourceFiles: input.sourceFiles,
      exerciseTools: expectedTools,
    },
    expectedTools,
    kRuns: input.kRuns ?? 5,
  };
}

export const CATALOG: readonly DogfoodMission[] = [
  mission({
    id: "core-read-control",
    capabilityTags: [
      "read",
      "navigation",
      "human",
      "eval",
      "action",
      "control",
      "diagnostics",
      "stealth",
      "byob-attach",
    ],
    surfaces: ["core"],
    goal: "Open the core surface, inspect the greeting, unique needle, fruit list, overflow box, fingerprint panel, and Ping button. Exercise navigation history, named refs or regions, recording, eval-style observation where needed, and finish with a concise report of what changed after Ping.",
    sourceFiles: [
      "read-core.ts",
      "navigation.ts",
      "human.ts",
      "eval.ts",
      "control.ts",
      "diagnostics.ts",
      "read-data.ts",
      "action-policy.ts",
    ],
    tools: [
      ...surfaceTools("/core", ["read", "navigation", "human", "eval", "action", "diagnostics"]),
      ...rootTools(),
    ],
  }),
  mission({
    id: "forms-input-providers",
    capabilityTags: ["action", "captcha", "credentials", "clipboard"],
    surfaces: ["forms"],
    goal: "Use the forms surface like a real signup workflow: fill several fields, choose a role, submit, verify the reflected JSON, exercise hover or keyboard input, and probe the provider-backed captcha or credential helpers only enough to record their structured availability.",
    sourceFiles: ["action-input.ts", "credentials-captcha.ts"],
    tools: surfaceTools("/forms"),
  }),
  mission({
    id: "dialogs-policy",
    capabilityTags: ["action"],
    surfaces: ["dialogs"],
    goal: "Visit the dialogs surface, set a dialog policy, trigger confirm or prompt behavior, and verify the page records the expected dialog outcome without hanging.",
    sourceFiles: ["action-policy.ts"],
    tools: surfaceTools("/dialogs"),
  }),
  mission({
    id: "frames-tree",
    capabilityTags: ["read"],
    surfaces: ["frames"],
    goal: "Inspect the frames surface and report the parent, children, and grandchild frame structure.",
    sourceFiles: ["read-core.ts"],
    tools: surfaceTools("/frames"),
  }),
  mission({
    id: "shadow-dom",
    capabilityTags: ["read"],
    surfaces: ["shadow"],
    goal: "Inspect the shadow DOM surface and distinguish open shadow content from closed-shadow limitations.",
    sourceFiles: ["read-core.ts"],
    tools: surfaceTools("/shadow"),
  }),
  mission({
    id: "scroll-overflow",
    capabilityTags: ["navigation"],
    surfaces: ["scroll"],
    goal: "Use the scroll surface to reach the bottom sentinel and confirm that lazy content appears.",
    sourceFiles: ["navigation.ts"],
    tools: surfaceTools("/scroll"),
  }),
  mission({
    id: "network-http-ws-secrets",
    capabilityTags: ["read", "action", "network-body", "secrets"],
    surfaces: ["network"],
    goal: "Drive the network surface through JSON fetches and the echo WebSocket. Observe network metadata, route or queue a response, send or intercept a WebSocket frame, and verify the secret endpoint body is masked after registering the secret.",
    sourceFiles: ["read-data.ts", "action-network.ts", "network-body-secrets.ts"],
    tools: surfaceTools("/network"),
  }),
  mission({
    id: "workers-and-service-worker",
    capabilityTags: ["read", "action"],
    surfaces: ["workers"],
    goal: "Use the workers surface to spawn the dedicated worker, observe its messages, register the service worker, and verify intercepted then pass-through service-worker fetch behavior.",
    sourceFiles: ["workers.ts"],
    tools: surfaceTools("/workers"),
  }),
  mission({
    id: "storage-crud-auth",
    capabilityTags: ["read", "action"],
    surfaces: ["storage"],
    goal: "Seed and inspect the storage surface, then perform representative cookie, localStorage, sessionStorage, IndexedDB, Cache API, storage-state, and auth-slot operations. Verify each operation through readback.",
    sourceFiles: ["read-data.ts", "action-storage.ts"],
    tools: surfaceTools("/storage"),
  }),
  mission({
    id: "media-files-exports",
    capabilityTags: ["file-io", "action"],
    surfaces: ["media-files"],
    goal: "Use the media and files surface to exercise upload, drop, download capture, file-picker response, page and element export, DOM and asset export, scheduled screenshots, event screenshots, PDF save, and video metadata where available.",
    sourceFiles: ["file-io.ts", "action-policy.ts"],
    tools: surfaceTools("/media-files"),
    kRuns: 3,
  }),
  mission({
    id: "permissions-and-geolocation",
    capabilityTags: ["read", "action"],
    surfaces: ["permissions"],
    goal: "Use the permissions surface to inspect permission state, grant or deny geolocation and notifications, set synthetic geolocation, and verify the page output reflects the policy.",
    sourceFiles: ["read-core.ts", "action-policy.ts"],
    tools: surfaceTools("/permissions"),
  }),
  mission({
    id: "canvas-automation",
    capabilityTags: ["canvas", "read"],
    surfaces: ["canvas"],
    goal: "Use the canvas surface to capture pixels, recolor and compare the scene, test missing-adapter canvas query behavior, map coordinates through the app transform, and draw a pointer stroke.",
    sourceFiles: ["canvas.ts"],
    tools: surfaceTools("/canvas"),
  }),
  mission({
    id: "gestures-pointer-touch",
    capabilityTags: ["action"],
    surfaces: ["gestures"],
    goal: "Use the gestures surface to drag the chip, double click, dispatch mouse movement and wheel input, and exercise touch, pinch, and swipe paths with page-visible evidence.",
    sourceFiles: ["action-gestures.ts"],
    tools: surfaceTools("/gestures"),
  }),
  mission({
    id: "devices-synthetic",
    capabilityTags: ["device-emulation"],
    surfaces: ["devices"],
    goal: "Use the devices surface to stage synthetic Bluetooth, USB, and HID devices, trigger each request button, and inspect the captured device request log.",
    sourceFiles: ["devices.ts"],
    tools: surfaceTools("/devices"),
  }),
  mission({
    id: "console-observation",
    capabilityTags: ["read"],
    surfaces: ["console"],
    goal: "Use the console surface to emit each console level and verify the console ring captures them.",
    sourceFiles: ["read-core.ts"],
    tools: surfaceTools("/console"),
  }),
  mission({
    id: "perf-diagnostics",
    capabilityTags: ["read", "action"],
    surfaces: ["perf"],
    goal: "Use the performance surface to trigger layout thrash, allocation, and compute work. Capture audits, traces, coverage, heap data, CPU throttling, clock control, random seeding, and flake checking where supported.",
    sourceFiles: ["read-core.ts", "action-perf.ts"],
    tools: surfaceTools("/perf"),
    kRuns: 3,
  }),
  mission({
    id: "extensions-browser",
    capabilityTags: ["extensions"],
    surfaces: ["core"],
    goal: "Use the core surface as a stable page while exercising browser extension lifecycle helpers: install the tiny test extension, inspect the extension list, reload or trigger it where the environment allows, and uninstall it. Preserve any headed or headless structured refusals in the final report.",
    sourceFiles: ["extensions.ts"],
    tools: capabilityTools("extensions"),
    kRuns: 3,
  }),
];
