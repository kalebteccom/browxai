// Unit cover for the pure helpers behind the manual first-run workflow (scripts/first-run/block.mjs, doc-facts.mjs,
// path-facts.mjs and procs.mjs): the token estimate, the byte budgets, the FRX| chunking, the Playwright download-size parser,
// what the docs quote for the documented-paths section, and the process-table filters. The run itself needs the npm registry
// and a browser and only happens in the manual Woodpecker workflow.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./_guard-tree.js";

const block = (await import(join(REPO, "scripts/first-run/block.mjs"))) as {
  BEGIN: string;
  END: string;
  bytes: (s: string) => number;
  estTokens: (chars: number) => number;
  clip: (s: string, n?: number) => string;
  excerpt: (output: string, lines: number, width?: number) => string[];
  layout: (
    headers: string[],
    entries: Array<{ head: string; output?: string }>,
    extras: string[],
    budget: number,
    maxLines?: number,
  ) => string;
  chunk: (tag: string, text: string) => string[];
  render: (tag: string, text: string) => string;
  worst: (codes: number[]) => number;
  BUDGETS: Record<"install" | "snapshot" | "sizes" | "paths", number>;
};
const facts = (await import(join(REPO, "scripts/first-run/doc-facts.mjs"))) as {
  docFacts: (root: string) => {
    pin?: string;
    installCmd?: string;
    sizeMb?: number;
    nodeMin?: number;
    tellsBrowser: boolean;
    quotedSmoke?: string;
    smokeRe?: RegExp;
  };
  downloadedBytes: (output: string) => number | undefined;
};

interface ProcRow {
  pid: number;
  ppid: number;
  state: string;
  argv: string[];
  cmd: string;
}
const procs = (await import(join(REPO, "scripts/first-run/procs.mjs"))) as {
  chromeMains: (rows: ProcRow[], work: string) => ProcRow[];
  isBrowxaiProcess: (p: ProcRow) => boolean;
  waitUntil: (
    fn: () => unknown,
    ms: number,
    step?: number,
  ) => Promise<{ ok: boolean; ms: number; value: unknown }>;
};
const sizesCore = (await import(join(REPO, "scripts/first-run/sizes-core.mjs"))) as {
  atLeast: (version: string | undefined, min: string) => boolean;
  pct: (part: number, whole: number) => string;
  splitCore: (
    tools: Array<{ name: string }>,
    coreNames: string[],
  ) => {
    core: { count: number; chars: number };
    plugin: Array<{ name: string; chars: number }>;
    catalog: number | undefined;
  };
};
const pathFacts = (await import(join(REPO, "scripts/first-run/path-facts.mjs"))) as {
  refusalFacts: (root: string) => {
    quote?: string;
    tool?: string;
    capability?: string;
    list?: string;
    mentions: string[];
    link?: string;
  };
  cliFacts: (root: string) => {
    signatures: Array<{ path: string; flags: string[] }>;
    flags: string[];
    chromeStartFlags: string[];
    pluginSubs: string[];
    doctorAreas: string[];
    socketMode?: string;
  };
  pluginFacts: (root: string) => {
    name?: string;
    showsInstall: boolean;
    showsLocalInstall?: string;
  };
  shellFacts: (root: string) => {
    commands: string[];
    codes: number[];
    fields: string[];
    flags: string[];
  };
  withoutShellRoute: <
    T extends { signatures: Array<{ path: string; flags: string[] }>; flags: string[] },
  >(
    cli: T,
    shell: { flags: string[] },
  ) => T;
};
const row = (pid: number, argv: string[], state = "S"): ProcRow => ({
  pid,
  ppid: 1,
  state,
  argv,
  cmd: argv.join(" "),
});

describe("first-run block helpers", () => {
  it("estimates tokens as characters over 4, rounded up", () => {
    expect(block.estTokens(0)).toBe(0);
    expect(block.estTokens(4)).toBe(1);
    expect(block.estTokens(401)).toBe(101);
  });

  it("clips to one ASCII line and writes the doctor glyphs as words", () => {
    expect(block.clip("✓ browser\n  ready")).toBe("OK browser ready");
    expect(block.clip("x".repeat(300), 20)).toHaveLength(20);
    // Written as escapes: the check must not depend on how the source file is normalised.
    expect(block.clip("a\u00e9b\u2603c")).toBe("a?b?c");
    expect(block.clip("cafe\u0301")).toBe("cafe?");
    // Whitespace of every kind is one space, and invisible characters are dropped.
    expect(block.clip("a\tb\r\nc\u00a0d")).toBe("a b c d");
    expect(block.clip("\u26a0\ufe0f x\u200by")).toBe("WARN xy");
  });

  it("keeps the first lines of an output and says how many it cut", () => {
    const out = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const shown = block.excerpt(out, 25);
    expect(shown).toHaveLength(26);
    expect(shown[0]).toBe("  > line 1");
    expect(shown.at(-1)).toBe("  > (+5 more lines)");
  });

  it("fits entries in the budget and never cuts the DIFF lines", () => {
    const entries = Array.from({ length: 18 }, (_, i) => ({
      head: `[${i + 1}] command | exit 0 | 1.00s`,
      output: Array.from({ length: 40 }, (_, j) => `output line ${j} ${"x".repeat(100)}`).join(
        "\n",
      ),
    }));
    const extras = [
      "DIFF: the page says X, the package printed Y",
      "result: 1 difference(s), exit 1",
    ];
    const text = block.layout(["section: demo"], entries, extras, 8000);
    expect(block.bytes(text)).toBeLessThanOrEqual(8000);
    expect(text).toContain(extras[0]);
    expect(text).toContain(extras[1]);
    expect(text.startsWith("section: demo")).toBe(true);
  });

  it("cuts entries, not extras, when even the heads do not fit", () => {
    const entries = Array.from({ length: 200 }, (_, i) => ({ head: `[${i}] ${"c".repeat(150)}` }));
    const text = block.layout(["h"], entries, ["DIFF: kept"], 3000);
    expect(block.bytes(text)).toBeLessThanOrEqual(3000);
    expect(text).toContain("DIFF: kept");
  });

  it("chunks the text into numbered lines of at most 1.5 KB per chunk", () => {
    const text = Array.from({ length: 100 }, (_, i) => `row ${i} ${"y".repeat(60)}`).join("\n");
    const lines = block.chunk("FRX", text);
    expect(lines).toHaveLength(100);
    expect(lines[0]).toMatch(/^FRX\|1\|row 0/);
    const perChunk = new Map<string, number>();
    for (const l of lines) {
      const n = l.split("|")[1] ?? "";
      perChunk.set(n, (perChunk.get(n) ?? 0) + block.bytes(l.split("|").slice(2).join("|")) + 1);
    }
    expect(perChunk.size).toBeGreaterThan(1);
    for (const size of perChunk.values()) expect(size).toBeLessThan(1500 + 100);
  });

  it("wraps the block between BEGIN and END with the text first and the chunked copy after", () => {
    const out = block.render("FRX", "a\nb").split("\n");
    expect(out).toEqual([block.BEGIN, "a", "b", "FRX|1|a", "FRX|1|b", block.END]);
    expect(block.BEGIN).toBe("===== FIRST-RUN BEGIN =====");
    expect(block.END).toBe("===== FIRST-RUN END =====");
  });

  it("keeps the four section budgets, and the four rendered blocks, under 30 KB", () => {
    const tags = { install: "FRINSTALL", snapshot: "FRSNAP", sizes: "FRSIZES", paths: "FRPATHS" };
    const budgets = block.BUDGETS;
    expect(Object.values(budgets).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(13800);
    let total = 0;
    for (const [section, tag] of Object.entries(tags)) {
      // Lines of 100 bytes, as many as the budget holds: a block that uses its whole budget.
      const rows = Math.floor((budgets[section as keyof typeof budgets] + 1) / 101);
      const text = Array.from({ length: rows }, () => "x".repeat(100)).join("\n");
      expect(block.bytes(text)).toBeLessThanOrEqual(budgets[section as keyof typeof budgets]);
      total += block.bytes(block.render(tag, text));
    }
    expect(total).toBeLessThan(30_000);
  });

  it("takes the worst exit status, a tool error over a difference over a pass", () => {
    expect(block.worst([0, 0, 0])).toBe(0);
    expect(block.worst([0, 1, 0])).toBe(1);
    expect(block.worst([1, 2, 0])).toBe(2);
  });
});

describe("first-run doc facts", () => {
  it("reads what the getting-started page quotes", () => {
    const f = facts.docFacts(REPO);
    expect(f.pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(f.installCmd).toBe(`npx playwright-core@${f.pin} install chromium`);
    expect(f.tellsBrowser).toBe(true);
    expect(f.nodeMin).toBeGreaterThanOrEqual(20);
    expect(f.quotedSmoke).toBe("✓ first snapshot in N ms");
    expect(f.smokeRe?.test("  ✓ first snapshot in 412 ms")).toBe(true);
    expect(f.smokeRe?.test("✓ first snapshot in N ms")).toBe(false);
  });

  it("sums the archive sizes Playwright prints while it downloads", () => {
    const out = [
      "Downloading Chromium 141.0 (playwright build v1194) from https://cdn.example/a.zip",
      "|■■■■■■■■| 10% of 100.0 MiB",
      "|■■■■■■■■| 100% of 100.0 MiB",
      "Chromium 141.0 (playwright build v1194) downloaded to /x/chromium-1194",
      "Downloading Chromium Headless Shell 141.0 from https://cdn.example/b.zip",
      "|■■■■■■■■| 100% of 50.0 MiB",
      "Chromium Headless Shell 141.0 downloaded to /x/headless-1194",
    ].join("\n");
    expect(facts.downloadedBytes(out)).toBe(150 * 1024 ** 2);
    expect(facts.downloadedBytes("nothing printed")).toBeUndefined();
  });
});

describe("first-run documented-paths facts", () => {
  it("reads the disabled-tool refusal the troubleshooting page quotes", () => {
    const f = pathFacts.refusalFacts(REPO);
    expect(f.quote).toBe(
      'tool "eval_js" is disabled: its capability "eval" is not enabled on this server',
    );
    expect(f.tool).toBe("eval_js");
    expect(f.capability).toBe("eval");
    expect(f.list).toBe("read,navigation,action,human,eval");
    expect(f.mentions).toEqual(["set_config", "reset_config", "restart"]);
    expect(f.link).toBe("/security/threat-model/#configuring");
  });

  it("reads the CLI signatures, flags, plugin subcommands and doctor areas from the tool reference", () => {
    const c = pathFacts.cliFacts(REPO);
    expect(c.chromeStartFlags.sort()).toEqual(
      ["--disable-background-throttling", "--force", "--insecure", "--port", "--profile"].sort(),
    );
    expect(c.signatures.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        "doctor",
        "chrome start",
        "chrome login",
        "chrome stop",
        "chrome status",
        "init",
        "serve",
        "plugin",
      ]),
    );
    expect(c.flags).toEqual(
      expect.arrayContaining([
        "--verbose",
        "--socket",
        "--engine",
        "--no-write",
        "--no-write-user-config",
        "--no-smoke",
        "--write-user-config",
      ]),
    );
    // Flags of other programs the docs mention in passing are not browxai flags.
    expect(c.flags).not.toContain("--with-deps");
    expect(c.flags).not.toContain("--remote-debugging-port");
    expect(c.flags).not.toContain("--disable-web-security");
    expect(c.pluginSubs).toEqual(["install", "remove", "list", "info", "upgrade", "sync"]);
    expect(c.doctorAreas).toContain("attach");
    expect(c.socketMode).toBe("0600");
  });

  it("reads the shell route's commands, exit codes, output fields and flags from the tool reference", () => {
    const f = pathFacts.shellFacts(REPO);
    expect(f.commands.sort()).toEqual(["call", "tools"]);
    expect(f.codes).toEqual([0, 1, 2, 3, 4]);
    expect(f.fields).toEqual(["isError", "data", "text", "images", "truncated"]);
    expect(f.flags).toEqual(
      expect.arrayContaining([
        "--args-file",
        "--force",
        "--json",
        "--max-chars",
        "--out",
        "--session",
        "--socket",
      ]),
    );
  });

  it("drops the shell route from the CLI facts, keeping flags another command also takes", () => {
    const cli = pathFacts.cliFacts(REPO);
    const shell = pathFacts.shellFacts(REPO);
    const without = pathFacts.withoutShellRoute(cli, shell);
    const paths = without.signatures.map((s) => s.path);
    expect(paths).not.toContain("call");
    expect(paths).not.toContain("tools");
    expect(paths).toContain("serve");
    for (const flag of ["--args-file", "--max-chars", "--out", "--session"]) {
      expect(cli.flags, flag).toContain(flag);
      expect(without.flags, flag).not.toContain(flag);
    }
    // `serve` takes --socket and `chrome start` takes --force, so an older build still shows both.
    expect(without.flags).toContain("--socket");
    expect(without.flags).toContain("--force");
    // `doctor` and `runtime status` take --json too.
    expect(without.flags).toContain("--json");
  });

  it("finds the first-party plugin docs/plugins.md installs by name", () => {
    const p = pathFacts.pluginFacts(REPO);
    expect(p.name).toBe("@browxai/plugin-example");
    expect(p.showsInstall).toBe(true);
    expect(p.showsLocalInstall).toMatch(/^browxai plugin install file:\.\/packages\/plugins\//);
  });
});

describe("first-run process table filters", () => {
  const work = "/tmp/browxai-first-run.AbC123";
  const chrome = `${work}/home/.cache/ms-playwright/chromium-1/chrome-linux/chrome.real`;

  it("counts Chrome main processes from this run only", () => {
    const rows = [
      row(10, [chrome, "--headless", `--user-data-dir=${work}/tmp/p1`]),
      row(11, [chrome, "--type=renderer", `--user-data-dir=${work}/tmp/p1`]),
      row(12, [chrome, "--type=zygote"]),
      row(13, [`${work}/home/.cache/ms-playwright/x/chrome_crashpad_handler`, `--db=${work}/tmp`]),
      row(14, [chrome, "--headless"], "Z"),
      row(15, ["/opt/google/chrome/chrome", "--headless", "--user-data-dir=/home/other/profile"]),
      row(16, [`${work}/home/.cache/ms-playwright/h/headless_shell.real`, "--headless"]),
    ];
    expect(procs.chromeMains(rows, work).map((p) => p.pid)).toEqual([10, 16]);
  });

  it("recognises the browxai server a spawn of the bin makes", () => {
    const bin = row(20, ["node", `${work}/project/node_modules/.bin/browxai`]);
    const cli = row(21, ["node", `${work}/project/node_modules/browxai/dist/cli.js`, "serve"]);
    expect(procs.isBrowxaiProcess(bin)).toBe(true);
    expect(procs.isBrowxaiProcess(cli)).toBe(true);
    expect(procs.isBrowxaiProcess(row(22, ["bash", "-c", "browxai doctor"]))).toBe(false);
    expect(procs.isBrowxaiProcess({ ...bin, state: "Z" })).toBe(false);
  });

  it("polls until the condition holds or the time is up", async () => {
    let n = 0;
    const quick = await procs.waitUntil(() => ++n >= 3, 2000, 5);
    expect(quick.ok).toBe(true);
    const never = await procs.waitUntil(() => false, 30, 5);
    expect(never.ok).toBe(false);
  });
});

describe("first-run core profile rows", () => {
  it("compares versions against the release that added toolProfile", () => {
    expect(sizesCore.atLeast("0.18.0", "0.18.0")).toBe(true);
    expect(sizesCore.atLeast("0.19.0", "0.18.0")).toBe(true);
    expect(sizesCore.atLeast("1.0.0", "0.18.0")).toBe(true);
    expect(sizesCore.atLeast("0.18.0-rc.1", "0.18.0")).toBe(true);
    expect(sizesCore.atLeast("0.17.3", "0.18.0")).toBe(false);
    expect(sizesCore.atLeast("0.9.9", "0.18.0")).toBe(false);
    expect(sizesCore.atLeast(undefined, "0.18.0")).toBe(false);
    expect(sizesCore.atLeast("next", "0.18.0")).toBe(false);
  });

  it("prints a share with one decimal", () => {
    expect(sizesCore.pct(40_000, 200_000)).toBe("20.0");
    expect(sizesCore.pct(1, 3)).toBe("33.3");
  });

  it("splits a core listing into core tools, plugin tools and the discovery tool", () => {
    const tool = (name: string, pad = 0) => ({ name, description: "x".repeat(pad) });
    const tools = [
      tool("click", 10),
      tool("fill", 20),
      tool("tool_catalog", 30),
      tool("figma_x", 5),
    ];
    const out = sizesCore.splitCore(tools, ["click", "fill", "batch"]);
    expect(out.core.count).toBe(2);
    expect(out.core.chars).toBe(JSON.stringify(tools[0]).length + JSON.stringify(tools[1]).length);
    expect(out.catalog).toBe(JSON.stringify(tools[2]).length);
    expect(out.plugin).toEqual([{ name: "figma_x", chars: JSON.stringify(tools[3]).length }]);
    expect(sizesCore.splitCore([tool("click")], ["click"]).catalog).toBeUndefined();
  });
});
