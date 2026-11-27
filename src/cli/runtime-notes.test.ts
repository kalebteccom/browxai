import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addVersion,
  fakeAgent,
  tempRuntime,
  type TempRuntime,
} from "./__fixtures__/runtime-tree.js";
import { readJournal } from "./runtime-journal.js";
import { cliOf, versionDir } from "./runtime-layout.js";
import {
  firstStartLine,
  readNotesTable,
  recordNotes,
  upgradingFileOf,
  versionsBetween,
} from "./runtime-notes.js";
import { readState, switchCurrent, writeState, type RuntimeState } from "./runtime-store.js";
import { runRuntime } from "./runtime.js";

let rt: TempRuntime | undefined;
afterEach(() => {
  rt?.cleanup();
  rt = undefined;
});

const NOTES = {
  "0.24.0": "**Upgrading from 0.23.0.** Set `BROWX_X=1` to keep the old default.",
  "0.22.0": "**Upgrading from 0.21.0.** Add `file-io` to `BROWX_CAPABILITIES`.",
  "0.20.0": "**Upgrading from 0.19.1.** Older note.",
};

function upgradingJson(notes: Record<string, string>): string {
  return JSON.stringify({ schemaVersion: 1, notes });
}

/** A version whose dist/ carries an upgrading.json with `notes`. */
function versionWithNotes(v: string, notes: Record<string, string> = NOTES): void {
  const cli = addVersion(rt!.paths, v);
  writeFileSync(upgradingFileOf(cli), upgradingJson(notes));
}

function runtimeOn(current: string, state: RuntimeState = {}): TempRuntime {
  rt = tempRuntime();
  for (const v of ["0.21.0", "0.22.0", "0.23.0", "0.24.0"]) versionWithNotes(v);
  switchCurrent(rt.paths, current);
  writeState(rt.paths, state);
  return rt;
}

async function notes(args: string[], version = "0.24.0") {
  let out = "";
  let err = "";
  const code = await runRuntime(["notes", ...args], {
    ctx: rt!.ctx,
    appBundle: () => undefined,
    list: async () => [],
    agent: fakeAgent(),
    version,
    ownNotes: () => undefined,
    out: (t) => (out += t),
    err: (t) => (err += t),
  });
  return { code, out, err };
}

describe("dist/upgrading.json", () => {
  it("reads the notes of each version", () => {
    rt = tempRuntime();
    const file = join(rt.home, "upgrading.json");
    writeFileSync(file, upgradingJson({ ...NOTES, "not-a-version": "x", "0.1.0": "  " }));
    expect(readNotesTable(file)).toEqual(NOTES);
  });

  it.each([
    ["missing", undefined],
    ["not JSON", "{"],
    ["another schema version", JSON.stringify({ schemaVersion: 2, notes: NOTES })],
    ["notes not an object", JSON.stringify({ schemaVersion: 1, notes: [] })],
  ])("is ignored when %s", (_label, text) => {
    rt = tempRuntime();
    const file = join(rt.home, "upgrading.json");
    if (text !== undefined) writeFileSync(file, text);
    expect(readNotesTable(file)).toBeUndefined();
  });

  it("lists the versions after one version up to another, oldest first", () => {
    expect(versionsBetween(NOTES, "0.20.0", "0.24.0")).toEqual(["0.22.0", "0.24.0"]);
    expect(versionsBetween(NOTES, "0.21.0", "0.23.0")).toEqual(["0.22.0"]);
    expect(versionsBetween(NOTES, "0.24.0", "0.24.0")).toEqual([]);
  });
});

describe("recording notes after a switch", () => {
  it("writes each crossed version's notes to notes/ and the journal, and lists them unseen", () => {
    runtimeOn("0.24.0");
    const NOW = Date.parse("2026-11-27T12:00:00.000Z");
    expect(recordNotes(rt!.paths, "0.21.0", "0.24.0", NOW, "auto")).toEqual(["0.22.0", "0.24.0"]);
    const file = join(rt!.paths.notes, "0.22.0.md");
    expect(readFileSync(file, "utf8")).toBe(`Upgrading notes for 0.22.0\n\n${NOTES["0.22.0"]}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(rt!.paths.notes).mode & 0o777).toBe(0o700);
    expect(readState(rt!.paths).notesUnseen).toEqual(["0.22.0", "0.24.0"]);
    expect(readJournal(rt!.paths)).toEqual([
      {
        at: "2026-11-27T12:00:00.000Z",
        mode: "auto",
        event: "notes",
        version: "0.22.0",
        notes: NOTES["0.22.0"],
      },
      {
        at: "2026-11-27T12:00:00.000Z",
        mode: "auto",
        event: "notes",
        version: "0.24.0",
        notes: NOTES["0.24.0"],
      },
    ]);
  });

  it("adds to the versions already unseen", () => {
    runtimeOn("0.24.0", { notesUnseen: ["0.22.0"] });
    recordNotes(rt!.paths, "0.23.0", "0.24.0", 0, "manual");
    expect(readState(rt!.paths).notesUnseen).toEqual(["0.22.0", "0.24.0"]);
  });

  it.each([
    ["a first install", undefined, "0.24.0"],
    ["a downgrade", "0.24.0", "0.22.0"],
    ["a version with no notes after it", "0.22.0", "0.23.0"],
  ])("writes nothing for %s", (_label, from, to) => {
    runtimeOn(to);
    expect(recordNotes(rt!.paths, from, to, 0, "auto")).toEqual([]);
    expect(existsSync(rt!.paths.notes)).toBe(false);
    expect(readState(rt!.paths).notesUnseen).toBeUndefined();
  });

  it("writes nothing when the new version ships no upgrading.json", () => {
    rt = tempRuntime();
    addVersion(rt.paths, "0.21.0");
    addVersion(rt.paths, "0.22.0");
    switchCurrent(rt.paths, "0.22.0");
    expect(recordNotes(rt.paths, "0.21.0", "0.22.0", 0, "auto")).toEqual([]);
  });
});

describe("browxai runtime notes", () => {
  it("prints the notes of one version and marks it seen", async () => {
    runtimeOn("0.24.0", { notesUnseen: ["0.22.0", "0.24.0"] });
    const r = await notes(["0.22.0"]);
    expect(r).toEqual({
      code: 0,
      out: `Upgrading notes for 0.22.0\n\n${NOTES["0.22.0"]}\n`,
      err: "",
    });
    expect(readState(rt!.paths).notesUnseen).toEqual(["0.24.0"]);
  });

  it("says so for a version with no notes", async () => {
    runtimeOn("0.24.0");
    const r = await notes(["0.23.0"]);
    expect(r).toEqual({
      code: 0,
      out: "browxai 0.23.0 has no Upgrading notes. Nothing to do.\n",
      err: "",
    });
  });

  it("prints the unseen notes, oldest first, and clears them", async () => {
    runtimeOn("0.24.0", { previous: "0.23.0", notesUnseen: ["0.22.0", "0.24.0"] });
    const r = await notes([]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `Upgrading notes for 0.22.0\n\n${NOTES["0.22.0"]}\n\nUpgrading notes for 0.24.0\n\n${NOTES["0.24.0"]}\n`,
    );
    expect(readState(rt!.paths).notesUnseen).toBeUndefined();
  });

  it("prints the notes from this process's version up to current", async () => {
    runtimeOn("0.24.0");
    const r = await notes([], "0.21.0");
    expect(r.out).toContain("Upgrading notes for 0.22.0");
    expect(r.out).toContain("Upgrading notes for 0.24.0");
    expect(r.out).not.toContain("0.20.0");
  });

  it("starts from previous when this process runs current", async () => {
    runtimeOn("0.24.0", { previous: "0.23.0" });
    const r = await notes([], "0.24.0");
    expect(r.out).toBe(`Upgrading notes for 0.24.0\n\n${NOTES["0.24.0"]}\n`);
  });

  it("says there is nothing to read", async () => {
    runtimeOn("0.24.0");
    expect((await notes([], "0.24.0")).out).toBe(
      "No unread Upgrading notes. browxai runtime notes V prints the notes of version V.\n",
    );
    writeState(rt!.paths, { previous: "0.22.0" });
    switchCurrent(rt!.paths, "0.23.0");
    expect((await notes([], "0.23.0")).out).toBe(
      "No Upgrading notes from 0.22.0 to 0.23.0. Nothing to do.\n",
    );
  });

  it("reads notes/ for a version current's table no longer has", async () => {
    runtimeOn("0.24.0");
    recordNotes(rt!.paths, "0.21.0", "0.24.0", 0, "auto");
    writeFileSync(upgradingFileOf(cliOf(versionDir(rt!.paths, "0.24.0"))), upgradingJson({}));
    const r = await notes(["0.22.0"]);
    expect(r.out).toBe(`Upgrading notes for 0.22.0\n\n${NOTES["0.22.0"]}\n`);
  });

  it.each([[["x"]], [["0.22"]], [["0.22.0", "0.23.0"]], [["--json"]]])(
    "is a usage error for %j",
    async (args: string[]) => {
      runtimeOn("0.24.0");
      expect((await notes(args)).code).toBe(2);
    },
  );
});

describe("the first-start line", () => {
  const env = (version: string) => ({
    BROWX_RUNTIME_DIR: rt!.paths.root,
    BROWX_RUNTIME_VERSION: version,
  });

  it("names the version once, on the first start", () => {
    runtimeOn("0.24.0", { notesUnseen: ["0.24.0"] });
    expect(firstStartLine(env("0.24.0"))).toBe(
      "browxai 0.24.0 is new on this machine. Upgrading notes: browxai runtime notes 0.24.0\n",
    );
    expect(firstStartLine(env("0.24.0"))).toBeUndefined();
  });

  it("lists several unseen versions", () => {
    runtimeOn("0.24.0", { notesUnseen: ["0.22.0", "0.24.0"] });
    expect(firstStartLine(env("0.24.0"))).toBe(
      "browxai 0.24.0 is new on this machine, with Upgrading notes for 0.22.0, 0.24.0. Read them: browxai runtime notes\n",
    );
  });

  it("is plain text with no dashes", () => {
    runtimeOn("0.24.0", { notesUnseen: ["0.22.0", "0.24.0"] });
    expect(firstStartLine(env("0.24.0"))).not.toMatch(/[\u2013\u2014]/);
  });

  it.each([
    ["no unseen notes", {}, "0.24.0"],
    ["notes only for a newer version", { notesUnseen: ["0.24.0"] }, "0.22.0"],
  ])("prints nothing with %s", (_label, state: RuntimeState, version) => {
    runtimeOn("0.24.0", state);
    expect(firstStartLine(env(version))).toBeUndefined();
  });

  it.each([
    [{}],
    [{ BROWX_RUNTIME_DIR: "relative/dir", BROWX_RUNTIME_VERSION: "0.24.0" }],
    [{ BROWX_RUNTIME_VERSION: "0.24.0" }],
  ])("prints nothing outside a runtime (%j)", (e) => {
    runtimeOn("0.24.0", { notesUnseen: ["0.24.0"] });
    expect(firstStartLine(e)).toBeUndefined();
  });

  it("prints nothing for a version that isn't a version", () => {
    runtimeOn("0.24.0", { notesUnseen: ["0.24.0"] });
    expect(firstStartLine(env("../x"))).toBeUndefined();
  });
});
