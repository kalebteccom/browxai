// The synthetic 6th engine for the ocp-engine-contract keystone (RFC 0004 D9 /
// 0004-05 §2b). It exists ONLY in the architecture-test lane: an in-memory
// `BrowserSession` + a real in-memory `SubstrateBundle` that answer the core tool
// surface (navigate / snapshot / find / click) with ZERO edits to any session
// factory, the session registry, host-build, or the tool-gate. If adding it
// required editing core source, the open-closed claim would be false — the whole
// point is that `registerEngine(...)` is the only new line.
//
// The substrates are GENUINE in-memory answers, not stubs: snapshot mints a real
// a11y tree with a stable ref so `find`/`click({ref})` resolve; the action
// substrate returns the universal `ActionResult` (the same shape SafariActionSubstrate
// builds, since the synthetic engine likewise has no Playwright Page). The four
// substrates the core contract never drives (storage/script/emulation/capture)
// are present-but-throwing via a proxy — the gate refuses their tools upstream
// (deep:false), so they are never reached, exactly like a real no-Page engine.

import type { SubstrateBundle, SubstrateDeps } from "../../src/engine/registry.js";
import type { SessionEntry } from "../../src/session/registry.js";
import type { A11yNode } from "../../src/page/a11y.js";
import type { RefRegistry } from "../../src/page/refs.js";
import { elementKey } from "../../src/page/refs.js";
import type { ComposedSnapshot, ComposeOptions } from "../../src/page/compose.js";
import type { SnapshotSubstrate } from "../../src/page/snapshot-substrate.js";
import type { NetworkSubstrate } from "../../src/page/network-substrate.js";
import type { ActionSubstrate } from "../../src/page/action-substrate.js";
import type { CaptureResult, CaptureSubstrate } from "../../src/page/capture-substrate.js";
import type { StorageSubstrate } from "../../src/page/storage-substrate.js";
import type { ScriptSubstrate } from "../../src/page/script-substrate.js";
import type { EmulationResult, EmulationSubstrate } from "../../src/page/emulation-substrate.js";
import type { TargetSubstrate } from "../../src/page/target-substrate.js";
import type { ActionResult, DispatchedAction } from "../../src/page/actionresult.js";

/** A present-but-throwing substrate for the four ports the core contract never
 *  drives (the synthetic engine is deep:false, so their tools refuse upstream).
 *  A Proxy makes any method access throw — proving these are NEVER reached on the
 *  navigate/snapshot/find/click path. */
function unsupported<T extends object>(port: string): T {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `synthetic engine: ${port}.${String(prop)} must not be reached — the gate refuses ` +
            `its tools (deep:false), so the core contract never drives this port.`,
        );
      },
    },
  ) as T;
}

/** In-memory a11y tree: a WebArea root with one button child carrying a stable ref.
 *  `find`/`snapshot` rank from this; `click({ref})` resolves against `refs`. */
function buildTree(refs: RefRegistry): A11yNode {
  const rootRef = refs.forKey(elementKey({ role: "WebArea", path: "__main__" }), {
    role: "WebArea",
    source: "dom",
  });
  const btnRef = refs.forKey(
    elementKey({ role: "button", name: "Submit", path: "button#submit" }),
    {
      role: "button",
      name: "Submit",
      source: "dom",
    },
  );
  return {
    ref: rootRef,
    role: "WebArea",
    name: "synthetic",
    source: "dom",
    children: [
      {
        ref: btnRef,
        role: "button",
        name: "Submit",
        source: "dom",
        children: [],
      },
    ],
  };
}

class InMemorySnapshotSubstrate implements SnapshotSubstrate {
  readonly engine = "synthetic";
  compose(
    refs: RefRegistry,
    _testAttributes: string[],
    _opts: ComposeOptions = {},
  ): Promise<ComposedSnapshot> {
    return Promise.resolve({
      tree: buildTree(refs),
      stats: { a11yInteractive: 1, domWalkEntries: 1, domWalkNew: 1, domWalkCombined: 0 },
      warnings: [],
    });
  }
  a11yTree(refs: RefRegistry, _testAttributes: string[]): Promise<A11yNode | null> {
    return Promise.resolve(buildTree(refs));
  }
}

const EMPTY_NETWORK = { summary: { total: 0, byType: {}, failed: 0 } };

/** The universal ActionResult an in-memory action returns — the same shape
 *  SafariActionSubstrate builds (no Playwright Page → no real structure/console/
 *  network deltas; honest empty slices). */
function inMemoryResult(action: DispatchedAction, ok: boolean): ActionResult {
  return {
    ok,
    action,
    navigation: { changed: false, from: "", to: "", kind: null },
    structure: { appeared: [], removed: [], newTabs: [] },
    console: { errors: [], warnings: 0 },
    pageErrors: [],
    network: EMPTY_NETWORK,
    tokensEstimate: 0,
    warnings: ["synthetic engine: in-memory action — no real page side-effects"],
  };
}

class InMemoryActionSubstrate implements ActionSubstrate {
  readonly engine = "synthetic";
  navigate(args: { url: string }): Promise<ActionResult> {
    return Promise.resolve({
      ...inMemoryResult({ type: "navigate", url: args.url }, true),
      navigation: { changed: true, from: "", to: args.url, kind: "full_load" },
    });
  }
  click(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "click" }, true));
  }
  fill(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "fill" }, true));
  }
  press(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "press" }, true));
  }
  hover(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "hover" }, true));
  }
  select(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "select" }, true));
  }
  scroll(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "scroll" }, true));
  }
  goBack(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "navigate" }, true));
  }
  goForward(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "navigate" }, true));
  }
  chooseOption(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "select" }, true));
  }
  setViewport(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "set_viewport" }, true));
  }
  waitFor(): Promise<ActionResult> {
    return Promise.resolve(inMemoryResult({ type: "wait_for" }, true));
  }
}

/** The empty in-memory network substrate — no protocol-level network (the
 *  synthetic engine declares no `network` sub-interface), so the rings are
 *  permanently empty and the tap reports zero traffic. Mirrors
 *  SafariNoopNetworkSubstrate. */
class InMemoryNetworkSubstrate implements NetworkSubstrate {
  readonly engine = "synthetic";
  readonly http = {
    setSecrets: () => undefined,
    iter: () => [],
    recent: () => ({ summary: { total: 0, byType: {}, failed: 0 }, requests: [] }),
  };
  readonly ws = {
    setSecrets: () => undefined,
    recent: () => ({ total: 0, frames: [] }),
    since: () => [],
  };
  attach(): Promise<void> {
    return Promise.resolve();
  }
  setSecrets(): void {
    /* no egress sinks — rings are permanently empty */
  }
  openActionTap() {
    return {
      open: () => Promise.resolve(),
      close: () =>
        Promise.resolve({
          summary: { total: 0, byType: {}, failed: 0 },
          requests: [],
          mutations: [],
        }),
    };
  }
  fetchBody() {
    return Promise.resolve({
      ok: false,
      error: "network_body is not available on the synthetic engine (no protocol-level network).",
    });
  }
}

/** The one string in this file that exists only to be observed. Exported so the
 *  contract asserts on the same literal the substrate emits, and so a grep proves
 *  it has exactly two homes: here, and the assertion. */
export const SYNTHETIC_TITLE = "in-memory-target-title-b7f2";

/** The synthetic engine's in-memory TargetSubstrate. The core contract drives it
 *  through `list_sessions` (the `url` column) and the snapshot header, which is
 *  what lets the synthetic session answer both WITHOUT a Playwright Page: before
 *  RFC 0009 P1 those two reads went to `page().url()` / `page().title()` and were
 *  the reason the synthetic engine had to carry a `fakePage()` at all. */
class InMemoryTargetSubstrate implements TargetSubstrate {
  readonly engine = "synthetic";
  url(): Promise<string> {
    return Promise.resolve("about:blank");
  }
  /** A SENTINEL, not the engine tag. The title used to be `"synthetic"`, which
   *  also happens to be the engine name and the a11y root's name, so the
   *  contract's `expect(snapText).toContain("synthetic")` passed whatever this
   *  method returned — including `""`. The assertion measured nothing. This
   *  string appears nowhere else in src or test, so the snapshot header can only
   *  carry it if it came through `TargetSubstrate.title()`. */
  title(): Promise<string> {
    return Promise.resolve(SYNTHETIC_TITLE);
  }
}

/** The four ports the core OCP contract never drives, answered PLAUSIBLY instead
 *  of throwing. `answerAll` turns them on.
 *
 *  The sub-interface conformance suite needs this. It asks "does a tool refuse
 *  when the engine declares no <sub>?", and a throwing substrate would answer
 *  that question for the wrong reason: the tool would fail either way, so a
 *  MISSING gate would look like a present one. With the substrate returning a
 *  well-formed value, an ungated tool returns that value and the assertion
 *  catches the drift. Deliberately the opposite fixture to `unsupported()`. */
class InMemoryStorageSubstrate {
  readonly engine = "synthetic";
  private readonly origin = "http://synthetic.invalid";
  cookiesList = () => Promise.resolve([]);
  cookiesSet = (c: { name: string }) => Promise.resolve({ ok: true, name: c.name });
  webStorageGet = () => Promise.resolve({ value: null, origin: this.origin });
  webStorageList = () => Promise.resolve({ entries: [], origin: this.origin });
  webStorageSet = () => Promise.resolve({ ok: true as const, origin: this.origin });
  webStorageDelete = () => Promise.resolve({ ok: true as const, origin: this.origin });
  webStorageClear = () => Promise.resolve({ ok: true as const, origin: this.origin });
  idbListDatabases = () => Promise.resolve({ databases: [], origin: this.origin, supported: true });
  idbListStores = (a: { dbName: string }) =>
    Promise.resolve({ stores: [], dbName: a.dbName, version: 1, origin: this.origin });
  idbGet = (a: { dbName: string; storeName: string; key: unknown }) =>
    Promise.resolve({ found: false as const, ...a, origin: this.origin });
  idbPut = (a: { dbName: string; storeName: string; key: unknown }) =>
    Promise.resolve({ ok: true as const, ...a, origin: this.origin });
  idbDelete = (a: { dbName: string; storeName: string; key: unknown }) =>
    Promise.resolve({ ok: true as const, ...a, origin: this.origin });
  idbClear = (a: { dbName: string; storeName: string }) =>
    Promise.resolve({ ok: true as const, ...a, origin: this.origin });
  cachesListStorages = () => Promise.resolve({ names: [], origin: this.origin });
  cachesList = (a: { cacheName: string }) =>
    Promise.resolve({ entries: [], origin: this.origin, cacheName: a.cacheName });
  cachesGet = (a: { cacheName: string; url: string }) =>
    Promise.resolve({ found: false as const, ...a, origin: this.origin });
  cachesPut = (a: { cacheName: string; url: string }) =>
    Promise.resolve({ ok: true as const, ...a, origin: this.origin });
  cachesDelete = (a: { cacheName: string; url: string }) =>
    Promise.resolve({ ok: true as const, existed: false, ...a, origin: this.origin });
  cachesClear = (a: { cacheName: string }) =>
    Promise.resolve({ ok: true as const, cleared: 0, ...a, origin: this.origin });
  cachesDeleteStorage = (a: { cacheName: string }) =>
    Promise.resolve({ ok: true as const, existed: false, ...a, origin: this.origin });
}

class InMemoryScriptSubstrate implements ScriptSubstrate {
  readonly engine = "synthetic";
  evaluate(): Promise<unknown> {
    return Promise.resolve("synthetic-eval-result");
  }
}

class InMemoryEmulationSubstrate implements EmulationSubstrate {
  readonly engine = "synthetic";
  setGeolocation(): Promise<EmulationResult> {
    return Promise.resolve({ kind: "applied" });
  }
  setColorScheme(): Promise<EmulationResult> {
    return Promise.resolve({ kind: "applied" });
  }
  setReducedMotion(): Promise<EmulationResult> {
    return Promise.resolve({ kind: "applied" });
  }
}

/** A 1×1 transparent PNG — a plausible screenshot, so an ungated capture tool
 *  returns an image rather than an error. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

class InMemoryCaptureSubstrate implements CaptureSubstrate {
  readonly engine = "synthetic";
  screenshot(): Promise<CaptureResult> {
    return Promise.resolve({ kind: "image", data: TINY_PNG, mimeType: "image/png" });
  }
}

/** How the four non-core ports answer. `throwing` (the default) is the OCP
 *  contract's fixture — it proves navigate/snapshot/find/click never reach them.
 *  `answering` is the conformance suite's — it proves a tool that should have
 *  refused did not. */
export type NonCorePorts = "throwing" | "answering";

/** The synthetic engine's `SubstrateBundle` — the in-memory answers the core
 *  contract drives (actions / snapshot / network / target) plus the four ports it
 *  never reaches (storage / script / emulation / capture), which are
 *  present-but-throwing by default. Takes the per-server `SubstrateDeps` to
 *  honour the standardized `makeSubstrates(deps)` contract, but ignores them: the
 *  in-memory substrates need no host config. */
export function inMemorySubstrateBundle(
  _deps: SubstrateDeps,
  nonCore: NonCorePorts = "throwing",
): SubstrateBundle {
  const answering = nonCore === "answering";
  return {
    actions: (_e: SessionEntry): ActionSubstrate => new InMemoryActionSubstrate(),
    snapshot: (_e: SessionEntry): SnapshotSubstrate => new InMemorySnapshotSubstrate(),
    network: (_e: SessionEntry): NetworkSubstrate => new InMemoryNetworkSubstrate(),
    target: (_e: SessionEntry): TargetSubstrate => new InMemoryTargetSubstrate(),
    capture: (_e: SessionEntry): CaptureSubstrate =>
      answering ? new InMemoryCaptureSubstrate() : unsupported<CaptureSubstrate>("capture"),
    storage: (_e: SessionEntry): StorageSubstrate =>
      answering ? new InMemoryStorageSubstrate() : unsupported<StorageSubstrate>("storage"),
    script: (_e: SessionEntry): ScriptSubstrate =>
      answering ? new InMemoryScriptSubstrate() : unsupported<ScriptSubstrate>("script"),
    emulation: (_e: SessionEntry): EmulationSubstrate =>
      answering ? new InMemoryEmulationSubstrate() : unsupported<EmulationSubstrate>("emulation"),
  };
}
