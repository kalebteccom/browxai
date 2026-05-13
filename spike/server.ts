#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-explicit-any */
// browxai Phase-0 spike — throwaway MCP server.
//
// Two surfaces, selected at startup by BROWX_SPIKE_SURFACE=raw|curated (default raw):
//   raw      → navigate / click / fill / snapshot (verbose) / screenshot / console_read / network_read
//   curated  → adds find(); snapshot is compact w/ [ref=eN]; click/fill accept ref OR selector;
//              actions return a tiny ActionResult-lite (navigation + console_errors_since +
//              structure_changes summary).
//
// Every tool call lands in spike/runs/<task>.jsonl for post-hoc retry / wrong-action analysis.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { BrowxSpikeBrowser, fmtState, countNodes, type A11yNode } from "./browser.js";
import { Logger, type LogEntry } from "./log.js";

const SURFACE = (process.env.BROWX_SPIKE_SURFACE ?? "raw") as "raw" | "curated";
const TASK = process.env.BROWX_SPIKE_TASK ?? "adhoc";
const LOG_PATH = resolve("spike/runs", `${TASK}.${SURFACE}.${Date.now()}.jsonl`);

if (SURFACE !== "raw" && SURFACE !== "curated") {
  console.error(`BROWX_SPIKE_SURFACE must be "raw" or "curated"; got "${SURFACE}"`);
  process.exit(2);
}

const log = new Logger(LOG_PATH);
const bx = new BrowxSpikeBrowser();
let lastUrl: string | null = null;

const tally = async <T>(tool: string, args: unknown, fn: () => Promise<{ summary: string; result: T }>) => {
  const t0 = Date.now();
  try {
    const { summary, result } = await fn();
    log.write({ ts: new Date().toISOString(), surface: SURFACE, task: TASK, tool, args, ok: true, ms: Date.now() - t0, result_summary: summary } satisfies LogEntry);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.write({ ts: new Date().toISOString(), surface: SURFACE, task: TASK, tool, args, ok: false, ms: Date.now() - t0, error: msg } satisfies LogEntry);
    throw err;
  }
};

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));

// ============================================================================
// Tool implementations
// ============================================================================

async function tNavigate({ url }: { url: string }) {
  return tally("navigate", { url }, async () => {
    const page = await bx.ensure();
    const before = lastUrl ?? page.url();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const after = page.url();
    lastUrl = after;
    if (SURFACE === "raw") return { summary: `→ ${after}`, result: text(`navigated\nurl: ${after}`) };
    const errs = bx.recentConsoleErrors(5000);
    return {
      summary: `→ ${after}`,
      result: json({
        ok: true,
        action: { type: "navigate", url },
        navigation: { changed: before !== after, from: before, to: after, kind: "full_load" },
        console: { errors: errs },
      }),
    };
  });
}

async function tClick(args: { selector?: string; ref?: string }) {
  return tally("click", args, async () => {
    const page = await bx.ensure();
    const before = page.url();
    const beforeErrs = bx.recentConsoleErrors(60_000).length;
    let locator;
    if (args.ref) {
      if (!bx.hasRef(args.ref)) throw new Error(`unknown ref "${args.ref}" (call snapshot or find first)`);
      // Curated-surface refs resolve via the matching a11y node's role+name.
      // For the spike, fall back to Playwright's role-name locator from the stored key:
      const [role, name] = (args.ref ? bx.refKey(args.ref).split("|") : []) as [string, string];
      locator = name ? page.getByRole(role as any, { name }) : page.getByRole(role as any).first();
    } else if (args.selector) {
      locator = page.locator(args.selector);
    } else {
      throw new Error("click requires `selector` or `ref`");
    }
    await locator.first().click({ timeout: 8000 });
    const after = page.url();
    if (SURFACE === "raw") return { summary: "ok", result: text("clicked") };
    const errs = bx.recentConsoleErrors(2000);
    return {
      summary: before === after ? "ok" : `→ ${after}`,
      result: json({
        ok: true,
        action: { type: "click", ...args },
        navigation: { changed: before !== after, from: before, to: after, kind: before !== after ? "spa_or_full" : null },
        console: { errors: errs, newSincePre: errs.length - beforeErrs },
      }),
    };
  });
}

async function tFill(args: { selector?: string; ref?: string; value: string }) {
  return tally("fill", args, async () => {
    const page = await bx.ensure();
    let locator;
    if (args.ref) {
      if (!bx.hasRef(args.ref)) throw new Error(`unknown ref "${args.ref}"`);
      const [role, name] = bx.refKey(args.ref).split("|") as [string, string];
      locator = name ? page.getByRole(role as any, { name }) : page.getByRole(role as any).first();
    } else if (args.selector) {
      locator = page.locator(args.selector);
    } else {
      throw new Error("fill requires `selector` or `ref`");
    }
    await locator.first().fill(args.value, { timeout: 8000 });
    if (SURFACE === "raw") return { summary: "ok", result: text("filled") };
    return {
      summary: "ok",
      result: json({ ok: true, action: { type: "fill", ...args }, element: { value: args.value } }),
    };
  });
}

async function tSnapshot() {
  return tally("snapshot", {}, async () => {
    const page = await bx.ensure();
    if (SURFACE === "raw") {
      // Verbose: dump the full a11y tree as JSON. Tokens will hurt — that's the point.
      const root = await bx.getA11yRoot();
      return { summary: `${countNodes(root)} nodes`, result: json({ url: page.url(), title: await page.title(), accessibility: root }) };
    }
    // Curated: compact text serialisation with [ref=eN] refs.
    const walked = await bx.walkA11y();
    const lines = walked.map(({ node, ref, depth }) => {
      const pad = "  ".repeat(depth);
      const nm = node.name ? ` "${node.name.slice(0, 80)}"` : "";
      return `${pad}${node.role}${nm} [ref=${ref}]${fmtState(node)}`;
    });
    return {
      summary: `${walked.length} nodes`,
      result: text(`url: ${page.url()}\ntitle: ${await page.title()}\n\n${lines.join("\n")}`),
    };
  });
}

async function tFind({ query, maxCandidates = 5 }: { query: string; maxCandidates?: number }) {
  return tally("find", { query, maxCandidates }, async () => {
    const walked = await bx.walkA11y();
    const q = query.toLowerCase();
    const scored = walked
      .map(({ node, ref }) => {
        const hay = `${node.role} ${node.name ?? ""}`.toLowerCase();
        let score = 0;
        if (hay.includes(q)) score += 5;
        // Partial word matches.
        for (const w of q.split(/\s+/).filter(Boolean)) if (hay.includes(w)) score += 1;
        // Interactable bonus.
        if (["button", "link", "textbox", "checkbox", "menuitem", "tab", "option"].includes(node.role)) score += 2;
        return { ref, role: node.role, name: node.name ?? "", score };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxCandidates);
    return {
      summary: `${scored.length} candidates`,
      result: json({ query, candidates: scored.map((c) => ({ ref: c.ref, role: c.role, name: c.name, score: c.score, selectorHint: c.name ? `role=${c.role}[name="${c.name}"]` : `role=${c.role}` })) }),
    };
  });
}

async function tScreenshot() {
  return tally("screenshot", {}, async () => {
    const page = await bx.ensure();
    const buf = await page.screenshot({ fullPage: false });
    return { summary: `${buf.length} bytes`, result: { content: [{ type: "image" as const, data: buf.toString("base64"), mimeType: "image/png" }] } };
  });
}

async function tConsoleRead({ limit = 50 }: { limit?: number }) {
  return tally("console_read", { limit }, async () => {
    const rows = bx.recentConsole(limit);
    return { summary: `${rows.length} entries`, result: json(rows) };
  });
}

async function tNetworkRead({ limit = 50 }: { limit?: number }) {
  return tally("network_read", { limit }, async () => {
    const rows = bx.recentNetwork(limit);
    return { summary: `${rows.length} entries`, result: json(rows) };
  });
}

// ============================================================================
// Server wiring
// ============================================================================

const server = new McpServer({ name: "browxai-spike", version: "0.0.0" }, { capabilities: { tools: {} } });

server.registerTool("navigate", { description: "Navigate the page to a URL.", inputSchema: { url: z.string().describe("Absolute URL") } }, tNavigate);
server.registerTool("click", {
  description: SURFACE === "curated" ? "Click an element by `ref` (preferred) or CSS/role `selector`." : "Click an element by CSS/role `selector`.",
  inputSchema: SURFACE === "curated" ? { selector: z.string().optional(), ref: z.string().optional() } : { selector: z.string() },
}, tClick);
server.registerTool("fill", {
  description: SURFACE === "curated" ? "Type into an input by `ref` (preferred) or `selector`." : "Type into an input by `selector`.",
  inputSchema: SURFACE === "curated" ? { selector: z.string().optional(), ref: z.string().optional(), value: z.string() } : { selector: z.string(), value: z.string() },
}, tFill);
server.registerTool("snapshot", {
  description: SURFACE === "curated"
    ? "Compact accessibility-tree snapshot with stable [ref=eN] refs you can pass back to click/fill."
    : "Raw accessibility-tree snapshot (Playwright JSON, verbose).",
  inputSchema: {},
}, tSnapshot);
if (SURFACE === "curated") {
  server.registerTool("find", {
    description: "Find candidate elements by natural-language `query`. Returns a ranked list with refs.",
    inputSchema: { query: z.string(), maxCandidates: z.number().optional() },
  }, tFind);
}
server.registerTool("screenshot", { description: "PNG screenshot of the viewport.", inputSchema: {} }, tScreenshot);
server.registerTool("console_read", { description: "Recent console messages.", inputSchema: { limit: z.number().optional() } }, tConsoleRead);
server.registerTool("network_read", { description: "Recent network requests (path/method/status).", inputSchema: { limit: z.number().optional() } }, tNetworkRead);

// stderr only — stdout is the MCP channel.
process.stderr.write(`browxai-spike: surface=${SURFACE} task=${TASK} log=${LOG_PATH}\n`);

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => { try { await bx.close(); } finally { process.exit(0); } };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
