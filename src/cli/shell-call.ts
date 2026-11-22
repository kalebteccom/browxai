// `browxai call TOOL [ARGS]`: run one tool by name against a daemon started with
// `browxai serve --socket` and print the result as one JSON document.
//
// This adds no capability and no listener. The call goes over the daemon's socket to
// the same handler every MCP client reaches, so the capability gate, the origin rules,
// the confirm hooks and the secret masking all apply there, and a refusal comes back as
// the daemon wrote it. The command keeps no state: each run opens a connection, makes
// one call and exits. Sessions and their refs live in the daemon.

import { resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parseCallArgs } from "./shell-args.js";
import { connectDaemon, DaemonUnreachableError } from "./shell-connect.js";
import { processIo, type ShellIo } from "./shell-io.js";
import { resolveArgs } from "./shell-input.js";
import { checkOutPath, writeImage } from "./shell-out.js";
import {
  buildDocument,
  type ContentItem,
  errorResult,
  EXIT,
  type ExitCode,
  type ToolResult,
} from "./shell-result.js";

/** Printed for `browxai call --help` (exit 0, from `cli.ts`) and to standard error
 *  when the arguments are wrong (exit 2). */
export const CALL_USAGE =
  "usage: browxai call TOOL [ARGS] [flags]\n" +
  "  Run one tool against a daemon started with `browxai serve --socket PATH`\n" +
  "  and print one JSON document on standard output.\n" +
  "\n" +
  "  TOOL           a tool name (`browxai tools` lists them)\n" +
  "  ARGS           the tool's arguments as one JSON object, quoted. A single -\n" +
  "                 reads them from standard input. No ARGS means {}.\n" +
  "  --args-file F  read the arguments from file F\n" +
  "  --socket PATH  the daemon's socket, or set BROWX_SOCKET. No default.\n" +
  '  --session ID   add "session" to the arguments unless they carry one, or\n' +
  "                 set BROWX_SESSION. A session in the arguments wins.\n" +
  "  --max-chars N  cut the printed result to N characters (default 40000,\n" +
  '                 0 for no cap). The document then has "truncated" set.\n' +
  "  --out FILE     write the first image of the result to FILE, owner-only.\n" +
  "                 An existing file is left alone unless --force is given.\n" +
  "  --force        overwrite the --out file\n" +
  "\n" +
  "  Anything on the command line shows up in process listings and in shell\n" +
  "  history. Pass a token or a password on standard input or in --args-file,\n" +
  "  never inline. register_secret refuses inline ARGS.\n" +
  "\n" +
  "  Output: isError, then data (the parsed result) or text, images (type and\n" +
  "  byte length, never pixels) and truncated when the result was cut.\n" +
  "  Exit codes: 0 ok, 1 the tool failed, 2 usage, 3 daemon unreachable,\n" +
  "  4 refused by a capability gate.\n" +
  "\n" +
  "  Example:\n" +
  '    browxai call navigate \'{"url":"https://example.com"}\' --socket /tmp/b.sock\n';

/** How long one call may run before the client gives up: the longest timer Node
 *  accepts. A tool has its own deadline, so the client never gives up first. */
const CALL_TIMEOUT_MS = 2_147_483_647;

/** The error codes for a dropped connection and a timeout, which are no answer from the daemon. */
const NO_ANSWER: readonly number[] = [ErrorCode.ConnectionClosed, ErrorCode.RequestTimeout];

/** A protocol error the daemon sent as the answer to a call, as an error result. A
 *  dropped connection or a timeout is not an answer, so it stays an error. */
function answeredWithError(err: unknown): ToolResult | undefined {
  if (!(err instanceof McpError) || NO_ANSWER.includes(err.code)) return undefined;
  return errorResult(err.message);
}

async function callOnce(
  client: Client,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const res = await client.callTool({ name: tool, arguments: args }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  });
  const content = (res.content as ContentItem[] | undefined) ?? [];
  return { isError: res.isError === true, content };
}

/** The handler for `browxai call`. Returns the exit code. */
export async function runCall(rest: string[], io: ShellIo = processIo()): Promise<number> {
  // Exit 2. A command line that does not parse gets the usage text with the message. A
  // problem with the arguments or the --out path gets the message alone.
  const refuse = async (message: string, withUsage = false): Promise<ExitCode> => {
    await io.stderr(`browxai call: ${message}\n${withUsage ? CALL_USAGE : ""}`);
    return EXIT.usage;
  };
  const parsed = parseCallArgs(rest, io.env);
  if (!parsed.ok) return refuse(parsed.message, true);
  const opts = parsed.value;
  const args = await resolveArgs(opts, io.input);
  if (!args.ok) return refuse(args.message);
  if (opts.out !== undefined) {
    const problem = checkOutPath(opts.out, opts.force);
    if (problem !== undefined) return refuse(problem);
  }
  const body = { ...args.value };
  if (opts.session !== undefined && body.session === undefined) body.session = opts.session;

  let client: Client;
  try {
    client = await connectDaemon(opts.socket);
  } catch (err) {
    const message = err instanceof DaemonUnreachableError ? err.message : String(err);
    await io.stderr(`browxai call: ${message}\n`);
    return EXIT.unreachable;
  }
  let result: ToolResult;
  try {
    result = await callOnce(client, opts.tool, body);
  } catch (err) {
    const answered = answeredWithError(err);
    if (answered === undefined) {
      const why = err instanceof Error ? err.message : String(err);
      await io.stderr(
        `browxai call: the connection to the daemon failed during the call (${why}). The tool may have run.\n`,
      );
      return EXIT.unreachable;
    }
    result = answered;
  } finally {
    await client.close().catch(() => undefined);
  }

  const built = buildDocument(result, opts.maxChars);
  let exitCode: ExitCode = built.exitCode;
  if (opts.out !== undefined) {
    if (built.firstImage === undefined) {
      await io.stderr("browxai call: the result has no image, so nothing was written to --out\n");
    } else {
      const problem = writeImage(opts.out, built.firstImage.data, opts.force);
      if (problem === undefined) {
        const first = built.doc.images[0];
        if (first !== undefined) first.path = resolve(opts.out);
      } else {
        await io.stderr(`browxai call: ${problem}\n`);
        exitCode = EXIT.usage;
      }
    }
  }
  await io.stdout(`${JSON.stringify(built.doc)}\n`);
  return exitCode;
}
