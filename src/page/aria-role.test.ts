import { describe, it, expect } from "vitest";
import { effectiveAriaRole } from "./aria-role.js";

describe("effectiveAriaRole", () => {
  it.each([
    ...["link", "button", "textbox", "navigation", "generic", "region", "tab"].map((role) => ({
      name: `is the identity on the CDP a11y role ${role} (no tag present)`,
      input: { role },
      want: role,
    })),
    { name: "maps a to link", input: { role: "a", tag: "a", hasHref: true }, want: "link" },
    { name: "maps nav to navigation", input: { role: "nav", tag: "nav" }, want: "navigation" },
    { name: "maps div to generic", input: { role: "div", tag: "div" }, want: "generic" },
    {
      name: "maps textarea to textbox",
      input: { role: "textarea", tag: "textarea" },
      want: "textbox",
    },
    { name: "maps select to combobox", input: { role: "select", tag: "select" }, want: "combobox" },
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
      name: "resolves input type range",
      input: { role: "input", tag: "input", inputType: "range" },
      want: "slider",
    },
    {
      name: "resolves input type hidden",
      input: { role: "input", tag: "input", inputType: "hidden" },
      want: "generic",
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
    {
      name: "defers to an explicit presentation role on an anchor",
      input: { role: "presentation", tag: "a", hasHref: true },
      want: "presentation",
    },
  ])("effectiveAriaRole: $name", ({ input, want }) => {
    expect(effectiveAriaRole(input)).toBe(want);
  });
});
