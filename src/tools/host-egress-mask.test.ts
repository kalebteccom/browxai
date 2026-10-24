// Tool output masks registered secrets: the `register` wrapper runs every
// result through one masking pass. Exercised through the real `buildHost`
// wrapper with stub dependencies, so no browser and no keystone.

import { describe, it, expect } from "vitest";
import { buildHost, type HostDeps } from "./host-build.js";
import { maskToolResponse, activeSecretRegistries } from "./host-egress-mask.js";
import type { ToolResponse } from "./host.js";
import { SecretRegistry } from "../util/secrets.js";

type Handler = (args: unknown) => Promise<ToolResponse>;

function hostWith(opts: { secretsOn: boolean; sessions: Array<{ secrets: SecretRegistry }> }): {
  register: (name: string, result: ToolResponse) => void;
  registerThrowing: (name: string, err: Error) => void;
  call: (name: string) => Promise<ToolResponse>;
  callOnWire: (name: string) => Promise<ToolResponse & { isError?: boolean }>;
} {
  const toolHandlers: Record<string, Handler> = {};
  const wire: Record<string, Handler> = {};
  const host = buildHost({
    server: {
      registerTool: (name: string, _def: unknown, cb: Handler) => {
        wire[name] = cb;
      },
    },
    toolHandlers,
    registry: { list: () => opts.sessions, peek: () => undefined },
    config: { testAttributes: [] },
    caps: { enabled: new Set(opts.secretsOn ? ["read", "secrets"] : ["read"]) },
    diagnostics: { enabled: false },
    pluginRecords: () => [],
  } as unknown as HostDeps);
  return {
    register: (name, result) =>
      host.register(name, { description: "wrapper probe" }, () => Promise.resolve(result)),
    registerThrowing: (name, err) =>
      host.register(name, { description: "wrapper probe" }, () => Promise.reject(err)),
    call: (name) => toolHandlers[name]!({}),
    callOnWire: (name) => wire[name]!({}),
  };
}

const text = (body: unknown): ToolResponse => ({
  content: [{ type: "text", text: JSON.stringify(body, null, 2) }],
});

describe("register wrapper — tool output masks registered secrets", () => {
  it("masks a registered value in a tool that never called the egress sanitiser", async () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "PASSWORD", value: "hunter2" });
    const h = hostWith({ secretsOn: true, sessions: [{ secrets }] });
    h.register("probe_plain", text({ ok: true, data: { field: "hunter2", n: 1 } }));
    const res = await h.call("probe_plain");
    const item = res.content[0] as { type: "text"; text: string };
    expect(item.text).not.toContain("hunter2");
    expect(JSON.parse(item.text)).toEqual({ ok: true, data: { field: "<PASSWORD>", n: 1 } });
    // Same layout as the handler produced (two-space indent).
    expect(item.text.startsWith("{\n  ")).toBe(true);
  });

  it("masks with every open session's registry", async () => {
    const a = new SecretRegistry();
    a.register({ name: "A_TOKEN", value: "tok-a-111" });
    const b = new SecretRegistry();
    b.register({ name: "B_TOKEN", value: "tok-b-222" });
    const h = hostWith({ secretsOn: true, sessions: [{ secrets: a }, { secrets: b }] });
    h.register("probe_two", text({ seen: ["tok-a-111", "tok-b-222"] }));
    const body = JSON.parse(((await h.call("probe_two")).content[0] as { text: string }).text);
    expect(body.seen).toEqual(["<A_TOKEN>", "<B_TOKEN>"]);
  });

  it("leaves results alone when the secrets capability is off", async () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "PASSWORD", value: "hunter2" });
    const h = hostWith({ secretsOn: false, sessions: [{ secrets }] });
    const result = text({ field: "hunter2" });
    h.register("probe_off", result);
    expect(await h.call("probe_off")).toBe(result);
  });

  it("masks the error text of a handler that throws", async () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "PASSWORD", value: "hunter2" });
    const h = hostWith({ secretsOn: true, sessions: [{ secrets }] });
    h.registerThrowing("probe_throws", new Error("login failed for hunter2 at step 2"));
    const res = await h.callOnWire("probe_throws");
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "login failed for <PASSWORD> at step 2" }]);
    // Composing tools still see the rejection from the in-process handler.
    await expect(h.call("probe_throws")).rejects.toThrow(/login failed/);
  });

  it("returns the same result on the wire as in process", async () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "PASSWORD", value: "hunter2" });
    const h = hostWith({ secretsOn: true, sessions: [{ secrets }] });
    h.register("probe_wire", text({ field: "hunter2" }));
    expect(await h.callOnWire("probe_wire")).toEqual(await h.call("probe_wire"));
  });

  it("returns an already-masked result as the same object", async () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "PASSWORD", value: "hunter2" });
    const h = hostWith({ secretsOn: true, sessions: [{ secrets }] });
    const result = text({ field: "<PASSWORD>" });
    h.register("probe_masked", result);
    expect(await h.call("probe_masked")).toBe(result);
  });
});

describe("maskToolResponse", () => {
  const reg = (): SecretRegistry => {
    const r = new SecretRegistry();
    r.register({ name: "PW", value: 'pa"ss\\word' });
    r.register({ name: "PIN", value: "48151623" });
    return r;
  };

  it("masks a JSON-encoded value, an object key and a number, keeping the JSON valid", () => {
    const res = text({ value: 'pa"ss\\word', pa: { 'pa"ss\\word': 1 }, pin: 48151623 });
    const out = maskToolResponse(res, [reg()]);
    const t = (out.content[0] as { text: string }).text;
    expect(t).not.toContain('pa\\"ss');
    expect(t).not.toContain("48151623");
    expect(JSON.parse(t)).toEqual({ value: "<PW>", pa: { "<PW>": 1 }, pin: "<PIN>" });
  });

  it("masks plain text and keeps compact JSON compact", () => {
    const out = maskToolResponse(
      {
        content: [
          { type: "text", text: "typed 48151623 here" },
          { type: "text", text: JSON.stringify({ pin: "48151623" }) },
        ],
      },
      [reg()],
    );
    expect((out.content[0] as { text: string }).text).toBe("typed <PIN> here");
    expect((out.content[1] as { text: string }).text).toBe('{"pin":"<PIN>"}');
  });

  it("is idempotent and passes image items through", () => {
    const image = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };
    const res: ToolResponse = { content: [{ type: "text", text: "48151623" }, image] };
    const once = maskToolResponse(res, [reg()]);
    const twice = maskToolResponse(once, [reg()]);
    expect(twice).toBe(once);
    expect(once.content[1]).toBe(image);
  });

  it("only counts sessions that hold a value", () => {
    const empty = new SecretRegistry();
    const full = reg();
    expect(activeSecretRegistries(true, [{ secrets: empty }, { secrets: full }])).toEqual([full]);
    expect(activeSecretRegistries(false, [{ secrets: full }])).toEqual([]);
  });
});
