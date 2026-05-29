// Endpoint-parsing test — exercises the `unix://` / `pipe://` scheme
// validation that the socket transport applies. Pure hermetic, no socket
// opened.

import { describe, it, expect } from "vitest";
import { resolveEndpointPath } from "../../src/sdk/transport-socket.js";

describe("resolveEndpointPath — unix:// + pipe:// + reject-unknown", () => {
  it("unix:///tmp/browxai.sock → /tmp/browxai.sock", () => {
    expect(resolveEndpointPath("unix:///tmp/browxai.sock")).toBe("/tmp/browxai.sock");
  });

  it("pipe://./pipe/browxai → \\\\.\\pipe\\browxai (Windows named-pipe form)", () => {
    expect(resolveEndpointPath("pipe://./pipe/browxai")).toBe("\\\\.\\pipe\\browxai");
  });

  it("rejects http:// schemes with an actionable error", () => {
    expect(() => resolveEndpointPath("http://localhost:9999/")).toThrow(/unsupported endpoint scheme/);
  });

  it("rejects unix:// with an empty path", () => {
    expect(() => resolveEndpointPath("unix://")).toThrow(/empty unix:\/\/ path/);
  });

  it("rejects an empty pipe:// suffix", () => {
    expect(() => resolveEndpointPath("pipe://")).toThrow(/empty pipe:\/\/ path/);
  });
});
