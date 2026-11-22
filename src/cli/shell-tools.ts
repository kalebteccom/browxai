// `browxai tools [NAME]`: say which tools there are, so an agent with a shell can pick
// one before it runs `browxai call`.
//
// With no name it prints one line per tool: the name, the capability it needs and a
// one-line description. Against a daemon (`--socket`, or BROWX_SOCKET) the list is what
// the daemon's `tools/list` reports, so `toolList`, `toolProfile` and plugin tools are
// respected. With no socket it lists every tool this install registers, and says so on
// standard error. With a name it prints that tool's full description and input schema
// from this install's own registration table, with no daemon needed.

import { z } from "zod";
import { collectToolMetadata } from "../tools/tool-metadata.js";
import type { ToolRegistration } from "../tools/host.js";
import { parseToolsArgs } from "./shell-args.js";
import { connectDaemon, DaemonUnreachableError } from "./shell-connect.js";
import { processIo, settle, type ShellIo } from "./shell-io.js";
import { CAPABILITY_META_KEY, toolRow, type ToolRow } from "./serve-listing.js";
import { EXIT, type ExitCode } from "./shell-result.js";

/** Printed for `browxai tools --help` (exit 0, from `cli.ts`) and to standard error
 *  when the arguments are wrong (exit 2). */
export const TOOLS_USAGE =
  "usage: browxai tools [NAME] [--socket PATH] [--json]\n" +
  "  With no NAME, print one line per tool: its name, the capability it needs\n" +
  "  and a one-line description. With a daemon (--socket PATH, or set\n" +
  "  BROWX_SOCKET) the list is what that daemon reports, so its tool list\n" +
  "  setting, its tool profile and its plugin tools apply. With no socket it\n" +
  "  lists every tool this install registers and says so on standard error.\n" +
  "  With a NAME, print that tool's full description and input schema. That\n" +
  "  needs no daemon.\n" +
  "\n" +
  "  --socket PATH  the daemon's socket. No default, and nothing is searched for.\n" +
  "  --json         print the answer as one JSON document\n" +
  "\n" +
  "  Exit codes: 0 ok, 2 usage, 3 daemon unreachable.\n" +
  "\n" +
  "  Example:\n" +
  "    browxai tools --socket /tmp/b.sock\n" +
  "    browxai tools click\n";

const NO_SOCKET_NOTE =
  "browxai tools: no socket given, so this lists every tool this install registers, " +
  "not the tools a daemon reports. Pass --socket PATH (or set BROWX_SOCKET) for those.\n";

/** The rows for every tool this install registers, by name. */
function localRows(): ToolRow[] {
  return [...collectToolMetadata()]
    .map(([name, reg]) => toolRow(name, reg))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The rows a daemon's `tools/list` reports, by name. */
async function daemonRows(socket: string | undefined): Promise<ToolRow[]> {
  const client = await connectDaemon(socket);
  try {
    const listed = await client.listTools();
    return listed.tools
      .map((tool) => {
        const capability = tool._meta?.[CAPABILITY_META_KEY];
        return {
          name: tool.name,
          capability: typeof capability === "string" ? capability : "unknown",
          description: tool.description ?? "",
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** One line per row, the name and capability columns padded to align. */
export function formatRows(rows: readonly ToolRow[]): string {
  if (rows.length === 0) return "no tools listed\n";
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const capWidth = Math.max(...rows.map((r) => r.capability.length));
  const lines = rows.map(
    (r) => `${r.name.padEnd(nameWidth)}  ${r.capability.padEnd(capWidth)}  ${r.description}`,
  );
  return `${lines.join("\n")}\n`;
}

/** A tool's input schema as JSON Schema, or undefined when it cannot be converted. */
function inputSchemaOf(reg: ToolRegistration): Record<string, unknown> | undefined {
  try {
    const shape = reg.inputSchema ?? {};
    const schema: Record<string, unknown> = {
      ...z.toJSONSchema(z.object(shape), { unrepresentable: "any", io: "input" }),
    };
    delete schema.$schema;
    return schema;
  } catch {
    return undefined;
  }
}

/** The text `browxai tools NAME` prints. */
export function formatTool(name: string, reg: ToolRegistration): string {
  const row = toolRow(name, reg);
  const schema = inputSchemaOf(reg);
  const shown =
    schema === undefined
      ? "(the input schema could not be converted: see docs/tool-reference.md)"
      : JSON.stringify(schema, null, 2);
  return `${name} (capability: ${row.capability})\n\n${reg.description}\n\ninput schema:\n${shown}\n`;
}

async function describeTool(name: string, json: boolean, io: ShellIo): Promise<ExitCode> {
  const reg = collectToolMetadata().get(name);
  if (reg === undefined) {
    await io.stderr(
      `browxai tools: no tool named ${name} in this install. A plugin tool is listed by ` +
        "`browxai tools --socket PATH`, and its description comes from its plugin.\n",
    );
    return EXIT.usage;
  }
  if (json) {
    const row = toolRow(name, reg);
    const doc = {
      name,
      capability: row.capability,
      description: reg.description,
      inputSchema: inputSchemaOf(reg) ?? null,
    };
    await io.stdout(`${JSON.stringify(doc)}\n`);
  } else {
    await io.stdout(formatTool(name, reg));
  }
  return EXIT.ok;
}

/** The handler for `browxai tools`. Returns the exit code. */
export async function runTools(rest: string[], io: ShellIo = processIo()): Promise<number> {
  return settle(io, await runToolsCommand(rest, io));
}

async function runToolsCommand(rest: string[], io: ShellIo): Promise<number> {
  const parsed = parseToolsArgs(rest, io.env);
  if (!parsed.ok) {
    await io.stderr(`browxai tools: ${parsed.message}\n${TOOLS_USAGE}`);
    return EXIT.usage;
  }
  const { name, socket, json } = parsed.value;
  if (name !== undefined) return describeTool(name, json, io);
  let rows: ToolRow[];
  let source: "daemon" | "local";
  if (socket === undefined) {
    await io.stderr(NO_SOCKET_NOTE);
    rows = localRows();
    source = "local";
  } else {
    try {
      rows = await daemonRows(socket);
      source = "daemon";
    } catch (err) {
      const message = err instanceof DaemonUnreachableError ? err.message : String(err);
      await io.stderr(`browxai tools: ${message}\n`);
      return EXIT.unreachable;
    }
  }
  await io.stdout(json ? `${JSON.stringify({ source, tools: rows })}\n` : formatRows(rows));
  return EXIT.ok;
}
