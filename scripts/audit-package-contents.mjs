#!/usr/bin/env node
// scripts/audit-package-contents.mjs
//
// Runs `npm pack --dry-run --json` and asserts the to-be-published tarball
// does not contain forbidden patterns. Wired to `prepublishOnly` and to a
// dedicated CI gate so two independent paths catch a regression.
//
// Forbidden contents (per universal-baseline §F, npm-package-defense §3.4):
//
//   - Any dotfile / dot-directory other than the explicit allowlist
//     (.env, .git, .github, .vscode, .idea, .claude, .DS_Store, etc).
//   - node_modules — should never end up in a tarball, but if `"files"` is
//     loosened a careless commit can pull it in.
//   - Tests, fixtures, coverage — `*.test.{js,ts}`, `*.spec.{js,ts}`,
//     `__tests__/`, `__fixtures__/`, `coverage/`, `.nyc_output/`.
//   - Sourcemaps (`*.map`) — leak verbatim source via sourcesContent.
//   - Secrets-shaped filenames — `.netrc`, `id_rsa*`, `*.pem`, `*.key`,
//     `credentials.json`, `secrets.json`.
//   - Anything > 1 MB unless explicitly allowlisted.
//
// Lifecycle-script check: `package.json` must not declare any of
//   preinstall / install / postinstall / preuninstall / uninstall / postuninstall
// These run on the adopter's machine on `npm install` — every confirmed npm
// supply-chain compromise of the last two years has used one. `prepare` and
// `prepublishOnly` are publisher-side or build-only and remain allowed.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const FORBIDDEN_LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
];

// Match against tarball-relative paths (npm puts everything under `package/`).
// Each entry is `{ pattern: RegExp, why: string }`.
const FORBIDDEN_PATTERNS = [
  // Dotfiles / dot-directories — npm strips most by default, but a custom
  // "files" allowlist that hits a directory containing dotfiles ships them.
  { pattern: /(^|\/)\.env(\.|$)/, why: "dotenv file would leak credentials" },
  { pattern: /(^|\/)\.git(\/|$)/, why: ".git directory" },
  { pattern: /(^|\/)\.github(\/|$)/, why: ".github directory" },
  { pattern: /(^|\/)\.vscode(\/|$)/, why: ".vscode directory" },
  { pattern: /(^|\/)\.idea(\/|$)/, why: ".idea directory" },
  { pattern: /(^|\/)\.claude(\/|$)/, why: ".claude directory" },
  { pattern: /(^|\/)\.DS_Store$/, why: "OS cruft" },
  { pattern: /(^|\/)\.cursor(\/|$)/, why: ".cursor directory" },
  { pattern: /(^|\/)\.codex(\/|$)/, why: ".codex directory" },
  { pattern: /(^|\/)\.agents(\/|$)/, why: ".agents directory" },

  // Workspace cruft.
  { pattern: /(^|\/)node_modules(\/|$)/, why: "node_modules must never be published" },
  { pattern: /(^|\/)coverage(\/|$)/, why: "coverage output" },
  { pattern: /(^|\/)\.nyc_output(\/|$)/, why: "nyc coverage cache" },
  { pattern: /(^|\/)artifacts(\/|$)/, why: "investigation artifacts" },

  // Tests / fixtures.
  { pattern: /\.test\.(js|ts|tsx|mjs|cjs)$/, why: "test file" },
  { pattern: /\.spec\.(js|ts|tsx|mjs|cjs)$/, why: "spec file" },
  { pattern: /(^|\/)__tests__(\/|$)/, why: "__tests__ directory" },
  { pattern: /(^|\/)__fixtures__(\/|$)/, why: "__fixtures__ directory" },
  { pattern: /(^|\/)tests?(\/|$)/, why: "tests directory" },

  // Sourcemaps — leak verbatim source via sourcesContent.
  { pattern: /\.map$/, why: "sourcemap leaks src/" },

  // Secret-shaped filenames.
  { pattern: /(^|\/)\.npmrc$/, why: ".npmrc may carry auth tokens" },
  { pattern: /(^|\/)\.netrc$/, why: ".netrc carries credentials" },
  { pattern: /(^|\/)id_rsa/, why: "SSH private key" },
  { pattern: /\.pem$/, why: "PEM-encoded credential" },
  { pattern: /\.key$/, why: "key file" },
  { pattern: /(^|\/)credentials\.json$/, why: "credentials file" },
  { pattern: /(^|\/)secrets\.json$/, why: "secrets file" },

  // Browser-session captures.
  { pattern: /\.storageState\.json$/, why: "captured browser auth state" },
  { pattern: /(^|\/)\.auth(\/|$)/, why: ".auth directory carries session state" },
];

// Files > 1 MB raise a flag unless their path is explicitly in this list.
// Empty for browxai today; populate explicitly when a legitimate large asset
// (icon set, model weights, etc) ships intentionally.
const LARGE_FILE_ALLOWLIST = new Set([]);
const MAX_UNALLOWLISTED_BYTES = 1024 * 1024; // 1 MB

function runNpmPack(cwd) {
  // Use npm (ships with Node) — we do NOT want pnpm-pack semantics here; we
  // want the exact list npm would publish.
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // npm pack --json emits an array of tarball-meta objects (one per package).
  return JSON.parse(out);
}

function inspectPackageJson(cwd) {
  const path = resolve(cwd, "package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const errors = [];
  const scripts = pkg.scripts ?? {};
  for (const banned of FORBIDDEN_LIFECYCLE_SCRIPTS) {
    if (banned in scripts) {
      errors.push(
        `package.json declares forbidden lifecycle script "${banned}" — runs on adopter \`npm install\`. Remove it.`,
      );
    }
  }
  return { pkg, errors };
}

function auditTarball(cwd, label) {
  const errors = [];
  let tarballs;
  try {
    tarballs = runNpmPack(cwd);
  } catch (err) {
    return {
      label,
      errors: [
        `npm pack --dry-run failed in ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  for (const tarball of tarballs) {
    const files = tarball.files ?? [];
    for (const f of files) {
      const path = f.path ?? "";
      const size = typeof f.size === "number" ? f.size : 0;

      for (const { pattern, why } of FORBIDDEN_PATTERNS) {
        if (pattern.test(path)) {
          errors.push(`${label}: forbidden path "${path}" — ${why}`);
        }
      }

      if (size > MAX_UNALLOWLISTED_BYTES && !LARGE_FILE_ALLOWLIST.has(path)) {
        errors.push(
          `${label}: oversized file "${path}" (${size} bytes > 1 MB). If intentional, add to LARGE_FILE_ALLOWLIST in scripts/audit-package-contents.mjs.`,
        );
      }
    }
  }

  return { label, errors };
}

function main() {
  const targets = [
    { cwd: REPO_ROOT, label: "root (browxai)" },
    {
      cwd: resolve(REPO_ROOT, "packages/plugins/example"),
      label: "@kalebtec/browxai-plugin-example",
    },
    { cwd: resolve(REPO_ROOT, "packages/plugins/figma"), label: "@kalebtec/browxai-plugin-figma" },
    {
      cwd: resolve(REPO_ROOT, "packages/plugins/tldraw"),
      label: "@kalebtec/browxai-plugin-tldraw",
    },
    {
      cwd: resolve(REPO_ROOT, "packages/plugins/excalidraw"),
      label: "@kalebtec/browxai-plugin-excalidraw",
    },
  ];

  const allErrors = [];
  for (const { cwd, label } of targets) {
    // Lifecycle-script gate (applies to every published manifest).
    const { errors: pkgErrors } = inspectPackageJson(cwd);
    for (const e of pkgErrors) allErrors.push(`${label}: ${e}`);

    // Tarball-content gate.
    const { errors: tarErrors } = auditTarball(cwd, label);
    allErrors.push(...tarErrors);
  }

  if (allErrors.length > 0) {
    console.error("Package-contents audit failed:");
    for (const e of allErrors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log("Package-contents audit passed.");
}

main();
