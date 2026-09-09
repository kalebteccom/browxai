// `profile_status` registration surface: the declared capability, the
// registry→probe mapping, and the capability gate. Browser-free — the session
// registry is a stub and the workspace is a temp dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSessionProfileTools } from "./session-profile-tools.js";
import type { SessionEntry } from "../session/registry.js";
import type { ToolResponse } from "./host.js";

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "browx-profstat-tool-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

interface CapturedDef {
  description: string;
  capability?: string;
  inputSchema?: z.ZodRawShape;
}
type CapturedHandler = (args: Record<string, unknown>) => Promise<ToolResponse>;

/** A fake persistent session entry: only the fields the probe mapping reads. */
function fakeEntry(id: string, profileDir: string | undefined, domains: string[]): SessionEntry {
  return {
    id,
    session: {
      profileDir,
      page: () => ({
        context: () => ({ cookies: async () => domains.map((d) => ({ domain: d })) }),
      }),
    },
  } as unknown as SessionEntry;
}

function captureTool(opts: { enabled?: boolean; entries?: SessionEntry[] } = {}): {
  def: CapturedDef;
  handler: CapturedHandler;
} {
  const defs: Record<string, CapturedDef> = {};
  const handlers: Record<string, CapturedHandler> = {};
  const host = {
    z,
    register: (name: string, def: CapturedDef, handler: CapturedHandler) => {
      defs[name] = def;
      handlers[name] = handler;
    },
    gateCheck: (tool: string) =>
      opts.enabled === false
        ? {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ok: false,
                  error: `tool "${tool}" is disabled — its capability is not in the server's ACTIVE set`,
                  requiredCapability: "read",
                }),
              },
            ],
          }
        : null,
    registry: { list: () => opts.entries ?? [] },
    workspace: { root: ws },
    okText: (body: Record<string, unknown>) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate: 1 }) }],
    }),
    errText: (tool: string, err: unknown) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            ok: false,
            tool,
            error: err instanceof Error ? err.message : String(err),
            tokensEstimate: 1,
          }),
        },
      ],
    }),
  } as unknown as Parameters<typeof registerSessionProfileTools>[0];
  registerSessionProfileTools(host);
  const def = defs.profile_status;
  const handler = handlers.profile_status;
  if (!def || !handler) throw new Error("profile_status was not registered");
  return { def, handler };
}

function bodyOf(res: ToolResponse): Record<string, unknown> {
  return JSON.parse((res.content[0] as { text: string }).text) as Record<string, unknown>;
}

function seedProfile(name: string): string {
  const dir = join(ws, "profiles", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Cookies"), "x");
  return dir;
}

describe("profile_status — registration surface", () => {
  it("declares the `read` capability", () => {
    expect(captureTool().def.capability).toBe("read");
  });

  it("states in its description that origin data is not live authentication state", () => {
    const { def } = captureTool();
    expect(def.description).toMatch(/does NOT report whether a profile is logged in/);
    expect(def.description).toMatch(/MATCHING NAME ONLY/);
  });

  it("takes an optional `profile` filter and nothing else", () => {
    const shape = captureTool().def.inputSchema ?? {};
    expect(Object.keys(shape)).toEqual(["profile"]);
    expect(shape.profile?.isOptional()).toBe(true);
  });
});

describe("profile_status — handler", () => {
  it("returns an ok envelope with a tokensEstimate on an empty workspace", async () => {
    const body = bodyOf(await captureTool().handler({}));
    expect(body.ok).toBe(true);
    expect(body.count).toBe(0);
    expect(body.profiles).toEqual([]);
    expect(body.tokensEstimate).toBe(1);
  });

  it("maps a live persistent session onto its profile row", async () => {
    const dir = seedProfile("job-search-live");
    seedProfile("job-search");
    const { handler } = captureTool({
      entries: [fakeEntry("agent-a", dir, ["mail.google.com"])],
    });
    const body = bodyOf(await handler({}));
    const profiles = body.profiles as Array<Record<string, unknown>>;
    const open = profiles.find((p) => p.name === "job-search-live");
    expect(open?.live).toMatchObject({
      sessions: ["agent-a"],
      cookieDomains: ["mail.google.com"],
    });
    expect(profiles.find((p) => p.name === "job-search")?.live).toBeUndefined();
  });

  it("drops sessions with no profile dir (incognito / attached)", async () => {
    seedProfile("only-one");
    const { handler } = captureTool({ entries: [fakeEntry("ghost", undefined, ["x.test"])] });
    const profiles = bodyOf(await handler({})).profiles as Array<Record<string, unknown>>;
    expect(profiles[0]?.live).toBeUndefined();
  });

  it("returns a structured ok:false for a path-escaping profile name", async () => {
    const body = bodyOf(await captureTool().handler({ profile: "../../etc" }));
    expect(body.ok).toBe(false);
    expect(body.tool).toBe("profile_status");
    expect(String(body.error)).toMatch(/must resolve inside \$BROWX_WORKSPACE/);
  });
});

describe("profile_status — capability gate", () => {
  it("refuses with a structured capability denial when `read` is not granted", async () => {
    seedProfile("job-search");
    const { handler } = captureTool({ enabled: false });
    const body = bodyOf(await handler({}));
    expect(body.ok).toBe(false);
    expect(body.requiredCapability).toBe("read");
    expect(String(body.error)).toContain("is disabled");
    // A denial, never a silent empty inventory.
    expect(body.profiles).toBeUndefined();
  });
});
