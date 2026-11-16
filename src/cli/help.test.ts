import { describe, expect, it } from "vitest";
import { helpTarget, wantsHelp } from "./help.js";
import "./register-commands.js";
import { commandFor, registeredCommands, usageFor } from "./command-registry.js";

describe("wantsHelp", () => {
  it("is true for --help and -h in any position", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["-h"])).toBe(true);
    expect(wantsHelp(["chrome", "start", "--help"])).toBe(true);
    expect(wantsHelp(["doctor", "-h"])).toBe(true);
    expect(wantsHelp(["--engine", "firefox", "--help"])).toBe(true);
  });

  it("accepts a leading help as an alias", () => {
    expect(wantsHelp(["help"])).toBe(true);
    expect(wantsHelp(["help", "chrome"])).toBe(true);
  });

  it("is false for ordinary argv", () => {
    expect(wantsHelp([])).toBe(false);
    expect(wantsHelp(["doctor"])).toBe(false);
    expect(wantsHelp(["chrome", "start", "--port", "9222"])).toBe(false);
    expect(wantsHelp(["plugin", "install", "help"])).toBe(false);
  });
  it("is false for near misses and a help that is not the first argument", () => {
    expect(wantsHelp(["-help"])).toBe(false);
    expect(wantsHelp(["--HELP"])).toBe(false);
    expect(wantsHelp(["--helpful"])).toBe(false);
    expect(wantsHelp(["--engine", "help"])).toBe(false);
    expect(wantsHelp(["-hh"])).toBe(false);
  });
});

describe("helpTarget", () => {
  const known = new Set(["doctor", "chrome", "init", "serve", "plugin"]);
  const isCommand = (n: string) => known.has(n);

  it.each([
    [["chrome", "--help"], "chrome"],
    [["chrome", "start", "--help"], "chrome"],
    [["chrome", "login", "-h"], "chrome"],
    [["chrome", "start", "--port", "9222", "--help"], "chrome"],
    [["doctor", "--help"], "doctor"],
    [["init", "-h"], "init"],
    [["serve", "--help"], "serve"],
    [["plugin", "--help"], "plugin"],
    [["help", "chrome"], "chrome"],
    [["help", "serve"], "serve"],
  ])("%j asks for the %s usage", (args, want) => {
    expect(helpTarget(args, isCommand)).toBe(want);
  });

  it.each([
    [["--help"]],
    [["-h"]],
    [["help"]],
    [["help", "nope"]],
    [["help", "--help"]],
    [["--engine", "firefox", "--help"]],
    [["nope", "--help"]],
  ])("%j asks for the top-level text", (args) => {
    expect(helpTarget(args, isCommand)).toBeUndefined();
  });
});

describe("subcommand usage registry", () => {
  it("registers a usage for every subcommand except plugin, which answers help itself", () => {
    expect(registeredCommands().sort()).toEqual(["chrome", "doctor", "init", "plugin", "serve"]);
    expect(usageFor("plugin")).toBeUndefined();
    expect(commandFor("plugin")).toBeDefined();
    for (const name of ["chrome", "doctor", "init", "serve"]) {
      expect(usageFor(name), name).toMatch(new RegExp(`^usage: browxai ${name}\\b`));
    }
  });

  it("gives chrome the chrome usage with every start and login flag", () => {
    const text = usageFor("chrome")!;
    expect(text).toContain("usage: browxai chrome <start|login|stop|status> [flags]");
    for (const flag of [
      "--port",
      "--profile",
      "--force",
      "--insecure",
      "--disable-background-throttling",
      "--url",
    ])
      expect(text, flag).toContain(flag);
    expect(text).not.toContain("browxai drives a browser");
  });

  it("gives each other subcommand its own flags", () => {
    expect(usageFor("doctor")).toContain("--verbose");
    expect(usageFor("serve")).toContain("--socket");
    expect(usageFor("init")).toContain("--no-write-user-config");
  });
});
