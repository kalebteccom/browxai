// Import first in a section script: a crash in the script itself is a tool error (exit 2), never the exit 1 of a documented difference.
import { emit } from "./block.mjs";

const stop = (e) => {
  const text = String(e?.stack ?? e)
    .split("\n")
    .slice(0, 8)
    .join("\n");
  emit("FRCRASH", `section crashed (a bug in scripts/first-run, not a finding):\n${text}`);
  process.exit(2);
};
process.on("uncaughtException", stop);
process.on("unhandledRejection", stop);
