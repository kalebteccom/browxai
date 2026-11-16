// Help requests are answered before any subcommand runs: `browxai chrome start
// --help` must print the chrome usage, never launch Chrome.

/** True when argv (after the program name) asks for help: a leading `help`, or
 *  `--help` / `-h` anywhere. */
export function wantsHelp(args: readonly string[]): boolean {
  return args[0] === "help" || args.some((a) => a === "--help" || a === "-h");
}

/** Which subcommand's usage a help request asks for, or `undefined` for the
 *  top-level text. `<sub> ... --help` and `help <sub>` name `<sub>` when it is
 *  a registered subcommand; anything else (`--help`, `help`, `help nope`,
 *  `--engine firefox --help`) is top-level help. Call it when `wantsHelp` is
 *  true. */
export function helpTarget(
  args: readonly string[],
  isCommand: (name: string) => boolean,
): string | undefined {
  const name = args[0] === "help" ? args[1] : args[0];
  return name !== undefined && isCommand(name) ? name : undefined;
}
