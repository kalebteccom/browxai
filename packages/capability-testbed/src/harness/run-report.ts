import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server/http.js";
import { buildContext, runExercise } from "./driver.js";
import { HARNESS_CAPABILITIES, MANIFEST } from "./manifest.js";
import { createMcpClient } from "./mcp-client.js";
import type { Capability, Client, FullReport, ManifestRow, Outcome, ToolReport } from "./types.js";

const OUTCOMES = ["pass", "fail", "error", "skip", "pending"] as const satisfies readonly Outcome[];
const DEFAULT_PORT = 5187;
const DEFAULT_TIMEOUT_MS = 30_000;
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const DEFAULT_REPORT_DIR = join(packageRoot, "reports");

interface Settings {
  readonly port: number;
  readonly engine: string;
  readonly headless: boolean;
  readonly only: ReadonlySet<string>;
  readonly reportDir: string;
  readonly timeoutMs: number;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseHeadless(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  const normalised = value.trim().toLowerCase();
  return !(normalised === "0" || normalised === "false" || normalised === "no");
}

function parseOnly(value: string | undefined): ReadonlySet<string> {
  if (value === undefined || value.trim() === "") return new Set<string>();
  return new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function readSettings(): Settings {
  return {
    port: parsePositiveInt(process.env.TESTBED_PORT, DEFAULT_PORT, "TESTBED_PORT"),
    engine: process.env.TESTBED_ENGINE?.trim() || "chromium",
    headless: parseHeadless(process.env.TESTBED_HEADLESS),
    only: parseOnly(process.env.TESTBED_ONLY),
    reportDir: process.env.TESTBED_REPORT_DIR?.trim() || DEFAULT_REPORT_DIR,
    timeoutMs: parsePositiveInt(
      process.env.TESTBED_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      "TESTBED_TIMEOUT_MS",
    ),
  };
}

function stripBrowxEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("BROWX_")) {
      delete process.env[key];
    }
  }
}

function selectedRows(only: ReadonlySet<string>): readonly ManifestRow[] {
  if (only.size === 0) return MANIFEST;
  return MANIFEST.filter((row) => only.has(row.capability) || only.has(row.tool));
}

function emptyTotals(): Record<Outcome, number> {
  return {
    pass: 0,
    fail: 0,
    error: 0,
    skip: 0,
    pending: 0,
  };
}

function capabilityOrder(rows: readonly ManifestRow[]): Capability[] {
  const seen = new Set<Capability>();
  const ordered: Capability[] = [];
  for (const row of rows) {
    if (!seen.has(row.capability)) {
      seen.add(row.capability);
      ordered.push(row.capability);
    }
  }
  return ordered;
}

function aggregate(
  engine: string,
  headless: boolean,
  startedAt: string,
  finishedAt: string,
  rows: readonly ManifestRow[],
  tools: readonly ToolReport[],
): FullReport {
  const totals = emptyTotals();
  for (const report of tools) {
    totals[report.outcome] += 1;
  }

  const byCapability = capabilityOrder(rows).map((capability) => {
    const capTotals = emptyTotals();
    for (const report of tools) {
      if (report.capability === capability) {
        capTotals[report.outcome] += 1;
      }
    }
    return { capability, totals: capTotals };
  });

  return {
    engine,
    headless,
    startedAt,
    finishedAt,
    totals,
    byCapability,
    tools,
  };
}

function mdCell(value: unknown): string {
  return String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function detailLine(report: ToolReport): string {
  const detail = report.detail ? ` - ${report.detail}` : "";
  return `${report.tool} (${report.capability}) ${report.durationMs}ms${detail}`;
}

function markdownReport(report: FullReport): string {
  const lines: string[] = [
    `# browxai capability testbed report`,
    "",
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt}`,
    `- Engine: ${report.engine}`,
    `- Headless: ${report.headless ? "true" : "false"}`,
    `- Tools: ${report.tools.length}`,
    "",
    "## Summary by capability",
    "",
    "| Capability | Pass | Fail | Error | Skip | Pending |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const row of report.byCapability) {
    lines.push(
      `| ${mdCell(row.capability)} | ${row.totals.pass} | ${row.totals.fail} | ${row.totals.error} | ${row.totals.skip} | ${row.totals.pending} |`,
    );
  }

  const notable = report.tools.filter(
    (tool) => tool.outcome === "fail" || tool.outcome === "error" || tool.outcome === "pending",
  );

  lines.push("", "## Failures, errors, and pending", "");
  if (notable.length === 0) {
    lines.push("No fail, error, or pending tools.");
  } else {
    for (const tool of notable) {
      lines.push(`### ${tool.outcome}: ${tool.tool}`);
      lines.push("");
      lines.push(`- Capability: ${tool.capability}`);
      lines.push(`- Duration: ${tool.durationMs}ms`);
      if (tool.detail) lines.push(`- Detail: ${mdCell(tool.detail)}`);
      if (tool.log.length > 0) lines.push(`- Log: ${mdCell(tool.log.join(" | "))}`);
      if (tool.evidence !== undefined) {
        lines.push("```json");
        lines.push(JSON.stringify(tool.evidence, null, 2));
        lines.push("```");
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

function sessionName(index: number, tool: string): string {
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `testbed-${index}-${safeTool}`;
}

function openErrorReport(row: ManifestRow, err: unknown): ToolReport {
  const message = err instanceof Error ? err.message : "open_session threw a non-Error value";
  return {
    tool: row.tool,
    capability: row.capability,
    outcome: "error",
    detail: `open_session failed: ${message}`,
    evidence:
      err instanceof Error
        ? { name: err.name, message: err.message, stack: err.stack }
        : { thrown: err },
    durationMs: 0,
    log: [],
  };
}

async function main(): Promise<void> {
  const settings = readSettings();
  const rows = selectedRows(settings.only);
  await mkdir(settings.reportDir, { recursive: true });
  const workspace = await mkdtemp(join(settings.reportDir, "workspace-"));

  stripBrowxEnv();
  process.env.BROWX_WORKSPACE = workspace;
  process.env.BROWX_CAPABILITIES = HARNESS_CAPABILITIES.join(",");

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replaceAll(":", "-");
  let client: Client | undefined;
  let server: Awaited<ReturnType<typeof startServer>> | undefined;

  try {
    server = await startServer(settings.port);
    client = await createMcpClient({
      workspace,
      capabilities: HARNESS_CAPABILITIES,
      headless: settings.headless,
    });

    const reports: ToolReport[] = [];
    for (const [index, row] of rows.entries()) {
      const session = sessionName(index, row.tool);
      let opened = false;
      try {
        await client.open_session({ session, mode: "incognito" });
        opened = true;
        const ctx = await buildContext(client, session, server.url, workspace);
        const report = await runExercise(row, ctx, settings.timeoutMs);
        reports.push(report);
        process.stdout.write(`[${report.outcome}] ${detailLine(report)}\n`);
      } catch (err) {
        const report = openErrorReport(row, err);
        reports.push(report);
        process.stdout.write(`[${report.outcome}] ${detailLine(report)}\n`);
      } finally {
        if (opened) {
          await client.close_session({ session }).catch(() => undefined);
        }
      }
    }

    const finishedAt = new Date().toISOString();
    const fullReport = aggregate(
      settings.engine,
      settings.headless,
      startedAt,
      finishedAt,
      rows,
      reports,
    );
    const jsonPath = join(settings.reportDir, `report-${stamp}.json`);
    const mdPath = join(settings.reportDir, `report-${stamp}.md`);
    await writeFile(jsonPath, `${JSON.stringify(fullReport, null, 2)}\n`, "utf8");
    await writeFile(mdPath, markdownReport(fullReport), "utf8");
    process.stdout.write(`wrote ${jsonPath}\n`);
    process.stdout.write(`wrote ${mdPath}\n`);
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
