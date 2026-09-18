// The UiAutomator view hierarchy, parsed and composed into the `A11yNode` shape
// the snapshot / find / ref machinery already speaks. Pure: a string in, plain
// data out. No adb, no Playwright, no engine type — this module is the reason a
// native tree needs no second ref model.
//
// THE SELECTOR MODEL LIVES HERE (RFC 0008 §3). The owner's trial rejected a
// competing tool because its POSITIONAL refs misreported tapping the wrong
// element twice, and a reported tap on the wrong element is worse than a failed
// tap: it poisons the evidence the whole workflow exists to produce. So:
//
//   - `testID` (Android: the view's `resource-id`) is the only tier-1 selector.
//   - When a node carries one, `elementKey` is minted with an EMPTY `path`, so
//     identity rests on type + label + testID and the ref survives a layout
//     change that moves the node. `native-hierarchy.test.ts` moves a node two
//     levels and asserts the ref holds.
//   - Without a testID the full index path applies and the ref is snapshot-local,
//     which is the honest status of an unlabelled element.
//
// `testIdAttr` records WHICH attribute matched, so a selector hint says what it
// actually queried rather than implying a convention the app did not use.

import { createHash } from "node:crypto";
import type { A11yNode } from "./a11y-types.js";
import { elementKey, type RefRegistry } from "./refs.js";

/** A rectangle in device pixels, as UiAutomator reports node bounds. Declared
 *  here rather than imported so this module stays a leaf. */
export interface NativeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One node of the raw UiAutomator tree, before any role mapping. Field names
 *  mirror the XML attributes so a reader can check them against a `uiautomator
 *  dump` without a translation table. */
export interface NativeNode {
  className: string;
  packageName: string;
  text: string;
  contentDesc: string;
  resourceId: string;
  bounds: NativeRect | null;
  index: number;
  clickable: boolean;
  longClickable: boolean;
  checkable: boolean;
  checked: boolean;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  scrollable: boolean;
  selected: boolean;
  password: boolean;
  children: NativeNode[];
}

/** Raised when the XML is not a hierarchy dump at all. Named so a substrate
 *  reports "the dump was malformed" rather than a parser stack trace. */
export class NativeHierarchyParseError extends Error {
  constructor(detail: string) {
    super(`native-hierarchy-malformed: ${detail}`);
    this.name = "NativeHierarchyParseError";
  }
}

// ─── XML → NativeNode ─────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode the five XML entities plus numeric references. UiAutomator escapes
 *  label text, so an app whose button reads `Save & Close` arrives as
 *  `Save &amp; Close` and would otherwise be matched on the wrong string. */
export function decodeEntities(raw: string): string {
  return raw.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body.startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

/** `bounds="[0,0][1080,2220]"` → a rect. Returns null for the malformed or
 *  absent form rather than a zero rect, because "no box" and "a box at the
 *  origin with no size" are different facts and only one of them is tappable. */
export function parseBounds(raw: string): NativeRect | null {
  const m = /^\[(-?\d+),(-?\d+)]\[(-?\d+),(-?\d+)]$/.exec(raw.trim());
  if (!m) return null;
  const [x1, y1, x2, y2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

const ATTR_RE = /([\w:-]+)\s*=\s*"([^"]*)"/g;

function attrs(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tagBody)) !== null) out[m[1]!] = decodeEntities(m[2]!);
  return out;
}

function nodeFrom(a: Record<string, string>): NativeNode {
  const bool = (k: string): boolean => a[k] === "true";
  return {
    className: a["class"] ?? "",
    packageName: a["package"] ?? "",
    text: a["text"] ?? "",
    contentDesc: a["content-desc"] ?? "",
    resourceId: a["resource-id"] ?? "",
    bounds: parseBounds(a["bounds"] ?? ""),
    index: Number(a["index"] ?? "0") || 0,
    clickable: bool("clickable"),
    longClickable: bool("long-clickable"),
    checkable: bool("checkable"),
    checked: bool("checked"),
    enabled: a["enabled"] !== "false",
    focusable: bool("focusable"),
    focused: bool("focused"),
    scrollable: bool("scrollable"),
    selected: bool("selected"),
    password: bool("password"),
    children: [],
  };
}

/** Parse a `uiautomator dump` document into its root nodes.
 *
 *  A hand-written scanner rather than a dependency: the grammar UiAutomator emits
 *  is one element name with double-quoted attributes and no mixed content, no
 *  namespaces, no CDATA and no processing instructions past the header. Adding an
 *  XML library to parse it would be a supply-chain surface for ~60 lines of
 *  scanning, and browxai bundles no parser it does not need. */
export function parseHierarchy(xml: string): NativeNode[] {
  const roots: NativeNode[] = [];
  const stack: NativeNode[] = [];
  const tagRe = /<\/?([\w:-]+)((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  let seenHierarchy = false;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml)) !== null) {
    const [whole, name, body, selfClose] = [m[0]!, m[1]!, m[2]!, m[3]!];
    if (name === "hierarchy") {
      seenHierarchy = true;
      continue;
    }
    if (name !== "node") continue;
    if (whole.startsWith("</")) {
      stack.pop();
      continue;
    }
    const node = nodeFrom(attrs(body));
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (selfClose !== "/") stack.push(node);
  }
  if (!seenHierarchy) {
    throw new NativeHierarchyParseError("no <hierarchy> element in the dump");
  }
  return roots;
}

// ─── NativeNode → A11yNode ────────────────────────────────────────────────────

/** Android widget class → the role vocabulary `snapshot` already emits. Keyed on
 *  the SHORT class name so a vendor subclass (`androidx.appcompat.widget.
 *  AppCompatButton`) maps like its base. */
const ROLE_BY_CLASS: Record<string, string> = {
  Button: "button",
  ImageButton: "button",
  AppCompatButton: "button",
  EditText: "textbox",
  AppCompatEditText: "textbox",
  TextView: "text",
  AppCompatTextView: "text",
  ImageView: "img",
  AppCompatImageView: "img",
  CheckBox: "checkbox",
  RadioButton: "radio",
  Switch: "switch",
  SwitchCompat: "switch",
  ToggleButton: "switch",
  SeekBar: "slider",
  ProgressBar: "progressbar",
  ScrollView: "scrollable",
  HorizontalScrollView: "scrollable",
  RecyclerView: "list",
  ListView: "list",
  GridView: "grid",
  ViewPager: "tablist",
  TabWidget: "tablist",
  WebView: "document",
  Spinner: "combobox",
};

/** The role for one node.
 *
 *  Class alone is not enough on React Native. RN renders `Pressable` /
 *  `TouchableOpacity` as a bare `android.view.ViewGroup` with `clickable="true"`
 *  — no Button class anywhere — so a class-only mapping would report the app's
 *  entire tap surface as `group` and `find` would rank real buttons below inert
 *  containers. Clickability is therefore consulted before the generic fallbacks,
 *  which is also how TalkBack decides to announce a view as a button. */
export function roleFor(node: NativeNode): string {
  const short = node.className.split(".").pop() ?? "";
  const mapped = ROLE_BY_CLASS[short];
  if (mapped) return mapped;
  if (node.checkable) return "checkbox";
  if (node.clickable) return "button";
  if (node.scrollable) return "scrollable";
  if (short.endsWith("Layout") || short === "ViewGroup") return "group";
  return "generic";
}

/** The accessible name. `content-desc` is RN's `accessibilityLabel` and wins,
 *  because it is what the app AUTHOR chose to call the element; `text` is the
 *  rendered string and is the fallback. A password field's `text` is never used
 *  as a name — it is the typed value, and on Android it arrives as literal dots
 *  or, worse, as the characters themselves. */
export function nameFor(node: NativeNode): string | undefined {
  const desc = node.contentDesc.trim();
  if (desc) return desc;
  if (node.password) return undefined;
  const text = node.text.trim();
  return text || undefined;
}

/** The testID, and the attribute that yielded it.
 *
 *  On React Native 0.81 Android, `testID` surfaces as the view's `resource-id`,
 *  fully qualified as `<package>:id/<testID>`. The qualifier is stripped so the
 *  agent sees the string the app author wrote. A framework-assigned id
 *  (`android:id/content`, `…:id/decor_content_parent`) is NOT a testID: it is the
 *  platform's own furniture, it is identical on every screen of every app, and
 *  treating it as tier-1 identity would anchor refs to the window chrome. Those
 *  are excluded by package. */
export function testIdFor(node: NativeNode): { testId: string; testIdAttr: string } | undefined {
  const raw = node.resourceId.trim();
  if (!raw) return undefined;
  const slash = raw.indexOf("/");
  const qualifier = slash === -1 ? "" : raw.slice(0, slash).replace(/:id$/, "");
  const id = slash === -1 ? raw : raw.slice(slash + 1);
  if (!id) return undefined;
  if (qualifier === "android") return undefined;
  return { testId: id, testIdAttr: "resource-id" };
}

/** One segment of the structural path: the role plus its 1-based position among
 *  siblings that share it, which is what makes the path discriminating without
 *  being a raw index list. */
function pathSegment(node: NativeNode, siblings: NativeNode[]): string {
  const role = roleFor(node);
  const sameRole = siblings.filter((s) => roleFor(s) === role);
  if (sameRole.length <= 1) return role;
  return `${role}[${sameRole.indexOf(node) + 1}]`;
}

/** Options for one compose pass. `frameId` namespaces refs per window so two
 *  windows with identical markup do not collide, exactly as it does for iframes. */
export interface NativeComposeOptions {
  /** The window / webview this tree belongs to. */
  frameId?: string;
  /** Drop nodes with no name, no testID and no tappability. A UiAutomator dump of
   *  a real screen is roughly two-thirds layout containers; keeping them makes the
   *  snapshot large and the ranking noisy. Off for the hierarchy keyframe, which
   *  is evidence and must be complete. */
  prune?: boolean;
}

/** What a node is addressable BY, carried alongside the tree so the element
 *  substrate can re-resolve a ref against a fresh dump without re-deriving it. */
export interface NativeRefRecipe {
  role: string;
  name?: string;
  testId?: string;
  testIdAttr?: string;
  /** The structural path, always recorded even when identity does not rest on
   *  it — a refusal that says "the testID matched nothing, and the path it was
   *  minted at now holds a different element" is a better report than either
   *  fact alone. */
  path: string;
  frameId?: string;
  bounds: NativeRect | null;
}

/** The composed native tree plus the per-ref recipes. */
export interface NativeTree {
  root: A11yNode;
  /** ref id → how to find it again. */
  recipes: Map<string, NativeRefRecipe>;
}

/** Whether a node is worth showing an agent: it says something, it is
 *  identified, or it can be acted on. */
function interesting(node: NativeNode): boolean {
  return (
    Boolean(nameFor(node) ?? testIdFor(node)) ||
    node.clickable ||
    node.checkable ||
    node.scrollable ||
    node.focusable
  );
}

/** Mint the stable key for one native node.
 *
 *  THE NATIVE RULE (RFC 0008 §3): a node with a testID passes an EMPTY path, so
 *  its identity is type + label + testID and it survives being moved. A node
 *  without one passes the full path and its ref is snapshot-local. Both go
 *  through the SAME `elementKey` as every web ref — there is no second ref
 *  model, which is the whole point. */
export function nativeElementKey(recipe: NativeRefRecipe): string {
  return elementKey({
    role: recipe.role,
    name: recipe.name,
    path: recipe.testId ? "" : recipe.path,
    testId: recipe.testId,
    frameId: recipe.frameId,
  });
}

/** Compose a parsed hierarchy into the `A11yNode` tree `snapshot` / `find` read,
 *  minting refs through the session's registry. */
export function composeNativeTree(
  roots: NativeNode[],
  refs: RefRegistry,
  opts: NativeComposeOptions = {},
): NativeTree {
  const recipes = new Map<string, NativeRefRecipe>();
  const build = (node: NativeNode, siblings: NativeNode[], parentPath: string): A11yNode => {
    const segment = pathSegment(node, siblings);
    const path = parentPath ? `${parentPath}/${segment}` : segment;
    const role = roleFor(node);
    const name = nameFor(node);
    const tid = testIdFor(node);
    const recipe: NativeRefRecipe = {
      role,
      name,
      testId: tid?.testId,
      testIdAttr: tid?.testIdAttr,
      path,
      frameId: opts.frameId,
      bounds: node.bounds,
    };
    const ref = refs.forKey(nativeElementKey(recipe), {
      role,
      name,
      testId: tid?.testId,
      testIdAttr: tid?.testIdAttr,
      source: "a11y",
      nativePath: path,
      frameId: opts.frameId,
    });
    recipes.set(ref, recipe);
    const children = node.children
      .filter((c) => !opts.prune || subtreeInteresting(c))
      .map((c) => build(c, node.children, path));
    const out: A11yNode = { ref, role, children };
    if (name) out.name = name;
    if (tid) {
      out.testId = tid.testId;
      out.testIdAttr = tid.testIdAttr;
    }
    // The rendered string, when it is not already the name. `find`'s tier-3
    // matching reads it, and on RN it is often the only human-readable thing on
    // a node whose label lives on its parent.
    const text = node.text.trim();
    if (text && text !== name && !node.password) out.text = text;
    if (!node.enabled) out.disabled = true;
    if (node.checkable) out.checked = node.checked;
    if (node.selected) out.selected = true;
    if (node.focused) out.focused = true;
    out.source = "a11y";
    out.tag = node.className.split(".").pop() ?? node.className;
    return out;
  };
  const top = roots.length === 1 ? roots[0]! : synthesiseRoot(roots);
  return { root: build(top, [top], ""), recipes };
}

/** Whether a subtree holds anything worth keeping. Pruning a container whose
 *  descendants are interesting would delete the interesting ones with it. */
function subtreeInteresting(node: NativeNode): boolean {
  if (interesting(node)) return true;
  return node.children.some(subtreeInteresting);
}

/** A dump can report several top-level windows (the app plus the status bar and
 *  the navigation bar are three roots on Android 12+). One tree is what the
 *  snapshot contract returns, so they are gathered under a synthetic root rather
 *  than silently dropping all but the first. */
function synthesiseRoot(roots: NativeNode[]): NativeNode {
  return {
    className: "android.view.WindowManager",
    packageName: roots[0]?.packageName ?? "",
    text: "",
    contentDesc: "",
    resourceId: "",
    bounds: null,
    index: 0,
    clickable: false,
    longClickable: false,
    checkable: false,
    checked: false,
    enabled: true,
    focusable: false,
    focused: false,
    scrollable: false,
    selected: false,
    password: false,
    children: roots,
  };
}

/** A content hash of a composed tree, for the snapshot-generation counter the
 *  element substrate reports when a ref was minted against an older dump. */
export function hierarchyDigest(roots: NativeNode[]): string {
  const h = createHash("sha256");
  const walk = (n: NativeNode): void => {
    h.update(`${n.className} ${n.resourceId} ${n.contentDesc} ${n.text} `);
    for (const c of n.children) walk(c);
  };
  for (const r of roots) walk(r);
  return h.digest("hex").slice(0, 16);
}
