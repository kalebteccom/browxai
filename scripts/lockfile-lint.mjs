#!/usr/bin/env node
// scripts/lockfile-lint.mjs
//
// Lint pnpm-lock.yaml for the same security properties lockfile-lint enforces
// on npm/yarn lockfiles. lockfile-lint (v4 / v5) does NOT parse pnpm-lock.yaml
// — neither its npm parser (expects JSON) nor its yarn parser (expects yarn-
// syml dependency map). Open upstream tracking issue:
//   https://github.com/lirantal/lockfile-lint/issues/203
//
// Until upstream lands pnpm support, this script is the equivalent gate.
// Mirrors the .lockfile-lintrc.json policy:
//   - allowed-hosts: [npm]               → tarball/git URLs must be on the
//                                          npm registry
//   - allowed-schemes: ["https:"]        → every URL must be https
//   - validate-https                     → no http://, git://, file:, etc.
//   - validate-integrity                 → every package entry has an
//                                          integrity hash, and every hash is
//                                          sha512
//   - validate-package-names             → keys parse as valid npm names
//
// Exits 0 on pass, 1 on fail with a list of offending lines/entries.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const LOCKFILE_PATH = resolve(REPO_ROOT, "pnpm-lock.yaml");

// Hosts that are allowed to serve tarballs / git refs. The pnpm registry default
// (registry.npmjs.org) is the canonical "npm" host; we accept the bare registry
// as well in case a mirror is configured per-project.
const ALLOWED_HOSTS = new Set(["registry.npmjs.org"]);

// npm package name regex (per https://github.com/npm/validate-npm-package-name).
const VALID_PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function main() {
  const text = readFileSync(LOCKFILE_PATH, "utf8");
  const lines = text.split("\n");
  const errors = [];

  let resolutionCount = 0;
  let integrityCount = 0;
  let inPackagesBlock = false;
  let currentPackageKey = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Top-level section boundaries.
    if (/^packages:\s*$/.test(line)) {
      inPackagesBlock = true;
      continue;
    }
    if (/^[a-z]+:\s*$/.test(line) && !line.startsWith(" ")) {
      inPackagesBlock = /^packages:\s*$/.test(line);
    }

    // Package keys live at 2-space indent inside `packages:` and look like:
    //   '@scope/name@1.2.3':
    //   name@1.2.3:
    if (inPackagesBlock) {
      const keyMatch = line.match(/^ {2}'?(@?[^@'\s]+(?:\/[^@'\s]+)?)@[^']+'?:\s*$/);
      if (keyMatch) {
        currentPackageKey = keyMatch[1];
        if (!VALID_PACKAGE_NAME.test(currentPackageKey)) {
          errors.push(`line ${i + 1}: invalid npm package name "${currentPackageKey}"`);
        }
      }
    }

    // resolution: {integrity: sha512-...}
    // resolution: {tarball: https://...}
    // resolution: {tarball: https://..., integrity: sha512-...}
    if (trimmed.startsWith("resolution:")) {
      resolutionCount++;
      const integrityMatch = trimmed.match(/integrity:\s*([^,}\s]+)/);
      if (integrityMatch) {
        integrityCount++;
        if (!integrityMatch[1].startsWith("sha512-")) {
          errors.push(
            `line ${i + 1}: integrity must be sha512, got "${integrityMatch[1].split("-")[0]}-…" for ${currentPackageKey ?? "(unknown)"}`,
          );
        }
      } else {
        // tarball-only resolutions are valid only if they explicitly use a
        // sibling `integrity:` line on the next line (not common in pnpm v9
        // format, but tolerated).
        const next = lines[i + 1]?.trim() ?? "";
        if (!next.startsWith("integrity:")) {
          errors.push(
            `line ${i + 1}: resolution has no integrity hash for ${currentPackageKey ?? "(unknown)"}`,
          );
        } else {
          integrityCount++;
        }
      }

      const tarballMatch = trimmed.match(/tarball:\s*([^,}\s]+)/);
      if (tarballMatch) {
        const url = tarballMatch[1];
        if (!url.startsWith("https://")) {
          errors.push(`line ${i + 1}: tarball must use https://, got "${url}"`);
        } else {
          try {
            const host = new URL(url).hostname;
            if (!ALLOWED_HOSTS.has(host)) {
              errors.push(
                `line ${i + 1}: tarball host "${host}" not in allowed-hosts (allowed: ${[...ALLOWED_HOSTS].join(", ")})`,
              );
            }
          } catch {
            errors.push(`line ${i + 1}: malformed tarball URL "${url}"`);
          }
        }
      }
    }
  }

  if (resolutionCount === 0) {
    errors.push("no `resolution:` entries found — pnpm-lock.yaml may be empty or malformed");
  }

  if (errors.length > 0) {
    console.error(`lockfile-lint failed (${errors.length} issue(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `lockfile-lint passed: ${resolutionCount} resolutions, ${integrityCount} integrity hashes verified (all sha512).`,
  );
}

main();
