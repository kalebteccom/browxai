import { describe, expect, it } from "vitest";
import { describeNavigation } from "./actionresult-shape.js";

describe("describeNavigation", () => {
  it("reports no change when the url is identical", () => {
    const n = describeNavigation("https://a.test/x", "https://a.test/x", false);
    expect(n).toEqual({
      changed: false,
      from: "https://a.test/x",
      to: "https://a.test/x",
      kind: null,
    });
  });

  it.each([
    { name: "a hash-only move", to: "https://a.test/x#y", full: false, kind: "hash" },
    {
      name: "full_load from the frame signal",
      to: "https://a.test/y",
      full: true,
      kind: "full_load",
    },
    { name: "spa from the frame signal", to: "https://a.test/y", full: false, kind: "spa" },
  ])("describeNavigation classifies $name", ({ to, full, kind }) => {
    expect(describeNavigation("https://a.test/x", to, full).kind).toBe(kind);
  });

  it.each<{
    name: string;
    args: [string, string, boolean, string?];
    want: { requested: string; landed: string } | undefined;
  }>([
    {
      name: "fires when the landed host differs from the requested host",
      args: [
        "https://start.test/",
        "https://workspace.google.com/intl/en-US/gmail/",
        true,
        "https://mail.google.com/mail/u/0/",
      ],
      want: { requested: "https://mail.google.com", landed: "https://workspace.google.com" },
    },
    {
      name: "stays absent on a same-host redirect",
      args: ["https://a.test/", "https://a.test/login?next=/inbox", true, "https://a.test/inbox"],
      want: undefined,
    },
    {
      name: "stays absent when the action carried no requested url",
      args: ["https://a.test/", "https://b.test/", true],
      want: undefined,
    },
    {
      name: "stays absent when either url is unparseable",
      args: ["about:blank", "not a url", true, "https://a.test/"],
      want: undefined,
    },
  ])("describeNavigation offOrigin $name", ({ args, want }) => {
    expect(describeNavigation(...args).offOrigin).toEqual(want);
  });
});
