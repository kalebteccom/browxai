import { describe, it, expect } from "vitest";
import { EngineCapabilityRefused, engineCapabilityRefusal } from "./engine-capability-gate.js";
import type { GateCheck } from "./ask-human-gate.js";
import type { ToolResponse } from "./host.js";

function recordingGate(): { gateCheck: GateCheck; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const gateCheck = ((tool: string, extra?: readonly string[], reason?: string) => {
    calls.push([tool, extra, reason]);
    const text = JSON.stringify({ ok: false, requiredCapability: extra?.[0], reason });
    return { content: [{ type: "text", text }] } as ToolResponse;
  }) as unknown as GateCheck;
  return { gateCheck, calls };
}

describe("engineCapabilityRefusal", () => {
  it("turns the session factory's refusal into the gate refusal for its capability", () => {
    const { gateCheck, calls } = recordingGate();
    const err = new EngineCapabilityRefused(
      "capability-required: needs native-device",
      "native-device",
    );
    const res = engineCapabilityRefusal(gateCheck, err);
    expect(calls).toEqual([
      ["open_session", ["native-device"], "capability-required: needs native-device"],
    ]);
    const body = JSON.parse((res!.content[0] as { text: string }).text);
    expect(body.requiredCapability).toBe("native-device");
  });

  it("leaves any other error alone", () => {
    const { gateCheck, calls } = recordingGate();
    expect(engineCapabilityRefusal(gateCheck, new Error("capability-required: x"))).toBeNull();
    expect(calls).toEqual([]);
  });
});
