// `browxai plugin install file:<dir>` — resolve the directory and read the
// package name from its own package.json. The package manager runs inside
// `<workspace>/plugins/`, so a relative path handed to it unchanged would
// resolve from there; the spec is made absolute against the caller's working
// directory first. The name `plugins.json` and the lock file record is the
// `name` in that package.json, which is what the package manager installs
// under (`@browxai/plugin-figma`, not the directory name `figma`).

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type FileSpec =
  | {
      readonly ok: true;
      /** `file:<absolute dir>`, ready to hand to the package manager. */
      readonly spec: string;
      readonly dir: string;
      /** The `name` field of `<dir>/package.json`. */
      readonly name: string;
    }
  | { readonly ok: false; readonly error: string };

/** Parse a `file:` install spec. Returns `undefined` for any other spec. A
 *  relative path resolves against `cwd`, which the CLI entry passes in. */
export function parseFileSpec(spec: string, cwd?: string): FileSpec | undefined {
  if (!spec.startsWith("file:")) return undefined;
  const raw = spec.slice("file:".length);
  if (raw.length === 0) return { ok: false, error: `"${spec}" has no path after "file:"` };
  const dir = cwd === undefined ? resolve(raw) : resolve(cwd, raw);
  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) return { ok: false, error: `no package.json in ${dir}` };
  let name: unknown;
  try {
    name = (JSON.parse(readFileSync(pkgJson, "utf8")) as { name?: unknown }).name;
  } catch {
    return { ok: false, error: `${pkgJson} is not valid JSON` };
  }
  if (typeof name !== "string" || name.length === 0) {
    return { ok: false, error: `${pkgJson} has no "name" field` };
  }
  return { ok: true, spec: `file:${dir}`, dir, name };
}
