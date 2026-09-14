// Builds the replay player (RFC 0007 P2): one self-contained HTML file with
// everything inlined. Wired to `pnpm build:player`, and into `pnpm build`.
//
// The player is a BUILD ARTIFACT, not shipped source. `tsconfig.build.json`
// excludes `src/replay/player/` so `pnpm build` never emits it into `dist/` as
// loose modules; this script is what turns it into the single file, and the
// output lands under `dist/player/` (already gitignored).
//
// It lives in `scripts/` rather than beside the player source because it writes
// into the repo's `dist/`, not into `$BROWX_WORKSPACE`. The no-trace contract
// guard (`src/util/no-trace.test.ts`) reads every `src/**` filesystem mutation
// as a server write that must be workspace-rooted, and it is right to.
//
// Self-contained is the requirement, not a nicety: a reviewer double-clicks the
// file out of a CI artifact bundle, on a machine that may have no network and
// certainly has no browxai install. So the CSS, the rrweb bundle, the player
// bundle and optionally the artifact itself are all inlined, and nothing is
// fetched at runtime.

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { rrwebBundleSource } from "../src/replay/dom-capture.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYER_SRC = join(REPO_ROOT, "src", "replay", "player");

export const PLAYER_OUTPUT = join(REPO_ROOT, "dist", "player", "browxai-replay-player.html");

const STYLE_SLOT = "/*__BROWX_STYLE__*/";
const RRWEB_SLOT = "/*__BROWX_RRWEB__*/";
const PLAYER_SLOT = "/*__BROWX_PLAYER__*/";
const ARTIFACT_SLOT = "/*__BROWX_ARTIFACT__*/";

/** `</script>` inside an inlined script ends the tag, whatever the JS parser
 *  thinks. Every inlined blob goes through this. */
function escapeForScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
}

async function bundlePlayer(): Promise<string> {
  const result = await build({
    entryPoints: [join(PLAYER_SRC, "main.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "none",
  });
  const out = result.outputFiles[0];
  if (!out) throw new Error("replay player: esbuild produced no output");
  return out.text;
}

/** The empty shell: opens, then waits for an artifact to be dropped on it. */
export async function buildPlayerHtml(): Promise<string> {
  const [shell, css, player] = await Promise.all([
    readFile(join(PLAYER_SRC, "shell.html"), "utf8"),
    readFile(join(PLAYER_SRC, "player.css"), "utf8"),
    bundlePlayer(),
  ]);
  return shell
    .replace(STYLE_SLOT, () => css)
    .replace(RRWEB_SLOT, () => escapeForScript(rrwebBundleSource()))
    .replace(PLAYER_SLOT, () => escapeForScript(player))
    .replace(ARTIFACT_SLOT, () => "");
}

/**
 * Embed a `.browx` artifact into a built shell. This is what makes the CI story
 * work: one file in the artifact bundle that a reviewer opens with no picker,
 * no server and no browxai install.
 */
export function packPlayerHtml(shellHtml: string, artifact: Uint8Array): string {
  const base64 = Buffer.from(artifact).toString("base64");
  const marker = `<script type="application/octet-stream;base64" id="browx-embedded-artifact">`;
  const at = shellHtml.indexOf(marker);
  if (at < 0) throw new Error("replay player: the shell has no embedded-artifact slot");
  const close = shellHtml.indexOf("</script>", at);
  return shellHtml.slice(0, at + marker.length) + base64 + shellHtml.slice(close);
}

export async function writePlayer(target = PLAYER_OUTPUT): Promise<string> {
  const html = await buildPlayerHtml();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, html, "utf8");
  return target;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const path = await writePlayer();
  const { size } = await readFile(path).then((b) => ({ size: b.byteLength }));
  process.stdout.write(`replay player: ${path} (${Math.round(size / 1024)} KB)\n`);
}
