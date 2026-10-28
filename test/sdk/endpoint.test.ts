// Endpoint-parsing test — exercises the `unix://` / `pipe://` scheme
// validation that the socket transport applies. Pure hermetic, no socket
// opened.

import { describe, it, expect } from "vitest";
import { resolveEndpointPath } from "../../src/sdk/transport-socket.js";

describe("resolveEndpointPath — unix:// + pipe:// + reject-unknown", () => {
  it.each<{ label: string; endpoint: string; path?: string; error?: RegExp }>([
    {
      label: "unix:///tmp/browxai.sock → /tmp/browxai.sock",
      endpoint: "unix:///tmp/browxai.sock",
      path: "/tmp/browxai.sock",
    },
    {
      label: "pipe://./pipe/browxai → \\\\.\\pipe\\browxai (Windows named-pipe form)",
      endpoint: "pipe://./pipe/browxai",
      path: "\\\\.\\pipe\\browxai",
    },
    {
      label: "rejects http:// schemes with an actionable error",
      endpoint: "http://localhost:9999/",
      error: /unsupported endpoint scheme/,
    },
    {
      label: "rejects unix:// with an empty path",
      endpoint: "unix://",
      error: /empty unix:\/\/ path/,
    },
  ])("$label", ({ endpoint, path, error }) => {
    if (error) expect(() => resolveEndpointPath(endpoint)).toThrow(error);
    else expect(resolveEndpointPath(endpoint)).toBe(path);
  });
});
