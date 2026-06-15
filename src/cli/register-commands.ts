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
import { runDoctor } from "./doctor.js";
import { runChrome } from "./chrome.js";
import { runInit } from "./init.js";
import { runServe } from "./serve.js";
import { runPlugin } from "../plugin/cli.js";

// `runDoctor` takes no argv (it ignored `rest`); the others consume `rest`.
// `runPlugin` accepts a `ReadonlyArray<string>`, which `string[]` satisfies.
registerCommand("doctor", () => runDoctor());
registerCommand("chrome", (rest) => runChrome(rest));
registerCommand("init", (rest) => runInit(rest));
registerCommand("serve", (rest) => runServe(rest));
registerCommand("plugin", (rest) => runPlugin(rest));
