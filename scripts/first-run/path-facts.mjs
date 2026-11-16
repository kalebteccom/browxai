// What the docs promise for the paths section, read from the checkout at run time so the comparison follows the docs when they
// change: the refusal text on the troubleshooting page, the CLI signatures in docs/tool-reference.md, the plugin subcommands,
// the doctor areas and the first-party plugin name docs/plugins.md installs by. Nothing is hard-coded except the patterns that
// find the quoted strings. test/scripts/first-run-block.test.ts covers this file against the real docs.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (root, rel) => readFileSync(join(root, rel), "utf8");
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}`);
  if (start < 0) return "";
  const next = text.indexOf("\n## ", start + 4);
  return text.slice(start, next < 0 ? undefined : next);
};
const spans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
const flagsIn = (text) => [...new Set(text.match(/--[a-z][a-z-]*/g) ?? [])];
// Flags of other programs that the docs name next to browxai's own.
const FOREIGN = new Set([
  "--with-deps",
  "--remote-debugging-port",
  "--enable-automation",
  "--disable-web-security",
  "--env",
]);

/** The refusal the troubleshooting page quotes for a disabled tool, and what it says to do about it. */
export function refusalFacts(root) {
  const page = section(
    read(root, "website/src/content/docs/guides/troubleshooting.md"),
    "A tool is disabled",
  );
  const quote = /```text\n([^\n]+)\n```/.exec(page)?.[1]?.trim();
  return {
    quote,
    tool: /tool "([\w.]+)"/.exec(quote ?? "")?.[1],
    capability: /capability "([\w-]+)"/.exec(quote ?? "")?.[1],
    // The page's example line: BROWX_CAPABILITIES=read,navigation,action,human,eval
    list: /^BROWX_CAPABILITIES=(\S+)$/m.exec(page)?.[1],
    mentions: ["set_config", "reset_config", "restart"].filter((w) => page.includes(w)),
    link: /\]\((\/security\/threat-model\/#[\w-]+)\)/.exec(page)?.[1],
  };
}

/** The CLI the tool reference documents: every `browxai ...` signature, with its command words and flags. */
export function cliFacts(root) {
  const cli = section(read(root, "docs/tool-reference.md"), "Sub-commands (CLI)");
  const signatures = [];
  for (const line of cli.split("\n").filter((l) => l.startsWith("- `browxai "))) {
    for (const span of spans(line.split(": ")[0]).filter((s) => s.startsWith("browxai "))) {
      const words = [];
      for (const token of span.split(/\s+/).slice(1)) {
        if (/^[[<-]/.test(token)) break;
        words.push(token);
      }
      signatures.push({
        path: words.join(" "),
        flags: flagsIn(span).filter((f) => !FOREIGN.has(f)),
      });
    }
  }
  // Bare flag spans on the pages a newcomer reads: `--no-write`, `--engine`, ...
  const bare = ["website/src/content/docs/getting-started.md", "README.md"]
    .flatMap((rel) => spans(read(root, rel)))
    .concat(spans(cli))
    .filter((s) => /^--[a-z][a-z-]*$/.test(s) && !FOREIGN.has(s));
  const pluginLine = cli.split("\n").find((l) => l.startsWith("- `browxai plugin <sub>`")) ?? "";
  const subs = (pluginLine.split("Subcommands:")[1] ?? "").split(". ")[0];
  const doctorAreas = /one `✓`\/`✗` line per area \(([^)]*)\)/.exec(cli)?.[1];
  return {
    signatures,
    flags: [...new Set([...signatures.flatMap((s) => s.flags), ...bare])].sort(),
    chromeStartFlags: signatures.find((s) => s.path === "chrome start")?.flags ?? [],
    pluginSubs: spans(subs).map((s) => s.split(/\s+/)[0]),
    doctorAreas: doctorAreas ? doctorAreas.split(",").map((a) => a.trim()) : [],
    // `browxai serve --socket`: "The socket is created owner-only (`0600`)."
    socketMode: /owner-only \(`(0[0-7]{3})`\)/.exec(cli)?.[1],
  };
}

/** The first-party plugin docs/plugins.md lists as installable by name, and the install command it shows. */
export function pluginFacts(root) {
  const page = read(root, "docs/plugins.md");
  return {
    // The reference plugin has no capabilities, so installing it needs no widened BROWX_CAPABILITIES.
    name: /`(@browxai\/plugin-example)`/.exec(page)?.[1],
    showsInstall: /browxai plugin install @browxai\/plugin-[a-z]+/.test(page),
    showsLocalInstall: /browxai plugin install file:\.\/packages\/plugins\/[a-z]+/.exec(page)?.[0],
  };
}
