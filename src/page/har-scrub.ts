// Scrub a finalised HAR file in place when its session closes. Playwright
// writes the HAR on `context.close()`, so this runs right after the close.
//
// Two rules, both from the replay redactor's posture:
//   - The `Cookie`, `Set-Cookie` and `Authorization` header values are
//     dropped (the names stay, with an empty value), and so are the parsed
//     `request.cookies` / `response.cookies` values Playwright derives from
//     those headers.
//   - Every other header value, URL, query value, request body and text
//     response body is run through the session's secrets masker, so a
//     registered value becomes `<NAME>`.
// A text body stored as a sidecar file (`content: "attach"` on a `.har` path)
// is masked in its file. Recording to a `.zip` path is refused up front, so no
// archive reaches this module. Without the `network-body` capability the
// request body (`postData.text` and `postData.params`) is emptied too, since
// Playwright writes urlencoded form values there even with `content: "omit"`.
// Base64 bodies are not decoded, the same limit `network_body` documents.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { DEFAULT_DROPPED_HEADERS } from "../replay/redact.js";
import { resolveWorkspaceWritePath } from "../session/storage.js";
import type { SecretRegistry } from "../util/secrets.js";

const DROPPED = new Set(DEFAULT_DROPPED_HEADERS);
/** Content types whose sidecar file is text, the same test `caches_get` uses. */
const TEXT_MIME = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded))|charset=/i;

type Mask = (s: string) => string;
type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);

function scrubNameValues(list: unknown, mask: Mask, dropAll: boolean): void {
  for (const nv of recs(list)) {
    if (typeof nv.value !== "string") continue;
    const name = typeof nv.name === "string" ? nv.name.toLowerCase() : "";
    nv.value = dropAll || DROPPED.has(name) ? "" : mask(nv.value);
  }
}

function scrubMessage(msg: unknown, mask: Mask, keepBodies: boolean): void {
  if (!isRec(msg)) return;
  scrubNameValues(msg.headers, mask, false);
  scrubNameValues(msg.cookies, mask, true);
  scrubNameValues(msg.queryString, mask, false);
  if (typeof msg.url === "string") msg.url = mask(msg.url);
  if (typeof msg.redirectURL === "string") msg.redirectURL = mask(msg.redirectURL);
  const post = msg.postData;
  if (isRec(post)) {
    if (keepBodies) {
      if (typeof post.text === "string") post.text = mask(post.text);
      scrubNameValues(post.params, mask, false);
    } else {
      delete post.text;
      post.params = [];
    }
  }
  const content = msg.content;
  if (isRec(content) && typeof content.text === "string" && content.encoding !== "base64") {
    content.text = mask(content.text);
  }
}

/** Scrub a parsed HAR document in place. Returns the sidecar file names its
 *  text bodies live in (`content._file`), for the caller to mask. */
export function scrubHarDocument(doc: unknown, mask: Mask, keepBodies = false): string[] {
  const sidecars: string[] = [];
  const log = isRec(doc) ? doc.log : undefined;
  for (const entry of recs(isRec(log) ? log.entries : undefined)) {
    scrubMessage(entry.request, mask, keepBodies);
    scrubMessage(entry.response, mask, keepBodies);
    const content = isRec(entry.response) ? entry.response.content : undefined;
    if (
      isRec(content) &&
      typeof content._file === "string" &&
      content.encoding !== "base64" &&
      typeof content.mimeType === "string" &&
      TEXT_MIME.test(content.mimeType)
    ) {
      sidecars.push(content._file);
    }
  }
  return sidecars;
}

/** Scrub the HAR at `harPath` (already resolved under `workspaceRoot`) and its
 *  text sidecar files. `keepBodies` is true when the `network-body` capability
 *  is on: request bodies are then kept (masked) as the recorder wrote them.
 *  Best-effort: a missing file (nothing was recorded) or a `.zip` archive is
 *  reported, never thrown. */
export function scrubHarFile(
  workspaceRoot: string,
  harPath: string,
  secrets: SecretRegistry | null,
  keepBodies = false,
): { scrubbed: boolean; reason?: "missing" | "zip" | "unparseable" } {
  if (harPath.toLowerCase().endsWith(".zip")) return { scrubbed: false, reason: "zip" };
  // Re-resolve through the workspace chokepoint before any read or write; the
  // file stays under BROWX_WORKSPACE.
  const target = resolveWorkspaceWritePath(workspaceRoot, relative(workspaceRoot, harPath), "har");
  if (!existsSync(target)) return { scrubbed: false, reason: "missing" };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return { scrubbed: false, reason: "unparseable" };
  }
  const mask: Mask = secrets ? (s) => secrets.applyMaskInText(s) : (s) => s;
  const sidecars = scrubHarDocument(doc, mask, keepBodies);
  writeFileSync(target, JSON.stringify(doc, null, 2));
  if (secrets && secrets.size() > 0) {
    for (const name of sidecars) maskSidecar(workspaceRoot, dirname(target), name, mask);
  }
  return { scrubbed: true };
}

/** Mask one sidecar body file. Only a bare file name next to the HAR is
 *  accepted, so a crafted `_file` cannot point anywhere else. */
function maskSidecar(workspaceRoot: string, dir: string, name: string, mask: Mask): void {
  if (basename(name) !== name || name === "." || name === "..") return;
  // Resolved under BROWX_WORKSPACE like the HAR itself.
  const file = resolveWorkspaceWritePath(
    workspaceRoot,
    relative(workspaceRoot, join(dir, name)),
    "har",
  );
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  const masked = mask(text);
  if (masked !== text) writeFileSync(file, masked);
}
