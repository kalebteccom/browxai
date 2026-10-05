import { describe, it, expect } from "vitest";
import { holdsAskHuman, leavingAskHuman, type PolicyShape } from "./ask-human-guard.js";

describe("holdsAskHuman", () => {
  it("is true for a top-level ask-human or any per-key ask-human", () => {
    expect(holdsAskHuman({ mode: "ask-human" })).toBe(true);
    expect(holdsAskHuman({ mode: "allow", overrides: { camera: "ask-human" } })).toBe(true);
  });

  it("is false when nothing is ask-human", () => {
    expect(holdsAskHuman({ mode: "allow" })).toBe(false);
    expect(holdsAskHuman({ mode: "raise", overrides: { camera: "deny", mic: undefined } })).toBe(
      false,
    );
  });
});

const KEYS = ["camera", "microphone", "geolocation"] as const;
const left = (current: PolicyShape, next: PolicyShape) => leavingAskHuman(current, next, KEYS);

describe("leavingAskHuman", () => {
  it("is empty when nothing is ask-human today, whatever the next policy is", () => {
    expect(left({ mode: "raise" }, { mode: "allow" })).toEqual([]);
    expect(left({ mode: "deny" }, { mode: "allow", overrides: { camera: "allow" } })).toEqual([]);
  });

  it("is empty when ask-human stays in place", () => {
    expect(left({ mode: "ask-human" }, { mode: "ask-human" })).toEqual([]);
  });

  it("flags a key a per-key override pulls out of an ask-human default", () => {
    expect(
      left({ mode: "ask-human" }, { mode: "ask-human", overrides: { camera: "allow" } }),
    ).toEqual(["camera"]);
  });

  it("flags the top-level default and every key it covers", () => {
    expect(left({ mode: "ask-human" }, { mode: "allow" })).toEqual([
      "*",
      "camera",
      "microphone",
      "geolocation",
    ]);
    expect(left({ mode: "ask-human" }, { mode: "deny" })).toContain("*");
  });

  it("does not flag a key whose override keeps it ask-human", () => {
    expect(
      left({ mode: "ask-human" }, { mode: "allow", overrides: { camera: "ask-human" } }),
    ).toEqual(["*", "microphone", "geolocation"]);
  });

  it("flags a per-key ask-human that the next policy replaces", () => {
    const current: PolicyShape = { mode: "raise", overrides: { camera: "ask-human" } };
    expect(left(current, { mode: "allow" })).toEqual(["camera"]);
    expect(left(current, { mode: "raise", overrides: { camera: "allow" } })).toEqual(["camera"]);
  });

  it("allows tightening or adding ask-human, and keeping a per-key ask-human", () => {
    const current: PolicyShape = { mode: "raise", overrides: { camera: "ask-human" } };
    expect(left(current, { mode: "allow", overrides: { camera: "ask-human" } })).toEqual([]);
    expect(left({ mode: "allow" }, { mode: "ask-human" })).toEqual([]);
  });

  it("treats an undefined override as absent", () => {
    expect(
      left(
        { mode: "ask-human", overrides: { camera: undefined } },
        { mode: "ask-human", overrides: { camera: undefined } },
      ),
    ).toEqual([]);
  });
});
