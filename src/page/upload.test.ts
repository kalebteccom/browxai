import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { uploadFile } from "./upload.js";

function fakePage() {
  const setInputFiles = vi.fn(async (_files: unknown) => undefined);
  const page = {
    locator: () => ({ first: () => ({ setInputFiles }) }),
  };
  return { page, setInputFiles };
}
const refs = {} as never;
const WS = "/tmp/browx-ws";

describe("uploadFile", () => {
  it("content mode → setInputFiles with {name, mimeType, buffer}", async () => {
    const { page, setInputFiles } = fakePage();
    const r = await uploadFile(page as never, refs, WS, {
      target: { selector: "#file" } as never,
      name: "data.csv",
      mimeType: "text/csv",
      content: Buffer.from("a,b,c").toString("base64"),
    });
    expect(r).toEqual({
      ok: true,
      mode: "content",
      name: "data.csv",
      bytes: 5,
      mimeType: "text/csv",
      target: "selector #file",
      fileCount: 1,
    });
    const arg = setInputFiles.mock.calls[0]![0] as {
      name: string;
      mimeType: string;
      buffer: Buffer;
    };
    expect(arg.name).toBe("data.csv");
    expect(arg.mimeType).toBe("text/csv");
    expect(arg.buffer.toString()).toBe("a,b,c");
  });

  it("path mode inside the workspace → setInputFiles with the resolved path", async () => {
    const { page, setInputFiles } = fakePage();
    const r = await uploadFile(page as never, refs, WS, {
      target: { selector: "#file" } as never,
      path: "uploads/clip.mp4",
    });
    expect(r).toMatchObject({
      ok: true,
      mode: "path",
      name: "uploads/clip.mp4",
      target: "selector #file",
      fileCount: 1,
      bytes: 0, // file doesn't exist → best-effort 0
    });
    expect(setInputFiles).toHaveBeenCalledWith(join(WS, "uploads/clip.mp4"));
  });

  it("rejects a path that escapes the workspace", async () => {
    const { page } = fakePage();
    await expect(
      uploadFile(page as never, refs, WS, {
        target: { selector: "#f" } as never,
        path: "../../etc/passwd",
      }),
    ).rejects.toThrow(/inside \$BROWX_WORKSPACE/);
  });

  it("rejects an absolute path outside the workspace", async () => {
    const { page } = fakePage();
    await expect(
      uploadFile(page as never, refs, WS, {
        target: { selector: "#f" } as never,
        path: "/etc/hosts",
      }),
    ).rejects.toThrow(/inside \$BROWX_WORKSPACE/);
  });

  it("rejects passing both content and path", async () => {
    const { page } = fakePage();
    await expect(
      uploadFile(page as never, refs, WS, {
        target: { selector: "#f" } as never,
        content: "AA==",
        path: "x",
      }),
    ).rejects.toThrow(/exactly one/);
  });

  it("rejects passing neither", async () => {
    const { page } = fakePage();
    await expect(
      uploadFile(page as never, refs, WS, { target: { selector: "#f" } as never }),
    ).rejects.toThrow(/requires/);
  });
});
