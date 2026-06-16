import type { Exercise, ExerciseMap } from "../types.js";
import readCore from "./read-core.js";
import readData from "./read-data.js";
import actionInput from "./action-input.js";
import actionGestures from "./action-gestures.js";
import actionNetwork from "./action-network.js";
import actionStorage from "./action-storage.js";
import actionPolicy from "./action-policy.js";
import actionPerf from "./action-perf.js";
import navigation from "./navigation.js";
import workers from "./workers.js";
import fileIo from "./file-io.js";
import canvas from "./canvas.js";
import devices from "./devices.js";
import human from "./human.js";
import evalExercises from "./eval.js";
import diagnostics from "./diagnostics.js";
import networkBodySecrets from "./network-body-secrets.js";
import credentialsCaptcha from "./credentials-captcha.js";
import extensions from "./extensions.js";
import control from "./control.js";

const maps: ReadonlyArray<readonly [source: string, exercises: ExerciseMap]> = [
  ["read-core.ts", readCore],
  ["read-data.ts", readData],
  ["action-input.ts", actionInput],
  ["action-gestures.ts", actionGestures],
  ["action-network.ts", actionNetwork],
  ["action-storage.ts", actionStorage],
  ["action-policy.ts", actionPolicy],
  ["action-perf.ts", actionPerf],
  ["navigation.ts", navigation],
  ["workers.ts", workers],
  ["file-io.ts", fileIo],
  ["canvas.ts", canvas],
  ["devices.ts", devices],
  ["human.ts", human],
  ["eval.ts", evalExercises],
  ["diagnostics.ts", diagnostics],
  ["network-body-secrets.ts", networkBodySecrets],
  ["credentials-captcha.ts", credentialsCaptcha],
  ["extensions.ts", extensions],
  ["control.ts", control],
];

function mergeExercises(): Readonly<Record<string, Exercise>> {
  const merged: Record<string, Exercise> = {};
  const owner = new Map<string, string>();

  for (const [source, exercises] of maps) {
    for (const [tool, exercise] of Object.entries(exercises)) {
      const previous = owner.get(tool);
      if (previous !== undefined) {
        throw new Error(
          `capability-testbed: duplicate exercise for tool "${tool}" in ${previous} and ${source}`,
        );
      }
      owner.set(tool, source);
      merged[tool] = exercise;
    }
  }

  return Object.freeze(merged);
}

export const EXERCISES: Readonly<Record<string, Exercise>> = mergeExercises();
