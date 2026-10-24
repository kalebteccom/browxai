// Help requests are answered before any subcommand runs: `browxai chrome start
// --help` must print usage, never launch Chrome.

/** True when argv (after the program name) asks for help: a leading `help`, or
 *  `--help` / `-h` anywhere. */
export function wantsHelp(args: readonly string[]): boolean {
  return args[0] === "help" || args.some((a) => a === "--help" || a === "-h");
}
