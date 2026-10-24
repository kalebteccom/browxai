import { describe, it, expect } from "vitest";
import { z } from "zod";
import { registerCaptureReportDiagnosticsTools } from "./capture-report-diagnostics-tools.js";
import type { ToolHost, ToolResponse } from "./host.js";

type Handler = (args: Record<string, unknown>) => Promise<ToolResponse>;

/** A session on a Safari-shaped engine (no network sub-interface), so the report
 *  needs no network ring: only the pieces the handler reads. */
function exportSessionReport(pageUrl: string): Handler {
  const handlers: Record<string, Handler> = {};
  const host = {
    z,
    register: (name: string, _def: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
    gateCheck: () => undefined,
    entryFor: () =>
      Promise.resolve({
        id: "s1",
        mode: "incognito",
        openedAt: 0,
        session: { engine: "safari" },
        console: { recent: () => [] },
        regions: { list: () => [] },
      }),
    targetFor: () => ({ url: () => Promise.resolve(pageUrl) }),
    registry: { list: () => [] },
    workspace: { root: "/tmp/unused" },
    diagnostics: {},
  } as unknown as ToolHost;
  registerCaptureReportDiagnosticsTools(host);
  const handler = handlers.export_session_report;
  if (!handler) throw new Error("export_session_report was not registered");
  return handler;
}

async function reportUrl(pageUrl: string): Promise<string> {
  const res = await exportSessionReport(pageUrl)({});
  const body = JSON.parse((res.content[0] as { text: string }).text) as { url: string };
  return body.url;
}

describe("export_session_report url", () => {
  it("drops the query string and fragment", async () => {
    const url = await reportUrl("https://app.example.com/cb?token=abc123&state=x#access=zzz");
    expect(url).toBe("https://app.example.com/cb?…#…");
    expect(url).not.toContain("abc123");
    expect(url).not.toContain("zzz");
  });

  it("drops userinfo", async () => {
    const url = await reportUrl("https://user:hunter2@app.example.com/home");
    expect(url).toBe("https://app.example.com/home");
    expect(url).not.toContain("hunter2");
  });

  it("patternises an identifier-shaped path segment", async () => {
    const url = await reportUrl("https://app.example.com/reset/9f8e7d6c5b4a39281706");
    expect(url).toBe("https://app.example.com/reset/:id");
  });

  it("leaves a plain URL as it was", async () => {
    expect(await reportUrl("https://app.example.com/dashboard")).toBe(
      "https://app.example.com/dashboard",
    );
  });
});
