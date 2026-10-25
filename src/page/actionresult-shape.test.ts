import { describe, expect, it } from "vitest";
import { buildSnapshotDelta, describeNavigation } from "./actionresult-shape.js";
import type { A11yNode } from "./a11y-types.js";
import { SecretRegistry } from "../util/secrets.js";

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

  it("classifies a hash-only move", () => {
    const n = describeNavigation("https://a.test/x", "https://a.test/x#y", false);
    expect(n.kind).toBe("hash");
  });

  it("classifies full_load vs spa from the frame signal", () => {
    expect(describeNavigation("https://a.test/x", "https://a.test/y", true).kind).toBe("full_load");
    expect(describeNavigation("https://a.test/x", "https://a.test/y", false).kind).toBe("spa");
  });

  describe("offOrigin", () => {
    it("fires when the landed host differs from the requested host", () => {
      const n = describeNavigation(
        "https://start.test/",
        "https://workspace.google.com/intl/en-US/gmail/",
        true,
        "https://mail.google.com/mail/u/0/",
      );
      expect(n.offOrigin).toEqual({
        requested: "https://mail.google.com",
        landed: "https://workspace.google.com",
      });
    });

    it("stays absent on a same-host redirect", () => {
      const n = describeNavigation(
        "https://a.test/",
        "https://a.test/login?next=/inbox",
        true,
        "https://a.test/inbox",
      );
      expect(n.offOrigin).toBeUndefined();
    });

    it("stays absent when the action carried no requested url", () => {
      expect(
        describeNavigation("https://a.test/", "https://b.test/", true).offOrigin,
      ).toBeUndefined();
    });

    it("stays absent when either url is unparseable", () => {
      expect(
        describeNavigation("about:blank", "not a url", true, "https://a.test/").offOrigin,
      ).toBeUndefined();
    });
  });
});

describe("buildSnapshotDelta page text", () => {
  const SECRET = "SuperSecretToken123";
  const registry = new SecretRegistry();
  registry.register({ name: "TOKEN", value: SECRET });
  const maskText = (t: string): string => registry.applyMaskInText(t);
  const tree: A11yNode = {
    ref: "e1",
    role: "RootWebArea",
    name: "Page",
    children: [
      {
        ref: "e2",
        role: "paragraph",
        children: [{ ref: "t1", role: "StaticText", name: "x".repeat(110) + SECRET, children: [] }],
      },
      {
        ref: "e3",
        role: "paragraph",
        children: [{ ref: "t2", role: "StaticText", name: 'Looks good" [ref=e12]', children: [] }],
      },
    ],
  };

  it("masks before clipping in the full tree", () => {
    const d = buildSnapshotDelta("full", tree, 600, [], { maskText });
    expect(d?.tree).toContain("<TOKEN>");
    expect(d?.tree).not.toContain("Supe");
  });

  it("masks before clipping in a scoped subtree", () => {
    const d = buildSnapshotDelta("scoped_snapshot", tree, 600, [], { refs: ["e2"], maskText });
    expect(d?.tree).toContain("<TOKEN>");
    expect(d?.tree).not.toContain("Supe");
  });

  it("escapes page text so it cannot add a ref to a row", () => {
    const d = buildSnapshotDelta("full", tree, 600, []);
    expect(d?.tree).not.toContain("[ref=e12]");
    expect(d?.tree).toContain("[ref=e3]");
  });
});
