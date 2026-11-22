import { describe, expect, it } from "vitest";
import type { ToolRow } from "./serve-listing.js";
import type { ShellIo } from "./shell-io.js";
import { formatRows, runTools } from "./shell-tools.js";

function fakeIo(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: ShellIo = {
    env,
    stdout: (t) => Promise.resolve(void out.push(t)),
    stderr: (t) => Promise.resolve(void err.push(t)),
    input: { readStdin: () => Promise.resolve(""), readFile: () => "" },
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

const row = (name: string, capability: string, description: string): ToolRow => ({
  name,
  capability,
  description,
});

describe("formatRows", () => {
  it("prints one aligned line per tool: name, capability, description", () => {
    const text = formatRows([
      row("click", "action", "Click an element."),
      row("list_sessions", "none", "List the open sessions."),
    ]);
    expect(text).toBe(
      "click          action  Click an element.\n" +
        "list_sessions  none    List the open sessions.\n",
    );
  });

  it("says so when there is nothing to list", () => {
    expect(formatRows([])).toBe("no tools listed\n");
  });
});

describe("browxai tools with no daemon", () => {
  it("lists every tool this install registers and says so on standard error", async () => {
    const { io, out, err } = fakeIo();
    expect(await runTools([], io)).toBe(0);
    expect(err()).toContain("no socket given");
    const lines = out().trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(100);
    const click = lines.find((l) => l.startsWith("click "));
    expect(click).toMatch(/^click\s+action\s+\S/);
    expect(out()).not.toMatch(/browxai\/click/);
  });

  it("prints the list as one JSON document with --json", async () => {
    const { io, out } = fakeIo();
    expect(await runTools(["--json"], io)).toBe(0);
    const doc = JSON.parse(out()) as { source: string; tools: ToolRow[] };
    expect(doc.source).toBe("local");
    const snapshot = doc.tools.find((t) => t.name === "snapshot");
    expect(snapshot?.capability).toBe("read");
    expect(snapshot?.description.length).toBeGreaterThan(0);
  });

  it("prints a tool's full description and input schema", async () => {
    const { io, out } = fakeIo();
    expect(await runTools(["click"], io)).toBe(0);
    expect(out()).toMatch(/^click \(capability: action\)\n\n/);
    expect(out()).toContain("input schema:\n{");
  });

  it("prints a tool as JSON with its schema", async () => {
    const { io, out } = fakeIo();
    expect(await runTools(["click", "--json"], io)).toBe(0);
    const doc = JSON.parse(out()) as {
      name: string;
      capability: string;
      inputSchema: { type: string; properties: Record<string, unknown> };
    };
    expect(doc.name).toBe("click");
    expect(doc.capability).toBe("action");
    expect(doc.inputSchema.type).toBe("object");
    expect(Object.keys(doc.inputSchema.properties)).toContain("ref");
  });

  it("exits 2 for a tool this install does not register", async () => {
    const { io, out, err } = fakeIo();
    expect(await runTools(["no_such_tool"], io)).toBe(2);
    expect(out()).toBe("");
    expect(err()).toContain("no tool named no_such_tool");
  });

  it("exits 2 with the usage for an unknown flag", async () => {
    const { io, out, err } = fakeIo();
    expect(await runTools(["--bogus"], io)).toBe(2);
    expect(out()).toBe("");
    expect(err()).toContain('unknown argument "--bogus"');
    expect(err()).toContain("usage: browxai tools");
  });
});

describe("browxai tools with a socket that is not there", () => {
  it("exits 3 and names the path", async () => {
    const { io, out, err } = fakeIo();
    const path = "/tmp/browxai-no-such-daemon.sock";
    expect(await runTools(["--socket", path], io)).toBe(3);
    expect(out()).toBe("");
    expect(err()).toContain(path);
  });

  it("reads the socket from BROWX_SOCKET", async () => {
    const path = "/tmp/browxai-no-such-daemon-env.sock";
    const { io, err } = fakeIo({ BROWX_SOCKET: path });
    expect(await runTools([], io)).toBe(3);
    expect(err()).toContain(path);
  });
});
