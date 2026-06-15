// `browxai plugin` subcommand registry (RFC 0004 P4 / D6) — the add-only
// `Map<string, PluginCommandHandler>` that replaces the extensibility arms of
// the `switch (sub)` in `runPlugin` (`plugin/cli.ts`).
//
// Scope: the EXTENSIBILITY verbs (`install` / `remove` / `list` / `info` /
// `upgrade` / `sync`) — the ones a future verb is added alongside. The
// `undefined` / `help` / `--help` / `-h` help branch and the unknown-verb
// diagnostic stay inline in `runPlugin`: they are the subcommand's fixed CLI
// contract, not extension points. Each handler receives the argv after the verb
// token (`rest`) and returns the exit code, owning its OWN argument validation
// (the `install`/`remove`/`info` missing-arg checks moved into their handlers),
// so the dispatch resolves the SAME handler the old `case` did.

/** A plugin subcommand handler: receives the argv after the verb token, returns
 *  the process exit code. */
export type PluginCommandHandler = (rest: string[]) => Promise<number> | number;

const PLUGIN_COMMANDS = new Map<string, PluginCommandHandler>();

/** Register a plugin subcommand handler. Add-only: a new verb is one
 *  `registerPluginCommand(...)` call, never a new `case` in `runPlugin`. */
export function registerPluginCommand(name: string, handler: PluginCommandHandler): void {
  PLUGIN_COMMANDS.set(name, handler);
}

/** Resolve a plugin subcommand handler, or `undefined` when the token is not a
 *  registered verb (the caller then runs the help / unknown-verb path). */
export function pluginCommandFor(name: string): PluginCommandHandler | undefined {
  return PLUGIN_COMMANDS.get(name);
}
