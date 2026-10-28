// Verify the lighthouse entry of a fresh package-lock.json and print the whole resolved tree with its install scripts, so the log shows what got installed.
// Usage: node check-lock.mjs <package-lock.json> <version> <integrity>
import { readFileSync } from "node:fs";

const [lockPath, version, integrity] = process.argv.slice(2);
if (!lockPath || !version || !integrity) {
  console.error("usage: check-lock.mjs <package-lock.json> <version> <integrity>");
  process.exit(2);
}
const packages = JSON.parse(readFileSync(lockPath, "utf8")).packages ?? {};
const entry = Object.entries(packages).find(([key]) =>
  /(^|\/)node_modules\/lighthouse$/.test(key),
)?.[1];
if (!entry || entry.version !== version || entry.integrity !== integrity) {
  console.error(
    `check-lock: lighthouse is ${entry?.version} / ${entry?.integrity}, expected ${version} / ${integrity}`,
  );
  process.exit(1);
}
const rows = Object.entries(packages)
  .filter(([key]) => key !== "")
  .map(([key, p]) => {
    const note = p.hasInstallScript ? "  [has an install script, not run]" : "";
    return `  ${key.replace(/^.*node_modules\//, "")}@${p.version}${note}`;
  })
  .sort();
console.log(`lighthouse ${version}: integrity ok, ${rows.length} packages in the lockfile`);
console.log(rows.join("\n"));
