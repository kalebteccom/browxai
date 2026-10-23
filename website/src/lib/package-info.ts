import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The published browxai version, read from the repo root package.json at build
 * time so the site never carries a hand-typed version. The build runs from the
 * website package, so the repo root is its parent (the same convention as
 * src/pages/[...slug].md.ts). Returns null when the file cannot be read, and
 * callers then leave the version out.
 */
export function packageVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "..", "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

export const REPO_URL = "https://github.com/kalebteccom/browxai";
export const NPM_URL = "https://www.npmjs.com/package/browxai";
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
