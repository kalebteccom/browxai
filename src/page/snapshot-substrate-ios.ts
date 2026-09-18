// `IosSnapshotSubstrate` — the SnapshotSubstrate implementation for the ios-app
// engine. There is no CDP accessibility tree and no Playwright frame here, and
// unlike the Safari substrate there is no DOM to walk either: the tree comes from
// XCUITest, which is itself an accessibility hierarchy. So this is the FIRST
// substrate whose source is already role-and-name shaped, and the composition is
// one translation rather than a merge of two tiers.
//
// The translation and everything lossy about it live in `ios-hierarchy.ts`; this
// file is the port shape around it plus the honest stats and warnings.
//
// Dependency direction (architecture doctrine §1): tools → SnapshotSubstrate (the
// port in `snapshot-substrate-types.ts`) → this implementation → the native
// driver. This file never imports back from the `snapshot-substrate.js` barrel.

import type { IosNativeHandle } from "../engine/native-types.js";
import { nativeScopeUrl } from "../engine/native-types.js";
import type { A11yNode } from "./a11y-types.js";
import type { ComposedSnapshot, ComposeOptions } from "./compose-types.js";
import { countAddressable, toA11yTree } from "./ios-hierarchy.js";
import type { RefRegistry } from "./refs.js";
import type { SnapshotSubstrate } from "./snapshot-substrate-types.js";
import { annotateStructuralContext } from "./structural.js";

/** The fidelity note every ios-app snapshot carries. It names the SOURCE, not a
 *  deficiency: an XCUITest hierarchy is a richer accessibility tree than a DOM
 *  walk, and the things it does not have (a DOM, shadow roots, iframes) are
 *  things a native screen does not have either. */
const SOURCE_NOTE =
  'snapshot on the "ios-app" engine is the XCUITest accessibility hierarchy, read through ' +
  "WebDriverAgent. `role` is mapped from the XCUITest element type and the raw type is kept on " +
  "`tag`; `name` is the accessibility label and `[accessibilityIdentifier=…]` is the testID a " +
  "React Native `testID` compiles to. Refs for identified elements survive a layout change; refs " +
  "for unidentified ones are snapshot-local by construction (see docs/tool-reference.md).";

export class IosSnapshotSubstrate implements SnapshotSubstrate {
  readonly engine = "ios-app";
  constructor(private readonly handle: IosNativeHandle) {}

  async compose(
    refs: RefRegistry,
    _testAttributes: string[],
    opts: ComposeOptions = {},
  ): Promise<ComposedSnapshot> {
    const root = await this.handle.driver.hierarchy();
    const tree = toA11yTree(root, refs, await this.screenName());
    annotateStructuralContext(tree);
    const addressable = countAddressable(root);
    const warnings = [SOURCE_NOTE];
    if (opts.pierce) {
      // `pierce` is a shadow-DOM concept. Saying so is better than accepting the
      // option and returning a tree that looks like it honoured it.
      warnings.push(
        'shadow-DOM piercing has no meaning on the "ios-app" engine — there is no DOM and no ' +
          "shadow root. The option was ignored; the XCUITest hierarchy is already complete.",
      );
    }
    if (addressable.identified === 0 && addressable.total > 1) {
      // The failure mode RFC 0008 names: browxai cannot make an element
      // addressable that the app never labelled, and the app team is the only
      // party who can fix it. A count turns that into a list someone can act on.
      warnings.push(
        `no element on this screen carries an accessibility identifier (${addressable.labelled} of ` +
          `${addressable.total} carry a label). Every ref here is keyed on its position in the ` +
          "hierarchy and will change when the layout does. Add `testID` props in the app to get " +
          "refs that survive a layout change.",
      );
    }
    return {
      tree,
      stats: {
        // The hierarchy IS the accessibility tree, so the a11y tier carries the
        // whole snapshot and the DOM-walk tier does not exist here.
        tier: addressable.total > 1 ? "a11y" : "empty",
        a11yInteractive: addressable.identified + addressable.labelled,
        domWalkEntries: 0,
        domWalkNew: 0,
        domWalkCombined: 0,
      },
      warnings,
    };
  }

  async a11yTree(refs: RefRegistry, _testAttributes: string[]): Promise<A11yNode | null> {
    const tree = toA11yTree(await this.handle.driver.hierarchy(), refs, await this.screenName());
    annotateStructuralContext(tree);
    return tree;
  }

  /** The root's name, standing in for a page URL: the app scope plus the
   *  foreground app's own name when the driver reports one. This is also the
   *  string the secret-scope check reads (RFC 0008 §1.5). */
  private async screenName(): Promise<string> {
    const app = await this.handle.driver.foregroundApp().catch(() => undefined);
    return nativeScopeUrl(this.handle, app?.name);
  }
}
