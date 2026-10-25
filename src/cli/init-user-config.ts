// `browxai init --write-user-config <client>`: add the browxai entry to a client's
// user-level config file, after showing the change. This is the only code in init
// that touches a file outside the project, and it runs only on that flag.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  CLIENT_LABELS,
  codexToml,
  userConfigPath,
  type ClientId,
  type ClientSystem,
  type ServerEntry,
} from "./init-clients.js";

export type UserConfigPlan =
  | { kind: "add"; path: string; before: string; after: string }
  | { kind: "present"; path: string }
  | { kind: "refuse"; message: string };

/** Files larger than this are not diffed in-process, so they are not edited. */
const MAX_LINES = 3000;

export function planUserConfig(
  id: ClientId,
  entry: ServerEntry,
  sys: ClientSystem,
  read: (path: string) => string | undefined = readIfExists,
): UserConfigPlan {
  const label = CLIENT_LABELS[id];
  if (id === "claude-code") {
    return {
      kind: "refuse",
      message: `${label} keeps user settings in a file browxai does not edit. Run the \`claude mcp add-json\` line printed above instead.`,
    };
  }
  const path = userConfigPath(id, sys);
  if (!path) {
    return {
      kind: "refuse",
      message: `No user-level config location is known for ${label} on this OS.`,
    };
  }
  const before = read(path) ?? "";
  if (before.split("\n").length > MAX_LINES) {
    return {
      kind: "refuse",
      message: `${path} is too large to show a diff. Add the entry by hand.`,
    };
  }
  if (id === "codex") {
    if (/^\s*\[\s*mcp_servers\s*\.\s*"?browxai"?\s*[\].]/m.test(before))
      return { kind: "present", path };
    const sep = before === "" ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    return { kind: "add", path, before, after: `${before}${sep}${codexToml(entry)}\n` };
  }
  let doc: Record<string, unknown> = {};
  if (before.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(before);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("not an object");
      doc = parsed as Record<string, unknown>;
    } catch {
      return {
        kind: "refuse",
        message: `${path} is not plain JSON (a comment or a trailing comma will do it). Fix it, or add the entry by hand.`,
      };
    }
  }
  const servers = doc.mcpServers;
  if (
    servers !== undefined &&
    (typeof servers !== "object" || servers === null || Array.isArray(servers))
  ) {
    return {
      kind: "refuse",
      message: `"mcpServers" in ${path} is not an object. Add the entry by hand.`,
    };
  }
  if (servers && "browxai" in servers) return { kind: "present", path };
  doc.mcpServers = { ...servers, browxai: entry };
  return { kind: "add", path, before, after: JSON.stringify(doc, null, 2) + "\n" };
}

/** Write the planned file: to a random sibling temp file first, then rename over
 *  the target. The new file keeps the old one's mode, 0600 when there was none.
 *  A symlinked config stays a symlink: the file it points at is replaced. The
 *  previous contents are kept in `<config>.browxai-bak`. */
export function applyUserConfig(plan: Extract<UserConfigPlan, { kind: "add" }>): void {
  mkdirSync(dirname(plan.path), { recursive: true });
  const target = realTarget(plan.path);
  const mode = existingMode(target);
  if (mode !== undefined) replaceVia(`${target}.browxai-bak`, readFileSync(target), mode);
  replaceVia(target, plan.after, mode ?? 0o600);
}

/** The file a write to `path` should replace: the path itself, or the end of
 *  its symlink chain. A symlink to nothing is refused. */
function realTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // Nothing resolves at `path`. Either there is no file, or a symlink to nothing.
  let dangling = false;
  try {
    dangling = lstatSync(path).isSymbolicLink();
  } catch {
    /* no entry at all */
  }
  if (dangling) throw new Error(`${path} is a symlink to a file that does not exist`);
  return join(realpathSync(dirname(path)), basename(path));
}

/** Write `data` to a new temp file next to `path`, then rename it over `path`.
 *  The temp file is removed if anything fails. */
function replaceVia(path: string, data: string | Buffer, mode: number): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeNew(tmp, data, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Permission bits of an existing file, or undefined when there is none. */
function existingMode(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** Create `path`, which must not exist yet, with exactly `mode`. */
function writeNew(path: string, data: string | Buffer, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    // The umask can strip bits from the mode given to open; set it exactly.
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/** A unified-style diff with two lines of context. */
export function lineDiff(before: string, after: string, path: string): string {
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  // Longest common subsequence table, filled from the end.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const rows: { tag: " " | "+" | "-"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ tag: " ", text: a[i]! });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      rows.push({ tag: "+", text: b[j]! });
      j++;
    } else {
      rows.push({ tag: "-", text: a[i]! });
      i++;
    }
  }
  const keep = rows.map((r, k) =>
    r.tag !== " " ? true : rows.slice(Math.max(0, k - 2), k + 3).some((n) => n.tag !== " "),
  );
  const out = [`--- ${before === "" ? "(new file)" : path}`, `+++ ${path}`];
  let gap = false;
  rows.forEach((r, k) => {
    if (!keep[k]) {
      gap = true;
      return;
    }
    if (gap) out.push("  ...");
    gap = false;
    out.push(`${r.tag} ${r.text}`);
  });
  return out.join("\n");
}
