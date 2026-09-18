// The live view-hierarchy source one native session shares across its five
// substrates, and the place RFC 0008 §3's re-resolution contract is enforced.
//
// RE-RESOLVE BEFORE DISPATCH, ALWAYS. The trial that produced RFC 0008 rejected a
// competing tool because a stale ref silently resolved to whatever now occupied
// its old rectangle, and it reported tapping the wrong element twice. So every
// ACTION reads with `maxAgeMs: 0` — a fresh `uiautomator dump`, a fresh compose, a
// fresh bounds read, in the same call that dispatches. There is no cached handle
// and no replayed coordinate anywhere in this engine.
//
// The TTL exists only for the read path. `snapshot` composes once and `find`
// composes once, and a compound tool that calls both inside one handler would
// otherwise pay two ~400ms dumps for one unchanged screen. `ACTION_MAX_AGE_MS` is
// zero and is the constant the action substrate passes; a test pins that it is
// zero, because the performance temptation here points directly at the defect
// this engine exists to avoid.

import type { A11yNode } from "./a11y-types.js";
import type { RefRegistry } from "./refs.js";
import {
  composeNativeTree,
  hierarchyDigest,
  parseHierarchy,
  type NativeNode,
  type NativeRefRecipe,
} from "./native-hierarchy.js";

/** The one IO the screen needs: the raw hierarchy XML. Injected, so every unit
 *  test drives the real compose path against a faked dump. */
export interface NativeScreenIO {
  dump(): Promise<string>;
}

/** An action re-resolves against a hierarchy read in the same call. Zero, and a
 *  test asserts it stays zero. */
export const ACTION_MAX_AGE_MS = 0;

/** How long a READ may reuse the previous dump. One tool call that composes
 *  twice is the case this serves; anything longer would start answering questions
 *  about a screen that has since changed. */
export const READ_MAX_AGE_MS = 250;

/** One composed view of the screen. */
export interface NativeScreenView {
  root: A11yNode;
  recipes: Map<string, NativeRefRecipe>;
  /** The raw tree, for the callers that need attributes the `A11yNode` shape has
   *  no field for (the element substrate's probes). */
  roots: NativeNode[];
  /** A content hash of the tree, so a caller can say "this ref was minted against
   *  an older screen" instead of only "it matched nothing". */
  generation: string;
  /** When this view was composed, on the monotonic clock the TTL is measured on. */
  at: number;
}

/** The session-scoped hierarchy source. One instance per session, handed to every
 *  substrate in the bundle, so a single action costs one dump rather than one per
 *  substrate that wants to look at the screen. */
export class NativeScreen {
  private last: NativeScreenView | undefined;
  private inFlight: Promise<NativeScreenView> | undefined;

  constructor(
    private readonly io: NativeScreenIO,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Read the screen, composing refs into `refs`.
   *
   *  `maxAgeMs` of 0 forces a fresh dump. Concurrent callers share one in-flight
   *  dump rather than queueing two against a device that serialises them anyway —
   *  a second `uiautomator dump` while the first is open is the "one UiAutomation
   *  owner per device" collision RFC 0008 names under Honest limits. */
  async read(
    refs: RefRegistry,
    opts: { maxAgeMs?: number; prune?: boolean; frameId?: string } = {},
  ): Promise<NativeScreenView> {
    const maxAge = opts.maxAgeMs ?? READ_MAX_AGE_MS;
    const cached = this.last;
    if (cached && maxAge > 0 && this.now() - cached.at <= maxAge) return cached;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.compose(refs, opts).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async compose(
    refs: RefRegistry,
    opts: { prune?: boolean; frameId?: string },
  ): Promise<NativeScreenView> {
    const roots = parseHierarchy(await this.io.dump());
    const { root, recipes } = composeNativeTree(roots, refs, {
      frameId: opts.frameId,
      prune: opts.prune,
    });
    const view: NativeScreenView = {
      root,
      recipes,
      roots,
      generation: hierarchyDigest(roots),
      at: this.now(),
    };
    this.last = view;
    return view;
  }

  /** The last composed view without touching the device. Only the action window's
   *  pre/post diff uses it, and only for the PRE side, which it has already read. */
  peek(): NativeScreenView | undefined {
    return this.last;
  }
}
