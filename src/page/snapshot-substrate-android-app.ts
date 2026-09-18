// NativeSnapshotSubstrate — the SnapshotSubstrate implementation over a
// UiAutomator view hierarchy. This is the claim RFC 0008 rests on: our snapshot
// already speaks role/name trees, so a native hierarchy maps onto the existing
// port without a second ref model and without deforming `A11yNode`.
//
// `compose()` and `a11yTree()` are the port's two members and they differ here
// the way they differ on every engine: `compose` is the find-ranking view (pruned
// to what an agent can address and read) and `a11yTree` is the structural view
// the action window's pre/post delta and `watch` sample. On a native tree the
// distinction matters MORE than on web, because a UiAutomator dump is roughly
// two-thirds layout scaffolding — an unpruned compose would hand `find` hundreds
// of anonymous `group` nodes to rank.
//
// Dependency direction (architecture doctrine §1): tools → SnapshotSubstrate (the
// port in `snapshot-substrate-types.ts`) → this implementation → NativeScreen →
// adb. This file never imports back from the `snapshot-substrate.js` barrel and
// names no Playwright type.

import type { A11yNode } from "./a11y-types.js";
import { walk } from "./a11y-types.js";
import type { ComposedSnapshot, ComposeOptions } from "./compose-types.js";
import type { RefRegistry } from "./refs.js";
import type { SnapshotSubstrate } from "./snapshot-substrate-types.js";
import { READ_MAX_AGE_MS, type NativeScreen } from "./native-screen.js";

export class NativeSnapshotSubstrate implements SnapshotSubstrate {
  readonly engine: string;

  constructor(
    private readonly screen: NativeScreen,
    engine = "android-app",
  ) {
    this.engine = engine;
  }

  /** The composed snapshot the read core consumes.
   *
   *  `opts.pierce` has no native meaning — there is no shadow DOM and no closed
   *  root to reach into — so it is ignored. The option asks for MORE of a tree
   *  this engine already returns whole. A WebView inside the app IS a separate
   *  context, and reaching into one is RFC 0008's open hybrid-context question,
   *  not this option.
   *
   *  `testAttributes` is ignored for the same kind of reason and it is worth
   *  naming: on web it lists which DOM attributes count as a test id
   *  (`data-testid`, `data-cy`, …) because the convention varies per codebase. On
   *  Android there is exactly one place a React Native `testID` lands — the
   *  view's `resource-id` — so there is no convention to configure. */
  async compose(
    refs: RefRegistry,
    _testAttributes: string[],
    _opts?: ComposeOptions,
  ): Promise<ComposedSnapshot> {
    const view = await this.screen.read(refs, { maxAgeMs: READ_MAX_AGE_MS, prune: true });
    const addressable = countAddressable(view.root);
    return {
      tree: view.root,
      stats: {
        // The whole tree comes from one accessibility-style source. There is no
        // DOM-walk tier on this engine, so the three DOM counters are zero and
        // the tier is never `mixed`.
        tier: addressable > 0 ? "a11y" : "empty",
        a11yInteractive: addressable,
        domWalkEntries: 0,
        domWalkNew: 0,
        domWalkCombined: 0,
      },
      warnings: this.warningsFor(view.root, addressable),
    };
  }

  /** The structural tree, unpruned. The action window diffs pre against post to
   *  produce `ActionResult.structure`, and pruning would hide a container that
   *  appeared — exactly the kind of change a reviewer wants to see. */
  async a11yTree(refs: RefRegistry, _testAttributes: string[]): Promise<A11yNode | null> {
    const view = await this.screen.read(refs, { maxAgeMs: READ_MAX_AGE_MS, prune: false });
    return view.root;
  }

  /** The one warning worth emitting on a native tree, and it is the one RFC 0008
   *  asks for under "the apps' own testID coverage": browxai cannot make an
   *  element addressable that the app never labelled. Saying so turns a degraded
   *  selector model into a fixable list for the app team. */
  private warningsFor(root: A11yNode, addressable: number): string[] {
    if (addressable === 0) {
      return [
        "the view hierarchy carried no addressable element. The app may still be on a splash " +
          "screen, or its views may be excluded from the accessibility tree.",
      ];
    }
    let withTestId = 0;
    let actionable = 0;
    for (const { node } of walk(root)) {
      if (node.role !== "button" && node.role !== "textbox" && node.role !== "checkbox") continue;
      actionable += 1;
      if (node.testId) withTestId += 1;
    }
    if (actionable >= 4 && withTestId * 2 < actionable) {
      return [
        `${actionable - withTestId} of ${actionable} actionable elements carry no testID, so their ` +
          "refs are anchored on the structural path and will not survive a layout change. Adding " +
          "`testID` in the app is what makes a ref durable across a re-render.",
      ];
    }
    return [];
  }
}

/** Nodes an agent can act on or read — the native counterpart of the a11y tier's
 *  interactive count. */
function countAddressable(root: A11yNode): number {
  let n = 0;
  for (const { node } of walk(root)) {
    if (node.name ?? node.testId) n += 1;
  }
  return n;
}
