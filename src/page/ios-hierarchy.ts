// The XCUITest element hierarchy composed into browxai's `A11yNode` tree — the
// crux of the ios-app engine. `snapshot`, `find`, `text_search`, `extract` and the
// action window's structure delta all read `A11yNode`, so everything above this
// file is already engine-blind; what it has to do is translate one accessibility
// vocabulary into another and say where the translation loses something.
//
// WHERE THE MAPPING IS LOSSY, stated once, here:
//
//   1. `type` → `role` is a TABLE, and a table is a judgement. XCUITest names 80
//      element types; browxai's `find` ranks and its serialiser reads ARIA-ish
//      roles. `Button` → `button` is exact. `Other` → `generic` throws away the
//      distinction between a layout container and a custom control the app draws
//      itself, which on a React Native screen is most of the tree. The RAW
//      XCUITest type survives on `A11yNode.tag`, so nothing is destroyed — but a
//      role-based locator built from a mapped role is coarser than the platform's
//      own type, and `find`'s ranking sees only the mapped one.
//
//   2. `StaticText` maps to `text`, NOT to browxai's `StaticText`. On the web
//      `StaticText` is presentational — Blink emits one per text run and the
//      string is already the enclosing control's accessible name, so the
//      serialiser drops it. On iOS a `StaticText` is frequently the ONLY node
//      carrying the screen's content, and dropping it would empty the snapshot.
//      Same word, opposite meaning; the mapping resolves it in iOS's favour.
//
//   3. `label` → `name` and `value` → `value` are exact. `placeholder` has no
//      `A11yNode` field and rides on `value` ONLY when the element has no value of
//      its own, which is how a web textbox reports its placeholder too.
//
//   4. Geometry is DROPPED. `A11yNode` carries no rectangle, and `IosElementSubstrate`
//      re-reads bounds from a fresh dump rather than caching the frame that came
//      with this one. That is RFC 0008 §3's re-resolution rule: a cached rectangle
//      is the mechanism by which the owner's trial saw a tap reported against the
//      wrong element.
//
// THE REF RULE (RFC 0008 §3). `elementKey` hashes role, name, path, testId and
// frameId. When an accessibility identifier is present the PATH IS PASSED EMPTY,
// so identity rests on type, label and identifier and the ref survives a layout
// change that moves the node. Without an identifier the full path key applies and
// the ref is snapshot-local, which is the honest status of an unlabelled element.

import type { NativeNode } from "../engine/native-types.js";
import type { A11yNode } from "./a11y-types.js";
import { elementKey, type RefRegistry } from "./refs.js";

/** The attribute name the identifier came from. It reaches the agent through
 *  `A11yNode.testIdAttr` and `buildSelectorHint`, so a tier-1 selector hint reads
 *  `[accessibilityIdentifier="checkout-submit"]` — the attribute is named, so an
 *  agent transcribing the hint knows what was actually queried. */
export const IOS_IDENTIFIER_ATTR = "accessibilityIdentifier";

/** XCUITest element type → the ARIA-ish role browxai's read core speaks. Types
 *  absent from the table fall through to `generic`, and the raw type is always
 *  preserved on `tag`. */
const ROLE_BY_TYPE: Readonly<Record<string, string>> = {
  Application: "WebArea",
  Button: "button",
  Cell: "listitem",
  CheckBox: "checkbox",
  CollectionView: "list",
  DatePicker: "group",
  Image: "img",
  Key: "button",
  Keyboard: "group",
  Link: "link",
  Map: "application",
  NavigationBar: "navigation",
  Other: "generic",
  PageIndicator: "tablist",
  Picker: "combobox",
  PickerWheel: "listbox",
  ProgressIndicator: "progressbar",
  RadioButton: "radio",
  ScrollView: "group",
  SearchField: "searchbox",
  SecureTextField: "textbox",
  SegmentedControl: "tablist",
  Slider: "slider",
  // The word collision the header calls out: iOS StaticText is content, web
  // StaticText is furniture the serialiser drops.
  StaticText: "text",
  StatusBar: "status",
  Stepper: "spinbutton",
  Switch: "switch",
  Tab: "tab",
  TabBar: "tablist",
  Table: "list",
  TextField: "textbox",
  TextView: "textbox",
  Toolbar: "toolbar",
  WebView: "document",
  Window: "group",
};

/** The role for an XCUITest element type. */
export function roleForType(type: string): string {
  return ROLE_BY_TYPE[type] ?? "generic";
}

/** The structural path segment for one node among its siblings —
 *  `Button[2]`, or bare `Button` when it is the only one of its type. Indexed by
 *  TYPE rather than by absolute position so inserting a sibling of a different
 *  type does not renumber it. */
function segmentFor(node: NativeNode, siblings: readonly NativeNode[]): string {
  const sameType = siblings.filter((s) => s.type === node.type);
  if (sameType.length <= 1) return node.type;
  return `${node.type}[${sameType.indexOf(node) + 1}]`;
}

/** The stable key for one native node.
 *
 *  `path` is EMPTY when the node carries an accessibility identifier. That single
 *  line is the whole selector model: identity then rests on type, label and
 *  identifier, so a node that moves keeps its ref, and a node with no identifier
 *  is keyed on where it sits and mints a new ref when it moves. Exported because
 *  the element substrate re-derives the same key over a FRESH dump to re-resolve
 *  a ref — no stored recipe, no cached handle. */
export function nativeElementKey(
  node: Pick<NativeNode, "type" | "label" | "identifier">,
  path: string,
  frameId?: string,
): string {
  const identifier = node.identifier;
  return elementKey({
    role: roleForType(node.type),
    ...(node.label !== undefined ? { name: node.label } : {}),
    path: identifier ? "" : path,
    ...(identifier !== undefined ? { testId: identifier } : {}),
    ...(frameId !== undefined ? { frameId } : {}),
  });
}

/** One native node and the path it was found at. `walkNative` yields these; the
 *  element substrate matches on `key` and the snapshot substrate builds from
 *  `node`. */
export interface NativeWalkEntry {
  node: NativeNode;
  path: string;
  key: string;
}

/** Depth-first walk yielding every node with its structural path and stable key.
 *  One traversal serves both the snapshot build and ref re-resolution, so the two
 *  cannot drift on how a path is spelled. */
export function* walkNative(
  root: NativeNode,
  frameId?: string,
): Generator<NativeWalkEntry, void, undefined> {
  const stack: Array<{ node: NativeNode; path: string }> = [{ node: root, path: root.type }];
  while (stack.length) {
    const next = stack.pop()!;
    yield { ...next, key: nativeElementKey(next.node, next.path, frameId) };
    const children = next.node.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!;
      stack.push({ node: child, path: `${next.path}/${segmentFor(child, children)}` });
    }
  }
}

/** Build the `A11yNode` tree for one hierarchy dump, minting a ref per node
 *  against the session's registry. `screenName` names the root, which is what the
 *  snapshot header renders in place of a page URL. */
export function toA11yTree(
  root: NativeNode,
  refs: RefRegistry,
  screenName: string,
  frameId?: string,
): A11yNode {
  const byPath = new Map<string, A11yNode>();
  let out: A11yNode | undefined;
  for (const entry of walkNative(root, frameId)) {
    const node = a11yNodeFor(entry, refs, frameId);
    byPath.set(entry.path, node);
    const cut = entry.path.lastIndexOf("/");
    if (cut === -1) {
      node.name = screenName;
      out = node;
    } else {
      byPath.get(entry.path.slice(0, cut))?.children.push(node);
    }
  }
  return out ?? { ref: "e0", role: "WebArea", name: screenName, children: [] };
}

function a11yNodeFor(entry: NativeWalkEntry, refs: RefRegistry, frameId?: string): A11yNode {
  const { node, key } = entry;
  const role = roleForType(node.type);
  // A placeholder rides on `value` only when the element has none of its own —
  // the same thing a web textbox reports.
  const value = node.value ?? node.placeholder;
  const ref = refs.forKey(key, {
    role,
    ...(node.label !== undefined ? { name: node.label } : {}),
    ...(node.identifier !== undefined
      ? { testId: node.identifier, testIdAttr: IOS_IDENTIFIER_ATTR }
      : {}),
    source: "a11y",
    ...(frameId !== undefined ? { frameId } : {}),
  });
  return {
    ref,
    role,
    ...(node.label !== undefined ? { name: node.label } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(node.identifier !== undefined
      ? { testId: node.identifier, testIdAttr: IOS_IDENTIFIER_ATTR }
      : {}),
    source: "a11y",
    // The RAW XCUITest type, so the role table above loses nothing recoverable.
    tag: node.type,
    ...(node.enabled ? {} : { disabled: true }),
    ...(node.focused !== undefined ? { focused: node.focused } : {}),
    ...(node.selected !== undefined ? { selected: node.selected } : {}),
    children: [],
  };
}

/** Elements an agent can address by name. Used for the snapshot's own count and
 *  for the unaddressable-element report RFC 0008 asks to ship with the selector
 *  model: a node with neither an identifier nor a label cannot be named, and the
 *  app team is the only party who can fix that. */
export function countAddressable(root: NativeNode): {
  identified: number;
  labelled: number;
  total: number;
} {
  let identified = 0;
  let labelled = 0;
  let total = 0;
  for (const { node } of walkNative(root)) {
    total++;
    if (node.identifier) identified++;
    else if (node.label) labelled++;
  }
  return { identified, labelled, total };
}
