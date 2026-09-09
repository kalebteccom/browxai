// HTML tag → implicit ARIA role, resolved at the point of use.
//
// The DOM-walk fallback stores `getAttribute("role") || tagName` in
// `A11yNode.role`, so a fallback-sourced `<a>` arrives as role "a" and a `<nav>`
// as role "nav". `role` is hashed into `elementKey`, so normalising it at the
// merge would rotate every DOM-sourced ref and invalidate refs already handed to
// a caller. Consumers that reason about ARIA semantics resolve here instead.
//
// Deliberately partial — it covers the tags the DOM-walk predicate can emit and
// only the roles its consumers test for. Every key that is also a valid ARIA
// role name maps to itself, so applying this to an already-ARIA role (the CDP
// a11y path, or an explicit `role=` attribute) is a no-op.

export interface RoleShape {
  /** `getAttribute("role") || tagName` on the DOM-walk path; a real ARIA role on the CDP path. */
  role: string;
  /** Lowercased tag name. DOM-walk nodes only; absent on CDP a11y nodes. */
  tag?: string;
  /** Whether an `<a>` / `<area>` carries an `href` attribute. */
  hasHref?: boolean;
  /** Lowercased `<input type>`; empty for every other tag. */
  inputType?: string;
}

const TAG_ROLES: Record<string, string> = {
  button: "button",
  select: "combobox",
  textarea: "textbox",
  summary: "button",
  option: "option",
  nav: "navigation",
  main: "main",
  form: "form",
  search: "search",
  header: "banner",
  footer: "contentinfo",
  aside: "complementary",
  div: "generic",
  span: "generic",
};

const INPUT_TYPE_ROLES: Record<string, string> = {
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  hidden: "generic",
};

export function effectiveAriaRole(el: RoleShape): string {
  // A DOM-walk role that differs from the tag came from an explicit `role=`
  // attribute and is already ARIA.
  if (el.tag !== undefined && el.role !== el.tag) return el.role;
  const tag = el.tag ?? el.role;
  // The walk's predicate selects `a[href]`, so an anchor reaching a consumer
  // without href evidence is a link; only a measured absence demotes it.
  if (tag === "a" || tag === "area") return el.hasHref === false ? "generic" : "link";
  if (tag === "input") return INPUT_TYPE_ROLES[el.inputType || "text"] ?? "textbox";
  return TAG_ROLES[tag] ?? el.role;
}
