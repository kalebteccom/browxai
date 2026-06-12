// Host package version — read once, synchronously, from package.json.
//
// The MCP handshake, the SDK client identities, and the plugin runtime's
// host-version advisory all report this value. Deriving it from
// package.json at module load means the version CANNOT drift from the
// published one (the old hand-maintained constant shipped a 0.1.0
// handshake on a 0.7.0 package).
//
// `createRequire` keeps the read synchronous and bundler-free. dist/ is
// built by plain tsc (no bundler — see tsconfig.build.json), so the
// compiled file lives at `dist/util/version.js` and `../../package.json`
// resolves to the package root both there and from `src/util/` under tsx.
// npm always includes package.json in the published tarball.

import { createRequire } from "node:module";

const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere("../../package.json") as { version?: unknown };

if (typeof pkg.version !== "string" || pkg.version.length === 0) {
  throw new Error("browxai: package.json#version missing or empty — corrupt install");
}

/** The browxai package version (package.json#version) — single source of truth. */
export const PACKAGE_VERSION: string = pkg.version;
