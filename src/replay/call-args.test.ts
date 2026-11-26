import { describe, expect, it } from "vitest";
import { recordableArgs } from "./call-args.js";
import { redactedMarker } from "./redact.js";

const MARK = redactedMarker("secret");
const VALUE = "hunter2-real-password";

describe("the arguments a replay records for a tool call", () => {
  it("replaces the value of register_secret and keeps its other arguments", () => {
    const args = { name: "PASSWORD", value: VALUE, scope: "https://app.test", session: "s1" };
    expect(recordableArgs("register_secret", args)).toEqual({
      name: "PASSWORD",
      value: MARK,
      scope: "https://app.test",
      session: "s1",
    });
    // The caller's object is not changed.
    expect(args.value).toBe(VALUE);
  });

  it("replaces a register_secret value that is not a string too", () => {
    expect(recordableArgs("register_secret", { name: "X", value: { nested: VALUE } })).toEqual({
      name: "X",
      value: MARK,
    });
  });

  it("replaces a cookie value and keeps the cookie's name and address", () => {
    expect(
      recordableArgs("cookies_set", { name: "sid", value: VALUE, url: "https://app.test/" }),
    ).toEqual({ name: "sid", value: MARK, url: "https://app.test/" });
  });

  it("replaces an inline storage state and keeps a workspace path", () => {
    const state = { cookies: [{ name: "sid", value: VALUE }], origins: [] };
    expect(recordableArgs("inject_storage_state", { state, mode: "merge" })).toEqual({
      state: MARK,
      mode: "merge",
    });
    expect(recordableArgs("inject_storage_state", { state: "states/login.json" })).toEqual({
      state: "states/login.json",
    });
    expect(recordableArgs("open_session", { session: "s2", storageState: state })).toEqual({
      session: "s2",
      storageState: MARK,
    });
    expect(recordableArgs("open_session", { session: "s2", authState: "login" })).toEqual({
      session: "s2",
      authState: "login",
    });
  });

  it("leaves every other tool's arguments as they are", () => {
    const args = { ref: "e1", value: "plain text" };
    expect(recordableArgs("fill", args)).toEqual(args);
    expect(recordableArgs("get_credential", { account: "github" })).toEqual({ account: "github" });
    expect(recordableArgs("auth_save", { name: "login" })).toEqual({ name: "login" });
  });

  it("does not read a tool name off the object prototype", () => {
    expect(recordableArgs("constructor", { value: "v" })).toEqual({ value: "v" });
    expect(recordableArgs("toString", { value: "v" })).toEqual({ value: "v" });
  });

  it("returns arguments that are not an object as given", () => {
    expect(recordableArgs("register_secret", undefined)).toBeUndefined();
    expect(recordableArgs("register_secret", null)).toBeNull();
    expect(recordableArgs("register_secret", VALUE)).toBe(VALUE);
  });

  it("follows the calls nested in a batch", () => {
    const out = recordableArgs("batch", {
      calls: [
        { tool: "register_secret", args: { name: "PASSWORD", value: VALUE }, label: "a" },
        { tool: "fill", args: { ref: "e1", value: "<PASSWORD>" } },
        { tool: "cookies_set", args: { name: "sid", value: VALUE } },
      ],
      stopOnError: false,
    });
    expect(JSON.stringify(out)).not.toContain(VALUE);
    expect(out).toEqual({
      calls: [
        { tool: "register_secret", args: { name: "PASSWORD", value: MARK }, label: "a" },
        { tool: "fill", args: { ref: "e1", value: "<PASSWORD>" } },
        { tool: "cookies_set", args: { name: "sid", value: MARK } },
      ],
      stopOnError: false,
    });
  });

  it("follows the action of a composing tool", () => {
    const out = recordableArgs("act_and_diff", {
      action: { tool: "register_secret", args: { name: "PASSWORD", value: VALUE } },
      session: "s1",
    });
    expect(out).toEqual({
      action: { tool: "register_secret", args: { name: "PASSWORD", value: MARK } },
      session: "s1",
    });
  });

  it("replaces nested arguments whole past the nesting limit", () => {
    let args: Record<string, unknown> = { name: "PASSWORD", value: VALUE };
    let tool = "register_secret";
    for (let i = 0; i < 40; i++) {
      args = { calls: [{ tool, args }] };
      tool = "batch";
    }
    const out = JSON.stringify(recordableArgs(tool, args));
    expect(out).not.toContain(VALUE);
    expect(out).toContain('"reason":"secret"');
  });
});
