import { describe, it, expect } from "vitest";
import { effectiveAriaRole } from "./aria-role.js";

describe("effectiveAriaRole", () => {
  it("is the identity on CDP a11y roles (no tag present)", () => {
    for (const role of ["link", "button", "textbox", "navigation", "generic", "region", "tab"]) {
      expect(effectiveAriaRole({ role })).toBe(role);
    }
  });

  it("maps the bare tags the DOM-walk emits", () => {
    expect(effectiveAriaRole({ role: "a", tag: "a", hasHref: true })).toBe("link");
    expect(effectiveAriaRole({ role: "nav", tag: "nav" })).toBe("navigation");
    expect(effectiveAriaRole({ role: "div", tag: "div" })).toBe("generic");
    expect(effectiveAriaRole({ role: "textarea", tag: "textarea" })).toBe("textbox");
    expect(effectiveAriaRole({ role: "select", tag: "select" })).toBe("combobox");
  });

  it("demotes an anchor with a measured absent href, and only then", () => {
    expect(effectiveAriaRole({ role: "a", tag: "a", hasHref: false })).toBe("generic");
    expect(effectiveAriaRole({ role: "a", tag: "a" })).toBe("link");
  });

  it("resolves <input> by type, defaulting to textbox", () => {
    expect(effectiveAriaRole({ role: "input", tag: "input", inputType: "checkbox" })).toBe(
      "checkbox",
    );
    expect(effectiveAriaRole({ role: "input", tag: "input", inputType: "range" })).toBe("slider");
    expect(effectiveAriaRole({ role: "input", tag: "input", inputType: "hidden" })).toBe("generic");
    expect(effectiveAriaRole({ role: "input", tag: "input", inputType: "email" })).toBe("textbox");
    expect(effectiveAriaRole({ role: "input", tag: "input" })).toBe("textbox");
  });

  it("defers to an explicit role= attribute", () => {
    expect(effectiveAriaRole({ role: "button", tag: "div" })).toBe("button");
    expect(effectiveAriaRole({ role: "presentation", tag: "a", hasHref: true })).toBe(
      "presentation",
    );
  });

  it("passes an unmapped tag through untouched", () => {
    expect(effectiveAriaRole({ role: "td", tag: "td" })).toBe("td");
    expect(effectiveAriaRole({ role: "custom-widget", tag: "custom-widget" })).toBe(
      "custom-widget",
    );
  });
});
