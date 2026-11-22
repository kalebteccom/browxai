// Argument parsing for `browxai call` and `browxai tools`. Pure: nothing here reads a
// file, the environment or standard input. The caller passes the environment in, and
// `shell-input.ts` turns the parsed values into a JSON object.

/** Where `browxai call` and `browxai tools` look for the daemon's socket when no
 *  `--socket` is given. There is no default path and no search. */
export const SOCKET_ENV = "BROWX_SOCKET";
/** The session id `browxai call` adds to the arguments when neither `--session` nor
 *  the arguments carry one. */
export const SESSION_ENV = "BROWX_SESSION";
/** The default cap on the printed result, in characters. */
export const DEFAULT_MAX_CHARS = 40_000;

/** A tool name: letters, digits, `_`, `-` and `.` (a plugin tool is `namespace.tool`). */
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
// The text of a bad argument is never echoed: a caller that pasted its JSON in the wrong
// place would print it.
const NOT_A_TOOL_NAME = "TOOL must be a tool name: letters, digits, _, - and .";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

interface FlagSpec {
  /** Flags that take a value: `--socket PATH` or `--socket=PATH`. */
  readonly values: readonly string[];
  /** Flags that stand alone. */
  readonly bools: readonly string[];
}

interface RawArgs {
  readonly values: ReadonlyMap<string, string>;
  readonly bools: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

/** Split argv into flags and positionals. A lone `-` is a positional (the standard
 *  input marker). An unknown flag, or a value flag with no value, is an error. */
function splitArgs(args: readonly string[], spec: FlagSpec): Parsed<RawArgs> {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  // cap: one pass over argv, `i` moves forward on every iteration.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (spec.bools.includes(name) && eq === -1) {
      bools.add(name);
    } else if (spec.values.includes(name)) {
      const value = eq === -1 ? args[i + 1] : arg.slice(eq + 1);
      if (value === undefined || (eq === -1 && value.startsWith("--"))) {
        return { ok: false, message: `${name} needs a value` };
      }
      if (eq === -1) i++;
      values.set(name, value);
    } else {
      return { ok: false, message: `unknown argument "${name}"` };
    }
  }
  return { ok: true, value: { values, bools, positionals } };
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

export interface CallArgs {
  readonly tool: string;
  /** The inline JSON text, or `-` for standard input. */
  readonly argsText: string | undefined;
  readonly argsFile: string | undefined;
  readonly socket: string | undefined;
  readonly session: string | undefined;
  /** 0 means no cap. */
  readonly maxChars: number;
  readonly out: string | undefined;
  readonly force: boolean;
}

const CALL_FLAGS: FlagSpec = {
  values: ["--socket", "--session", "--args-file", "--max-chars", "--out"],
  bools: ["--force"],
};

function parseMaxChars(raw: string | undefined): Parsed<number> {
  if (raw === undefined) return { ok: true, value: DEFAULT_MAX_CHARS };
  if (!/^\d+$/.test(raw)) {
    return { ok: false, message: "--max-chars takes a whole number of characters (0 for no cap)" };
  }
  return { ok: true, value: Number(raw) };
}

/** Parse the arguments after `call`. `env` supplies the socket and session fallbacks. */
export function parseCallArgs(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Parsed<CallArgs> {
  const split = splitArgs(args, CALL_FLAGS);
  if (!split.ok) return split;
  const { values, bools, positionals } = split.value;
  const [tool, argsText, ...extra] = positionals;
  if (tool === undefined) return { ok: false, message: "missing TOOL" };
  if (!TOOL_NAME.test(tool)) return { ok: false, message: NOT_A_TOOL_NAME };
  if (extra.length > 0) {
    return { ok: false, message: "give the arguments as one JSON object, quoted" };
  }
  if (argsText !== undefined && values.has("--args-file")) {
    return {
      ok: false,
      message: "give the arguments inline, on standard input, or in --args-file",
    };
  }
  const maxChars = parseMaxChars(values.get("--max-chars"));
  if (!maxChars.ok) return maxChars;
  if (bools.has("--force") && !values.has("--out")) {
    return { ok: false, message: "--force only applies with --out" };
  }
  return {
    ok: true,
    value: {
      tool,
      argsText,
      argsFile: values.get("--args-file"),
      socket: clean(values.get("--socket")) ?? clean(env[SOCKET_ENV]),
      session: clean(values.get("--session")) ?? clean(env[SESSION_ENV]),
      maxChars: maxChars.value,
      out: values.get("--out"),
      force: bools.has("--force"),
    },
  };
}

export interface ToolsArgs {
  readonly name: string | undefined;
  readonly socket: string | undefined;
  readonly json: boolean;
}

const TOOLS_FLAGS: FlagSpec = { values: ["--socket"], bools: ["--json"] };

/** Parse the arguments after `tools`. */
export function parseToolsArgs(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Parsed<ToolsArgs> {
  const split = splitArgs(args, TOOLS_FLAGS);
  if (!split.ok) return split;
  const { values, bools, positionals } = split.value;
  const [name, ...extra] = positionals;
  if (extra.length > 0) return { ok: false, message: "give at most one tool name" };
  if (name !== undefined && !TOOL_NAME.test(name)) return { ok: false, message: NOT_A_TOOL_NAME };
  return {
    ok: true,
    value: {
      name,
      socket: clean(values.get("--socket")) ?? clean(env[SOCKET_ENV]),
      json: bools.has("--json"),
    },
  };
}
