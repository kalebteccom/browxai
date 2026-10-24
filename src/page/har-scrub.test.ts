// The close-time HAR scrub: Cookie / Set-Cookie / Authorization values are
// dropped with their names kept, and registered secrets are masked in header
// values, URLs, request bodies and text response bodies.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubHarFile } from "./har-scrub.js";
import { SecretRegistry } from "../util/secrets.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "browx-har-scrub-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

function harWith(response: Record<string, unknown>): Record<string, unknown> {
  return {
    log: {
      version: "1.2",
      entries: [
        {
          request: {
            method: "POST",
            url: "https://app.test/login?pw=hunter2",
            headers: [
              { name: "Cookie", value: "sid=abc123" },
              { name: "Authorization", value: "Bearer tok-999" },
              { name: "X-Echo", value: "hunter2" },
            ],
            cookies: [{ name: "sid", value: "abc123" }],
            queryString: [{ name: "pw", value: "hunter2" }],
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              text: "user=alice&password=hunter2",
              params: [{ name: "password", value: "hunter2" }],
            },
          },
          response: {
            status: 200,
            headers: [
              { name: "set-cookie", value: "sid=def456; HttpOnly" },
              { name: "Content-Type", value: "application/json" },
            ],
            cookies: [{ name: "sid", value: "def456" }],
            ...response,
          },
        },
      ],
    },
  };
}

function registry(): SecretRegistry {
  const r = new SecretRegistry();
  r.register({ name: "PASSWORD", value: "hunter2" });
  return r;
}

describe("scrubHarFile", () => {
  it("drops credential header values, keeps names, and masks registered values", () => {
    const path = join(ws, "run.har");
    writeFileSync(
      path,
      JSON.stringify(
        harWith({ content: { mimeType: "application/json", text: '{"echo":"hunter2"}' } }),
      ),
    );
    expect(scrubHarFile(ws, path, registry(), true)).toEqual({ scrubbed: true });
    const text = readFileSync(path, "utf8");
    for (const v of ["hunter2", "abc123", "def456", "tok-999"]) expect(text).not.toContain(v);
    const entry = JSON.parse(text).log.entries[0];
    expect(entry.request.headers).toEqual([
      { name: "Cookie", value: "" },
      { name: "Authorization", value: "" },
      { name: "X-Echo", value: "<PASSWORD>" },
    ]);
    expect(entry.request.cookies).toEqual([{ name: "sid", value: "" }]);
    expect(entry.request.url).toBe("https://app.test/login?pw=<PASSWORD>");
    expect(entry.request.postData.text).toBe("user=alice&password=<PASSWORD>");
    expect(entry.response.headers[0]).toEqual({ name: "set-cookie", value: "" });
    expect(entry.response.content.text).toBe('{"echo":"<PASSWORD>"}');
  });

  it("empties request body text and params unless network-body is on", () => {
    const path = join(ws, "form.har");
    writeFileSync(
      path,
      JSON.stringify(harWith({ content: { mimeType: "text/plain", text: "x" } })),
    );
    scrubHarFile(ws, path, null);
    const post = JSON.parse(readFileSync(path, "utf8")).log.entries[0].request.postData;
    expect(post.params).toEqual([]);
    expect(post).not.toHaveProperty("text");
    expect(post.mimeType).toBe("application/x-www-form-urlencoded");
    expect(readFileSync(path, "utf8")).not.toContain("alice");
  });

  it("keeps request body params, masked, when network-body is on", () => {
    const path = join(ws, "form-kept.har");
    writeFileSync(
      path,
      JSON.stringify(harWith({ content: { mimeType: "text/plain", text: "x" } })),
    );
    scrubHarFile(ws, path, registry(), true);
    const post = JSON.parse(readFileSync(path, "utf8")).log.entries[0].request.postData;
    expect(post.params).toEqual([{ name: "password", value: "<PASSWORD>" }]);
    expect(post.text).toBe("user=alice&password=<PASSWORD>");
  });

  it("drops credential headers even with the secrets capability off", () => {
    const path = join(ws, "nosecrets.har");
    writeFileSync(
      path,
      JSON.stringify(harWith({ content: { mimeType: "text/plain", text: "x" } })),
    );
    scrubHarFile(ws, path, null);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("tok-999");
    // Without a registry nothing else is rewritten.
    expect(text).toContain("hunter2");
  });

  it("masks a text body stored as a sidecar file next to the HAR", () => {
    const path = join(ws, "attach.har");
    writeFileSync(join(ws, "0a1b2c.json"), '{"password":"hunter2"}');
    writeFileSync(
      path,
      JSON.stringify(harWith({ content: { mimeType: "application/json", _file: "0a1b2c.json" } })),
    );
    scrubHarFile(ws, path, registry());
    expect(readFileSync(join(ws, "0a1b2c.json"), "utf8")).toBe('{"password":"<PASSWORD>"}');
  });

  it("ignores a sidecar name that is not a bare file name", () => {
    mkdirSync(join(ws, "sub"));
    const path = join(ws, "sub", "x.har");
    writeFileSync(join(ws, "outside.txt"), "hunter2");
    writeFileSync(
      path,
      JSON.stringify(harWith({ content: { mimeType: "text/plain", _file: "../outside.txt" } })),
    );
    scrubHarFile(ws, path, registry());
    expect(readFileSync(join(ws, "outside.txt"), "utf8")).toBe("hunter2");
  });

  it("reports a missing file and a zip archive without throwing", () => {
    expect(scrubHarFile(ws, join(ws, "never.har"), registry())).toEqual({
      scrubbed: false,
      reason: "missing",
    });
    expect(scrubHarFile(ws, join(ws, "bundle.zip"), registry())).toEqual({
      scrubbed: false,
      reason: "zip",
    });
  });
});
