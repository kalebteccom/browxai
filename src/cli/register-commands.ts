// CLI subcommand registrations (RFC 0004 P4 / D6) — the one place the
// extensibility subcommands are wired into the registry. Importing this module
// for its side effect populates `command-registry.ts`'s map; `cli.ts` then
// dispatches through `commandFor(subcommand)` instead of a `switch`.
//
// Adding a subcommand is add-only: write its `runXxx(rest)` handler, then add a
// single `registerCommand("xxx", runXxx)` line here — no edit to the dispatch in
// `cli.ts`. Each registration binds the SAME handler the old `case` invoked, so
// the dispatch is byte-identical.

import { registerCommand } from "./command-registry.js";
import { runDoctor, DOCTOR_USAGE } from "./doctor.js";
import { runChrome, CHROME_USAGE } from "./chrome.js";
import { runInit, INIT_USAGE } from "./init.js";
import { runServe, SERVE_USAGE } from "./serve.js";
import { runCall, CALL_USAGE } from "./shell-call.js";
import { runTools, TOOLS_USAGE } from "./shell-tools.js";
import { runBridge, BRIDGE_USAGE } from "./bridge.js";
import { runPlugin } from "../plugin/cli.js";

// Each handler consumes `rest` (`runDoctor` reads `--verbose`). `tools` and `call` are the
// shell route: clients of a `serve --socket` daemon, with no listener of their own.
// `bridge` is the same kind of client for an MCP client: stdio on one side, the daemon's
// socket on the other.
// `runPlugin` accepts a `ReadonlyArray<string>`, which `string[]` satisfies.
// The third argument is the text `browxai <name> --help` prints. `plugin` has
// none: it prints its own help when `cli.ts` hands it the `help` verb.
registerCommand("doctor", (rest) => runDoctor(rest), DOCTOR_USAGE);
registerCommand("chrome", (rest) => runChrome(rest), CHROME_USAGE);
registerCommand("init", (rest) => runInit(rest), INIT_USAGE);
registerCommand("serve", (rest) => runServe(rest), SERVE_USAGE);
registerCommand("tools", (rest) => runTools(rest), TOOLS_USAGE);
registerCommand("call", (rest) => runCall(rest), CALL_USAGE);
registerCommand("bridge", (rest) => runBridge(rest), BRIDGE_USAGE);
registerCommand("plugin", (rest) => runPlugin(rest, process.cwd()));
