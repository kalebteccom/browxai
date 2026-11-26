import { describe, it, expect } from "vitest";
import { fileWriteGate } from "./file-write-gate.js";
import type { GateHost, ToolResponse } from "./host.js";

/** A gate that refuses any extra capability not in `enabled`, echoing the reason. */
function gate(enabled: string[]): { gateCheck: GateHost["gateCheck"]; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const gateCheck = ((tool: string, extra?: readonly string[], reason?: string) => {
    calls.push([tool, extra, reason]);
    const missing = (extra ?? []).find((c) => !enabled.includes(c));
    if (!missing) return null;
    const text = JSON.stringify({ ok: false, requiredCapability: missing, reason });
    return { content: [{ type: "text", text }] } as ToolResponse;
  }) as unknown as GateHost["gateCheck"];
  return { gateCheck, calls };
}

describe("fileWriteGate", () => {
  it("refuses with requiredCapability file-io and a reason naming the tool and the file", () => {
    const { gateCheck } = gate(["read", "action"]);
    const r = fileWriteGate(gateCheck, "pdf_save", "a PDF of the page");
    expect(r).not.toBeNull();
    const body = JSON.parse((r!.content[0] as { text: string }).text);
    expect(body.requiredCapability).toBe("file-io");
    expect(body.reason).toMatch(/^pdf_save writes a PDF of the page to the workspace/);
    expect(body.reason).toMatch(/BROWX_CAPABILITIES/);
  });

  it("returns null when file-io is on", () => {
    const { gateCheck, calls } = gate(["read", "action", "file-io"]);
    expect(fileWriteGate(gateCheck, "heap_snapshot", "a heap snapshot file")).toBeNull();
    expect(calls).toEqual([["heap_snapshot", ["file-io"], expect.any(String)]]);
  });
});
