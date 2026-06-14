// SDK tool-types codegen (RFC 0004 P2 / D7) — DEV TOOL, not a build/CI step.
//
// Reads every registered MCP tool's zod `inputSchema` (the colocated
// metadata-at-registration source of truth) and emits a per-tool input-argument
// TypeScript type (the SAME `z.infer<z.ZodObject<S>>` the in-process handler
// receives). Run on demand via `pnpm gen:sdk-types` to PRINT or eyeball the
// schema-derived input shapes when curating the public SDK surface.
//
// AUTHORITATIVE SURFACE: the hand-curated `src/sdk/tool-types.ts` is the single
// source of truth for the public SDK types. It deliberately DIVERGES from the
// schema-faithful shapes this generator emits — it carries per-tool RESULT shapes
// (mirrored from docs/tool-reference.md, not from any zod schema) and a
// deliberately narrowed public input surface (e.g. `SnapshotArgs` intentionally
// omits `includeShadow`). A generated companion would therefore either contradict
// the curated narrowing or need per-tool carve-outs to reconcile, and — proven by
// audit — nothing in `src/` ever consumed it. The D4 review removed the committed
// `src/sdk/tool-types.generated.ts` and its determinism-only drift test rather
// than ship a dead, git-tracked artifact (it was also WRONG for `plugins_info`,
// emitting `Record<string, never>` because the metadata-collector registered the
// plugin tools with a schema-less placeholder). This generator stays as the dev
// tool; `generateSdkToolTypes()` remains exported so an ad-hoc check or a future
// meaningful consumer can call it without rewriting the lowering.

import { fileURLToPath } from "node:url";
import { z } from "zod";

import { collectToolMetadata } from "../src/tools/tool-metadata.js";
import type { ToolRegistration } from "../src/tools/host.js";

/** PascalCase a snake_case tool name: `act_and_wait_for_network` → `ActAndWaitForNetwork`. */
function pascal(name: string): string {
  return name
    .split(/[_-]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/** Lower one zod type to a TypeScript type string. Covers the constructs the tool
 *  input schemas use; deterministic (object keys + union members keep declared
 *  order) so the output is stable across runs. Unknown constructs degrade to
 *  `unknown` rather than throwing — the drift test still pins the result. */
function zodToTs(schema: z.ZodTypeAny, indent: number): string {
  const def = schema._def as { typeName?: string } & Record<string, unknown>;
  const tn = def.typeName;
  switch (tn) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodNull":
      return "null";
    case "ZodUndefined":
    case "ZodVoid":
      return "undefined";
    case "ZodAny":
    case "ZodUnknown":
      return "unknown";
    case "ZodLiteral":
      return JSON.stringify((def as { value: unknown }).value);
    case "ZodEnum":
      return ((def as { values: string[] }).values ?? []).map((v) => JSON.stringify(v)).join(" | ");
    case "ZodNativeEnum": {
      const values = Object.values((def as { values: Record<string, unknown> }).values ?? {});
      return values.map((v) => JSON.stringify(v)).join(" | ") || "unknown";
    }
    case "ZodOptional":
      return zodToTs((def as { innerType: z.ZodTypeAny }).innerType, indent);
    case "ZodNullable":
      return `${zodToTs((def as { innerType: z.ZodTypeAny }).innerType, indent)} | null`;
    case "ZodDefault":
      return zodToTs((def as { innerType: z.ZodTypeAny }).innerType, indent);
    case "ZodEffects":
      return zodToTs((def as { schema: z.ZodTypeAny }).schema, indent);
    case "ZodArray":
      return `Array<${zodToTs((def as { type: z.ZodTypeAny }).type, indent)}>`;
    case "ZodUnion": {
      const opts = (def as { options: z.ZodTypeAny[] }).options ?? [];
      return opts.map((o) => zodToTs(o, indent)).join(" | ");
    }
    case "ZodRecord":
      return `Record<string, ${zodToTs((def as { valueType: z.ZodTypeAny }).valueType, indent)}>`;
    case "ZodTuple": {
      const items = (def as { items: z.ZodTypeAny[] }).items ?? [];
      return `[${items.map((i) => zodToTs(i, indent)).join(", ")}]`;
    }
    case "ZodObject":
      return objectToTs(schema as z.ZodObject<z.ZodRawShape>, indent);
    default:
      return "unknown";
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const tn = (schema._def as { typeName?: string }).typeName;
  return tn === "ZodOptional" || tn === "ZodDefault";
}

function objectToTs(schema: z.ZodObject<z.ZodRawShape>, indent: number): string {
  const shape = schema.shape;
  const keys = Object.keys(shape);
  if (keys.length === 0) return "Record<string, never>";
  const pad = "  ".repeat(indent + 1);
  const closePad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const key of keys) {
    const val = shape[key] as z.ZodTypeAny;
    const opt = isOptional(val) ? "?" : "";
    const safeKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
    lines.push(`${pad}${safeKey}${opt}: ${zodToTs(val, indent + 1)};`);
  }
  return `{\n${lines.join("\n")}\n${closePad}}`;
}

/** Generate the TS type for one registration's input schema (its `z.ZodRawShape`
 *  wrapped in a `z.object`). A tool with no schema → `Record<string, never>`. */
function argsTypeFor(reg: ToolRegistration): string {
  if (!reg.inputSchema || Object.keys(reg.inputSchema).length === 0) {
    return "Record<string, never>";
  }
  return objectToTs(z.object(reg.inputSchema), 0);
}

export function generateSdkToolTypes(): string {
  const table = collectToolMetadata();
  const names = [...table.keys()].sort();
  const out: string[] = [
    "// GENERATED by scripts/gen-sdk-tool-types.ts — DO NOT EDIT.",
    "// Run `pnpm gen:sdk-types` to regenerate. Source of truth: each tool's zod",
    "// `inputSchema` declared at its `host.register` call (RFC 0004 P2 / D7).",
    "//",
    "// Schema-derived INPUT-argument shapes for every registered MCP tool. The",
    "// curated public SDK surface (result shapes, narrowed inputs) stays in",
    "// `./tool-types.ts`; this artifact is the drift-checked schema companion.",
    "",
  ];
  for (const name of names) {
    const reg = table.get(name);
    if (!reg) continue;
    out.push(`/** Input arguments for the \`${name}\` tool (z.infer of its inputSchema). */`);
    out.push(`export type ${pascal(name)}GeneratedArgs = ${argsTypeFor(reg)};`);
    out.push("");
  }
  return out.join("\n");
}

function main(): void {
  // Dev tool: PRINT the schema-derived input shapes to stdout for inspection. We
  // intentionally do NOT write a git-tracked file — the curated
  // `src/sdk/tool-types.ts` is the authoritative public surface (see the D4 note
  // in the header). Redirect to a scratch file if you want to diff locally.
  const content = generateSdkToolTypes();
  process.stdout.write(content.endsWith("\n") ? content : content + "\n");
}

// Run when invoked directly.
const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) : "";
if (
  invokedPath &&
  (process.argv[1] === invokedPath || process.argv[1]?.endsWith("gen-sdk-tool-types.ts"))
) {
  main();
}
