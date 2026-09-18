// The StorageSubstrate position for the ios-app engine. A native app has no
// cookie jar, no `localStorage`, no IndexedDB and no Cache API — those are
// document-scoped web-platform stores, and there is no document. The engine
// therefore omits the `storage` sub-interface, and `subInterfaceGate` refuses
// `cookies_*` / `localstorage_*` / `idb_*` / `caches_*` upstream, where the
// refusal can say the check was never performed.
//
// WHY THIS THROWS RATHER THAN RETURNING. The other absent ports on this engine
// answer with a refusal object because their signatures have a refusal member:
// `EmulationResult` has one, `ElementRefusal` has one, `CaptureRefusal` has one.
// `StorageSubstrate`'s twenty-two members return DATA — `{entries: [], origin}`,
// `{databases: [], supported: true}` — so an implementation here can only throw or
// lie, and the lie is the worse failure: `cookies_list` answering `[]` for a
// session that has no cookie jar is indistinguishable from a session whose jar is
// empty. The same reasoning `element-substrate-safari.ts` spells out.
//
// Reaching one of these is a BUG, not a user error, so the message says which
// gate is missing rather than what the operator should do differently.

import type { StorageSubstrate } from "./storage-substrate-types.js";

/** Greppable, and what the keystone asserts on instead of prose. */
export const IOS_STORAGE_UNREACHABLE = "ios-storage-unreachable";

/** A substrate whose every member throws, naming the port and the member. The
 *  engine tag reads normally so diagnostics that log `substrate.engine` do not
 *  trip it. */
export function iosStorageSubstrate(): StorageSubstrate {
  return new Proxy({} as StorageSubstrate, {
    get(_target, property) {
      if (property === "engine") return "ios-app";
      throw new Error(
        `${IOS_STORAGE_UNREACHABLE}: StorageSubstrate.${String(property)} was reached on the ` +
          "ios-app engine, which declares no `storage` sub-interface — a native app has no " +
          "cookie jar, localStorage, IndexedDB or Cache API. The tool that got here is missing " +
          'its `subInterfaceGate(tool, "storage", e)` call; that gate is where the refusal ' +
          "belongs, because only it can report that the check was not performed.",
      );
    },
  });
}
