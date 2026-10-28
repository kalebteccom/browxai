import { describe, it, expect } from "vitest";
import { effectiveAriaRole } from "./aria-role.js";

describe("effectiveAriaRole", () => {
  it.each([
    {
      name: "is the identity on a CDP a11y role (no tag present)",
      input: { role: "link" },
      want: "link",
    },
    { name: "maps nav to navigation", input: { role: "nav", tag: "nav" }, want: "navigation" },
    {
      name: "demotes an anchor with a measured absent href",
      input: { role: "a", tag: "a", hasHref: false },
      want: "generic",
    },
    {
      name: "keeps an anchor whose href is unmeasured",
      input: { role: "a", tag: "a" },
      want: "link",
    },
    {
      name: "resolves input type checkbox",
      input: { role: "input", tag: "input", inputType: "checkbox" },
      want: "checkbox",
    },
    {
      name: "resolves input type email to textbox",
      input: { role: "input", tag: "input", inputType: "email" },
      want: "textbox",
    },
    { name: "defaults input to textbox", input: { role: "input", tag: "input" }, want: "textbox" },
    {
      name: "defers to an explicit role on a div",
      input: { role: "button", tag: "div" },
      want: "button",
    },
  ])("effectiveAriaRole: $name", ({ input, want }) => {
    expect(effectiveAriaRole(input)).toBe(want);
  });
});
