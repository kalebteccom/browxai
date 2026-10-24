import { describe, it, expect } from "vitest";
import { holdsAskHuman, leavingAskHuman, type PolicyShape } from "./ask-human-guard.js";

describe("holdsAskHuman", () => {
  it.each<[string, PolicyShape[], boolean]>([
    [
      "is true for a top-level ask-human or any per-key ask-human",
      [{ mode: "ask-human" }, { mode: "allow", overrides: { camera: "ask-human" } }],
      true,
    ],
    [
      "is false when nothing is ask-human",
      [{ mode: "allow" }, { mode: "raise", overrides: { camera: "deny", mic: undefined } }],
      false,
    ],
  ])("%s", (_label, policies, expected) => {
    for (const policy of policies) expect(holdsAskHuman(policy)).toBe(expected);
  });
});

const KEYS = ["camera", "microphone", "geolocation"] as const;
const left = (current: PolicyShape, next: PolicyShape) => leavingAskHuman(current, next, KEYS);

describe("leavingAskHuman", () => {
  it.each<[string, Array<[PolicyShape, PolicyShape, string[]]>]>([
    [
      "is empty when nothing is ask-human today, whatever the next policy is",
      [
        [{ mode: "raise" }, { mode: "allow" }, []],
        [{ mode: "deny" }, { mode: "allow", overrides: { camera: "allow" } }, []],
      ],
    ],
    [
      "is empty when ask-human stays in place",
      [[{ mode: "ask-human" }, { mode: "ask-human" }, []]],
    ],
    [
      "flags a key a per-key override pulls out of an ask-human default",
      [[{ mode: "ask-human" }, { mode: "ask-human", overrides: { camera: "allow" } }, ["camera"]]],
    ],
    [
      "flags the top-level default and every key it covers",
      [
        [{ mode: "ask-human" }, { mode: "allow" }, ["*", "camera", "microphone", "geolocation"]],
        [{ mode: "ask-human" }, { mode: "deny" }, ["*", "camera", "microphone", "geolocation"]],
      ],
    ],
    [
      "does not flag a key whose override keeps it ask-human",
      [
        [
          { mode: "ask-human" },
          { mode: "allow", overrides: { camera: "ask-human" } },
          ["*", "microphone", "geolocation"],
        ],
      ],
    ],
    [
      "flags a per-key ask-human that the next policy replaces",
      [
        [{ mode: "raise", overrides: { camera: "ask-human" } }, { mode: "allow" }, ["camera"]],
        [
          { mode: "raise", overrides: { camera: "ask-human" } },
          { mode: "raise", overrides: { camera: "allow" } },
          ["camera"],
        ],
      ],
    ],
  ])("%s", (_label, rows) => {
    for (const [current, next, expected] of rows) expect(left(current, next)).toEqual(expected);
  });
});
