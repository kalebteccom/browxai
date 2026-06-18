#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const harnesses = {
  claude: {
    source: "packages/marketplace-claude/catalog-source.json",
    output: ".claude-plugin/marketplace.json",
    pluginRoot: "packages/marketplace-claude/plugins",
    validate: validateClaudeCatalog,
  },
  codex: {
    source: "packages/marketplace-codex/catalog-source.json",
    output: ".agents/plugins/marketplace.json",
    pluginRoot: "packages/marketplace-codex/plugins",
    validate: validateCodexCatalog,
  },
};

const INSTALLATION_POLICIES = new Set(["NOT_AVAILABLE", "AVAILABLE", "INSTALLED_BY_DEFAULT"]);
const AUTHENTICATION_POLICIES = new Set(["ON_INSTALL", "ON_USE"]);

function usage() {
  return [
    "Usage: node scripts/harness-marketplaces.mjs <generate|validate> [--harness claude|codex]",
    "",
    "generate   writes root marketplace catalogs from package sources",
    "validate   checks source schema and root catalog drift",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !["generate", "validate"].includes(command)) {
    throw new Error(usage());
  }

  let harness = "all";
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--harness") {
      harness = rest[i + 1] ?? "";
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  if (harness !== "all" && !(harness in harnesses)) {
    throw new Error(`Unknown harness: ${harness}\n\n${usage()}`);
  }

  return { command, harness };
}

async function readJson(path) {
  const full = resolve(repoRoot, path);
  try {
    return JSON.parse(await readFile(full, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${path}: failed to read JSON: ${reason}`);
  }
}

async function stableJson(value, filepath) {
  const options = (await resolveConfig(filepath)) ?? {};
  return format(JSON.stringify(value), { ...options, filepath, parser: "json" });
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertKebabName(value, label) {
  assertString(value, label);
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(value)) {
    throw new Error(`${label} must be kebab-case`);
  }
}

function assertArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function assertSafeRelativePath(path, label, expectedRoot) {
  assertString(path, label);
  if (!path.startsWith("./")) {
    throw new Error(`${label} must start with ./`);
  }

  const resolvedPath = resolve(repoRoot, path);
  const resolvedRoot = resolve(repoRoot, expectedRoot);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel === "" || rel.startsWith("..") || rel.split(sep).includes("..")) {
    throw new Error(`${label} must stay under ${expectedRoot}`);
  }
}

function validateClaudeSource(source, label, expectedRoot) {
  if (typeof source === "string") {
    assertSafeRelativePath(source, label, expectedRoot);
    return;
  }

  assertObject(source, label);
  if (source.source !== "git-subdir") {
    throw new Error(`${label}.source must be git-subdir when source is an object`);
  }
  assertString(source.url, `${label}.url`);
  assertString(source.path, `${label}.path`);
}

function validateClaudeCatalog(catalog, config) {
  assertObject(catalog, "Claude catalog");
  assertKebabName(catalog.name, "Claude catalog name");
  assertObject(catalog.owner, "Claude catalog owner");
  assertString(catalog.owner.name, "Claude catalog owner.name");
  assertArray(catalog.plugins, "Claude catalog plugins");

  for (const [index, plugin] of catalog.plugins.entries()) {
    const label = `Claude catalog plugins[${index}]`;
    assertObject(plugin, label);
    assertKebabName(plugin.name, `${label}.name`);
    validateClaudeSource(plugin.source, `${label}.source`, config.pluginRoot);
    if ("description" in plugin) assertString(plugin.description, `${label}.description`);
    if ("category" in plugin) assertString(plugin.category, `${label}.category`);
  }
}

function validateCodexCatalog(catalog, config) {
  assertObject(catalog, "Codex catalog");
  assertKebabName(catalog.name, "Codex catalog name");
  assertObject(catalog.interface, "Codex catalog interface");
  assertString(catalog.interface.displayName, "Codex catalog interface.displayName");
  assertArray(catalog.plugins, "Codex catalog plugins");

  for (const [index, plugin] of catalog.plugins.entries()) {
    const label = `Codex catalog plugins[${index}]`;
    assertObject(plugin, label);
    assertKebabName(plugin.name, `${label}.name`);
    assertObject(plugin.source, `${label}.source`);
    if (plugin.source.source !== "local") {
      throw new Error(`${label}.source.source must be local`);
    }
    assertSafeRelativePath(plugin.source.path, `${label}.source.path`, config.pluginRoot);
    assertObject(plugin.policy, `${label}.policy`);
    if (!INSTALLATION_POLICIES.has(plugin.policy.installation)) {
      throw new Error(`${label}.policy.installation is not allowed`);
    }
    if (!AUTHENTICATION_POLICIES.has(plugin.policy.authentication)) {
      throw new Error(`${label}.policy.authentication is not allowed`);
    }
    assertString(plugin.category, `${label}.category`);
  }
}

async function loadCatalog(harness) {
  const config = harnesses[harness];
  const catalog = await readJson(config.source);
  config.validate(catalog, config);
  const outputPath = resolve(repoRoot, config.output);
  return { config, catalog, rendered: await stableJson(catalog, outputPath) };
}

async function generate(harness) {
  const { config, rendered } = await loadCatalog(harness);
  const outputPath = resolve(repoRoot, config.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, rendered, "utf8");
  console.log(`${harness}: wrote ${config.output}`);
}

async function validate(harness) {
  const { config, rendered } = await loadCatalog(harness);
  let existing;
  try {
    existing = await readFile(resolve(repoRoot, config.output), "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`${config.output}: failed to read generated catalog: ${reason}`);
  }

  if (existing !== rendered) {
    throw new Error(
      `${config.output} is stale. Run pnpm marketplace:generate and commit the result.`,
    );
  }

  console.log(`${harness}: ${config.output} matches ${config.source}`);
}

async function main() {
  const { command, harness } = parseArgs(process.argv.slice(2));
  const selected = harness === "all" ? Object.keys(harnesses) : [harness];

  for (const name of selected) {
    if (command === "generate") {
      await generate(name);
    } else {
      await validate(name);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
