// CLI subcommand registry (RFC 0004 P4 / D6) — the add-only
// `Map<string, CommandHandler>` that replaces the extensibility arms of the
// `switch (subcommand)` in `src/cli.ts`.
//
// Scope: this registry owns the EXTENSIBILITY subcommands — the ones a future
// command would be added alongside (`doctor` / `chrome` / `init` / `serve` /
// `plugin`). The `--version` / `--help` literal fast paths and the
// `undefined` / `--engine` server-fallthrough stay inline in `cli.ts`: they are
// not "another subcommand", they are the bin's own argv shape (a help flag and
// the default server path), so registry-ifying them would be miscategorising a
// fixed CLI contract as an open extension point.
//
// Each handler takes the post-subcommand argv (`rest`) and returns the process
// exit code, exactly as the old `runDoctor()` / `runChrome(rest)` / ... calls
// did. The dispatcher resolves the SAME handler the `case` did — `cli.ts`
// behavior (`browxai doctor`, `browxai plugin …`, etc.) is unchanged.

/** A subcommand handler: receives the argv after the subcommand token, returns
 *  the process exit code. */
export type CommandHandler = (rest: string[]) => Promise<number>;

const COMMANDS = new Map<string, CommandHandler>();

/** Register a subcommand handler. Add-only: a new command is one
 *  `registerCommand(...)` call, never a new `case` in `cli.ts`. */
export function registerCommand(name: string, handler: CommandHandler): void {
  COMMANDS.set(name, handler);
}

/** Resolve a subcommand handler, or `undefined` when the token is not a
 *  registered subcommand (the caller then applies the literal `--version` /
 *  `--help` / `--engine` / server-fallthrough rules — the same precedence the
 *  old `switch` encoded by case order). */
export function commandFor(name: string): CommandHandler | undefined {
  return COMMANDS.get(name);
}

/** The registered subcommand names, in registration order — used by `cli.ts`'s
 *  unknown-subcommand diagnostic so the "Valid: …" list stays in lockstep with
 *  the registry (no second hand-maintained list to drift). */
export function registeredCommands(): string[] {
  return [...COMMANDS.keys()];
}
