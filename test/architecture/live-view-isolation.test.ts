// A source scan of `src/` that guards the live view against regressions in this
// repository: a new reader of the CDP screencast, a tool module that names the
// view registry, or a view module that gains a filesystem or log call that could
// carry a frame, fails here before it ships. It is a regex scan, so it is not a
// sandbox. It does not see code outside `src/`, and plugins are trusted
// in-process code that can reach a CDP handle without going through any of this
// (a documented residual in docs/threat-model.md). What keeps frames off the
// agent's tools is that no tool is registered for the stream, which the keystone
// checks against the live handler list.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const SRC = sources(join(ROOT, "src"));
const rel = (p: string): string => relative(ROOT, p).split("\\").join("/");
const holding = (re: RegExp): string[] =>
  SRC.filter((p) => re.test(readFileSync(p, "utf8"))).map(rel);

describe("live view isolation", () => {
  it("reads the screencast in one file only, the operator frame source", () => {
    expect(holding(/Page\.(startScreencast|stopScreencast|screencastFrame)/)).toEqual([
      "src/helper/operator-screencast.ts",
    ]);
  });

  it("is reached from the operator channel and the session registry, and nothing else", () => {
    const importers = holding(/operator-view|operator-screencast/).filter(
      (f) => !f.startsWith("src/helper/operator-view") && f !== "src/helper/operator-screencast.ts",
    );
    expect(importers.sort()).toEqual([
      "src/helper/operator-channel.ts",
      "src/tools/session-registry.ts",
    ]);
  });

  it("is registered on a session only by the session registry", () => {
    expect(holding(/liveView\??\.\s*(register|unregister)/)).toEqual([
      "src/tools/session-registry.ts",
    ]);
  });

  it("is never named by a tool, a page helper, the SDK or the plugin runtime in src/", () => {
    const reach = holding(/\bliveView\b/).filter(
      (f) =>
        (f.startsWith("src/tools/") && f !== "src/tools/session-registry.ts") ||
        f.startsWith("src/page/") ||
        f.startsWith("src/sdk/") ||
        f.startsWith("src/plugin/"),
    );
    expect(reach).toEqual([]);
  });

  it("writes no frame to disk, a log or a result from the view modules", () => {
    for (const f of [
      "src/helper/operator-view.ts",
      "src/helper/operator-view-hub.ts",
      "src/helper/operator-screencast.ts",
    ]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect(text, f).not.toMatch(/node:fs|writeFile|appendFile|createWriteStream/);
      // A log line there carries a reason code, never frame data or an error message.
      for (const call of text.match(/log\.\w+\([^)]*\)/g) ?? []) {
        expect(call, f).not.toMatch(/\bdata\b|\.message|\be\b|\berr\b/);
      }
    }
  });
});
