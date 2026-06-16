#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dogfoodRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(dogfoodRoot, "..");

const build = spawnSync("pnpm", ["run", "dogfood:build"], {
  cwd: packageRoot,
  stdio: "inherit",
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

process.chdir(packageRoot);
const { main } = await import("../dist/dogfood/src/haiku.js");
const code = await main(process.argv.slice(2));
process.exit(code);
