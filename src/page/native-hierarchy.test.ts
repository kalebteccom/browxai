// The native hierarchy walker, and the selector model that decides whether this
// engine is trustworthy.
//
// The fixtures are REAL `uiautomator dump` output shapes, including the
// React-Native rendering that makes a class-only role mapping wrong (a
// `Pressable` is a bare `android.view.ViewGroup` with `clickable="true"`).

import { describe, it, expect } from "vitest";
import { RefRegistry } from "./refs.js";
import {
  composeNativeTree,
  decodeEntities,
  hierarchyDigest,
  NativeHierarchyParseError,
  nameFor,
  nativeElementKey,
  parseBounds,
  parseHierarchy,
  roleFor,
  testIdFor,
  type NativeNode,
} from "./native-hierarchy.js";
import { walk } from "./a11y-types.js";

/** Build a dump document from node XML, with the header UiAutomator emits. */
function dump(inner: string): string {
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${inner}</hierarchy>`;
}

const ATTRS =
  'index="0" text="" resource-id="" class="android.view.View" package="com.acme.app" ' +
  'content-desc="" checkable="false" checked="false" clickable="false" enabled="true" ' +
  'focusable="false" focused="false" scrollable="false" long-clickable="false" ' +
  'password="false" selected="false" bounds="[0,0][100,100]"';

function node(overrides: Record<string, string> = {}, children = ""): string {
  const merged = Object.entries(overrides).reduce(
    (acc, [k, v]) => acc.replace(new RegExp(`${k}="[^"]*"`), `${k}="${v}"`),
    ATTRS,
  );
  return children ? `<node ${merged}>${children}</node>` : `<node ${merged} />`;
}

describe("parseHierarchy", () => {
  it("parses nested nodes into a tree", () => {
    const roots = parseHierarchy(
      dump(node({ class: "android.widget.FrameLayout" }, node({ text: "hello" }))),
    );
    expect(roots).toHaveLength(1);
    expect(roots[0]!.className).toBe("android.widget.FrameLayout");
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.text).toBe("hello");
  });

  it("handles self-closing and paired nodes in the same document", () => {
    const roots = parseHierarchy(
      dump(node({}, node({ text: "a" }) + node({ text: "b" }, node({ text: "c" })))),
    );
    expect(roots[0]!.children.map((c) => c.text)).toEqual(["a", "b"]);
    expect(roots[0]!.children[1]!.children[0]!.text).toBe("c");
  });

  it("keeps every top-level window rather than dropping all but the first", () => {
    // Android 12+ reports the app, the status bar and the navigation bar as
    // three roots. Dropping two of them loses the system UI an agent may need to
    // dismiss a permission dialog.
    const roots = parseHierarchy(dump(node({ text: "app" }) + node({ text: "statusbar" })));
    expect(roots).toHaveLength(2);
  });

  it("decodes escaped label text", () => {
    // A button reading `Save & Close` arrives as `Save &amp; Close`; matching on
    // the raw string would silently never find it.
    const roots = parseHierarchy(dump(node({ text: "Save &amp; Close &lt;3" })));
    expect(roots[0]!.text).toBe("Save & Close <3");
  });

  it("refuses a document that is not a hierarchy dump", () => {
    expect(() => parseHierarchy("ERROR: could not get idle state.")).toThrow(
      NativeHierarchyParseError,
    );
  });

  it("survives an attribute value containing a > character", () => {
    const roots = parseHierarchy(dump(node({ text: "a &gt; b" })));
    expect(roots[0]!.text).toBe("a > b");
  });
});

describe("decodeEntities / parseBounds", () => {
  it("decodes numeric references in both bases", () => {
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
  });
  it("leaves an unknown entity alone rather than eating it", () => {
    expect(decodeEntities("&nope;")).toBe("&nope;");
  });
  it("parses bounds into an x/y/width/height rect", () => {
    expect(parseBounds("[10,20][110,220]")).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });
  it("returns null for absent bounds instead of a zero rect", () => {
    // "no box" and "a zero-sized box at the origin" are different facts and only
    // one of them is tappable.
    expect(parseBounds("")).toBeNull();
  });
});

describe("roleFor", () => {
  const n = (over: Partial<NativeNode>): NativeNode => ({
    className: "android.view.View",
    packageName: "com.acme.app",
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
    children: [],
    ...over,
  });

  it("maps the widget classes onto the snapshot role vocabulary", () => {
    expect(roleFor(n({ className: "android.widget.Button" }))).toBe("button");
    expect(roleFor(n({ className: "android.widget.EditText" }))).toBe("textbox");
    expect(roleFor(n({ className: "android.widget.TextView" }))).toBe("text");
  });

  it("maps a vendor subclass like its base", () => {
    expect(roleFor(n({ className: "androidx.appcompat.widget.AppCompatEditText" }))).toBe(
      "textbox",
    );
  });

  it("reports a clickable React Native ViewGroup as a button", () => {
    // THE RN CASE. `Pressable` / `TouchableOpacity` render as a bare ViewGroup
    // with clickable="true" and no Button class anywhere. A class-only mapping
    // reports the app's entire tap surface as `group`, and `find` then ranks real
    // buttons below inert containers.
    expect(roleFor(n({ className: "android.view.ViewGroup", clickable: true }))).toBe("button");
    expect(roleFor(n({ className: "android.view.ViewGroup" }))).toBe("group");
  });
});

describe("nameFor", () => {
  const base: NativeNode = parseHierarchy(dump(node()))[0]!;

  it("prefers the accessibility label over the rendered text", () => {
    expect(nameFor({ ...base, contentDesc: "Submit order", text: "Submit" })).toBe("Submit order");
  });

  it("falls back to the rendered text", () => {
    expect(nameFor({ ...base, text: "Submit" })).toBe("Submit");
  });

  it("never names a password field after its own contents", () => {
    // Android reports a secure field's `text` as the typed characters on some
    // OEM keyboards. Using it as the accessible name would put the value in the
    // snapshot, the ref hash and the evidence log.
    expect(nameFor({ ...base, password: true, text: "hunter2" })).toBeUndefined();
  });
});

describe("testIdFor", () => {
  const base: NativeNode = parseHierarchy(dump(node()))[0]!;

  it("strips the package qualifier React Native adds", () => {
    expect(testIdFor({ ...base, resourceId: "com.acme.app:id/checkout-submit" })).toEqual({
      testId: "checkout-submit",
      testIdAttr: "resource-id",
    });
  });

  it("records which attribute matched", () => {
    // A selector hint has to say what it actually queried. Implying a convention
    // the app did not use is how an exported step stops reproducing.
    expect(testIdFor({ ...base, resourceId: "com.acme.app:id/x" })!.testIdAttr).toBe("resource-id");
  });

  it("ignores the platform's own furniture", () => {
    // `android:id/content` is on every screen of every app. Anchoring identity to
    // it would make refs collide across unrelated screens.
    expect(testIdFor({ ...base, resourceId: "android:id/content" })).toBeUndefined();
  });

  it("returns undefined when the app set no testID", () => {
    expect(testIdFor(base)).toBeUndefined();
  });
});

describe("the selector model — a testID-anchored ref survives a layout change", () => {
  // THE TEST RFC 0008 §3 EXISTS FOR. The trial rejected a competing tool because
  // its positional refs broke under layout change and it misreported tapping the
  // wrong element twice. `elementKey` hashes the structural path, so a moved node
  // would normally mint a NEW ref. The native rule passes an empty path when a
  // testID is present, so identity rests on type + label + testID.

  const before = dump(
    node(
      { class: "android.widget.FrameLayout" },
      node({
        class: "android.widget.Button",
        "resource-id": "com.acme.app:id/checkout-submit",
        "content-desc": "Place order",
        clickable: "true",
      }),
    ),
  );

  // The same button, two levels deeper and after a newly inserted sibling — the
  // layout change that broke the competing tool.
  const after = dump(
    node(
      { class: "android.widget.FrameLayout" },
      node(
        { class: "android.widget.LinearLayout" },
        node({ class: "android.widget.TextView", text: "Banner" }) +
          node(
            { class: "android.view.ViewGroup", clickable: "true" },
            node({
              class: "android.widget.Button",
              "resource-id": "com.acme.app:id/checkout-submit",
              "content-desc": "Place order",
              clickable: "true",
            }),
          ),
      ),
    ),
  );

  function refOfSubmit(xml: string, refs: RefRegistry): string {
    const { root } = composeNativeTree(parseHierarchy(xml), refs);
    for (const { node: n } of walk(root)) {
      if (n.testId === "checkout-submit") return n.ref;
    }
    throw new Error("the submit button was not composed into the tree");
  }

  it("holds the ref across a move when the node carries a testID", () => {
    const refs = new RefRegistry();
    const first = refOfSubmit(before, refs);
    const second = refOfSubmit(after, refs);
    expect(second, "a testID-anchored ref must survive the node moving").toBe(first);
  });

  it("mints a fresh ref when the node has no testID, which is the honest status", () => {
    // Without a testID the full path key applies and the ref is snapshot-local.
    // Claiming stability for an unlabelled element is the failure mode, not the
    // fresh ref.
    const refs = new RefRegistry();
    const unlabelledBefore = dump(
      node(
        { class: "android.widget.FrameLayout" },
        node({ class: "android.widget.Button", "content-desc": "Go" }),
      ),
    );
    const unlabelledAfter = dump(
      node(
        { class: "android.widget.FrameLayout" },
        node(
          { class: "android.widget.LinearLayout" },
          node({ class: "android.widget.Button", "content-desc": "Go" }),
        ),
      ),
    );
    const a = composeNativeTree(parseHierarchy(unlabelledBefore), refs);
    const b = composeNativeTree(parseHierarchy(unlabelledAfter), refs);
    const findGo = (t: typeof a): string => {
      for (const { node: n } of walk(t.root)) if (n.name === "Go") return n.ref;
      throw new Error("not found");
    };
    expect(findGo(b)).not.toBe(findGo(a));
  });

  it("gives two different testIDs two different refs", () => {
    const refs = new RefRegistry();
    const xml = dump(
      node(
        { class: "android.widget.FrameLayout" },
        node({ class: "android.widget.Button", "resource-id": "com.acme.app:id/a" }) +
          node({ class: "android.widget.Button", "resource-id": "com.acme.app:id/b" }),
      ),
    );
    const { root } = composeNativeTree(parseHierarchy(xml), refs);
    const byId = new Map<string, string>();
    for (const { node: n } of walk(root)) if (n.testId) byId.set(n.testId, n.ref);
    expect(byId.get("a")).not.toBe(byId.get("b"));
  });

  it("passes an empty path to elementKey exactly when a testID is present", () => {
    // The rule stated as an equality, so a refactor that reintroduces the path
    // into a testID-bearing key fails here rather than in a flaky move test.
    const withId = nativeElementKey({
      role: "button",
      name: "Go",
      testId: "submit",
      path: "a/b/c",
      bounds: null,
    });
    const movedWithId = nativeElementKey({
      role: "button",
      name: "Go",
      testId: "submit",
      path: "x/y/z/w",
      bounds: null,
    });
    expect(withId).toBe(movedWithId);

    const withoutId = nativeElementKey({ role: "button", name: "Go", path: "a/b/c", bounds: null });
    const movedWithoutId = nativeElementKey({
      role: "button",
      name: "Go",
      path: "x/y/z/w",
      bounds: null,
    });
    expect(withoutId).not.toBe(movedWithoutId);
  });

  it("namespaces refs by window so two windows with identical markup do not collide", () => {
    const refs = new RefRegistry();
    const xml = dump(node({ class: "android.widget.Button", "resource-id": "com.acme.app:id/x" }));
    const a = composeNativeTree(parseHierarchy(xml), refs, { frameId: "w1" });
    const b = composeNativeTree(parseHierarchy(xml), refs, { frameId: "w2" });
    expect(a.root.ref).not.toBe(b.root.ref);
  });
});

describe("composeNativeTree", () => {
  it("emits the A11yNode shape the snapshot contract already speaks", () => {
    const { root } = composeNativeTree(
      parseHierarchy(
        dump(
          node(
            { class: "android.widget.FrameLayout" },
            node({
              class: "android.widget.EditText",
              "resource-id": "com.acme.app:id/email",
              "content-desc": "Email address",
            }),
          ),
        ),
      ),
      new RefRegistry(),
    );
    const email = [...walk(root)].find((w) => w.node.testId === "email")!.node;
    expect(email.role).toBe("textbox");
    expect(email.name).toBe("Email address");
    expect(email.ref).toMatch(/^e\d+$/);
    expect(Array.isArray(email.children)).toBe(true);
  });

  it("records a recipe per ref so an action can re-resolve it", () => {
    const { root, recipes } = composeNativeTree(
      parseHierarchy(
        dump(node({ class: "android.widget.Button", "resource-id": "com.acme.app:id/go" })),
      ),
      new RefRegistry(),
    );
    const recipe = recipes.get(root.ref)!;
    expect(recipe.testId).toBe("go");
    expect(recipe.path).toBe("button");
  });

  it("carries disabled and checked state through", () => {
    const { root } = composeNativeTree(
      parseHierarchy(
        dump(
          node({
            class: "android.widget.CheckBox",
            enabled: "false",
            checkable: "true",
            checked: "true",
          }),
        ),
      ),
      new RefRegistry(),
    );
    expect(root.disabled).toBe(true);
    expect(root.checked).toBe(true);
  });

  it("prunes layout scaffolding but keeps a container whose descendants matter", () => {
    const xml = dump(
      node(
        { class: "android.widget.FrameLayout" },
        node(
          { class: "android.widget.LinearLayout" },
          node({ class: "android.widget.Button", "content-desc": "Deep" }),
        ) + node({ class: "android.widget.LinearLayout" }),
      ),
    );
    const { root } = composeNativeTree(parseHierarchy(xml), new RefRegistry(), { prune: true });
    const names = [...walk(root)].map((w) => w.node.name).filter(Boolean);
    expect(names).toContain("Deep");
    // The empty sibling container is gone; the one on the path to "Deep" is not.
    expect(root.children).toHaveLength(1);
  });

  it("never puts a password field's contents in the tree", () => {
    const { root } = composeNativeTree(
      parseHierarchy(
        dump(node({ class: "android.widget.EditText", password: "true", text: "hunter2" })),
      ),
      new RefRegistry(),
    );
    expect(JSON.stringify(root)).not.toContain("hunter2");
  });
});

describe("hierarchyDigest", () => {
  it("changes when the tree changes and holds when it does not", () => {
    const a = parseHierarchy(dump(node({ text: "one" })));
    const b = parseHierarchy(dump(node({ text: "one" })));
    const c = parseHierarchy(dump(node({ text: "two" })));
    expect(hierarchyDigest(a)).toBe(hierarchyDigest(b));
    expect(hierarchyDigest(a)).not.toBe(hierarchyDigest(c));
  });
});
