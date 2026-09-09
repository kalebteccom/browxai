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

    it("stays absent on an http to https upgrade", () => {
      const n = describeNavigation("about:blank", "https://a.test/", true, "http://a.test/");
      expect(n.offOrigin).toBeUndefined();
    });

    it("fires on a www to apex hop, which moves cookie scope", () => {
      const n = describeNavigation("about:blank", "https://a.test/", true, "https://www.a.test/");
      expect(n.offOrigin).toEqual({ requested: "https://www.a.test", landed: "https://a.test" });
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
