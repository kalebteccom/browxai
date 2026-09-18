// `IosTargetSubstrate` — the structural identity of a native session's target.
// The port's own doc anticipates this engine: "Web: the document URL. Native
// (RFC 0008): the deep-link scheme plus screen id."
//
// The URL is `app://<bundleId>/<screen>`, and it is load-bearing in one place
// beyond display. `SecretRegistry.materialize` scopes a secret by
// case-insensitive substring containment against this string, so a secret
// registered with `scope: "com.acme.app"` materialises in that app's session and
// refuses in another's — RFC 0008 §1.5's rename, honoured with no change to the
// check itself.
//
// Both reads are round trips to WebDriverAgent, which is what the port's async
// members are for. They are also best-effort: a driver that has gone away
// downgrades to the bundle-id-only scope rather than throwing, because the
// callers are `list_sessions`' per-session URL column and the snapshot header,
// and one dead session must not empty a listing.
//
// Dependency direction (architecture doctrine §1): tool handler → TargetSubstrate
// (the port in `target-substrate-types.ts`) → this implementation → the native
// driver. This file never imports back from the `target-substrate.js` barrel.

import type { NativeSessionHandle } from "../engine/native-types.js";
import { nativeScopeUrl } from "../engine/native-types.js";
import type { TargetSubstrate } from "./target-substrate-types.js";

export class IosTargetSubstrate implements TargetSubstrate {
  readonly engine = "ios-app";
  constructor(private readonly handle: NativeSessionHandle) {}

  async url(): Promise<string> {
    const app = await this.handle.driver.foregroundApp().catch(() => undefined);
    return nativeScopeUrl(this.handle, app?.name);
  }

  /** The foreground app's name — the closest thing a native screen has to a
   *  document title. Empty when the driver reports none; an empty title is a real
   *  answer here, as it is on a page with no `<title>`. */
  async title(): Promise<string> {
    const app = await this.handle.driver.foregroundApp().catch(() => undefined);
    return app?.name ?? "";
  }
}
