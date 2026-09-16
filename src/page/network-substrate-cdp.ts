// CdpNetworkSubstrate — the chromium (and Chrome-on-Android) NetworkSubstrate:
// the existing CDP network path behind the port, VERBATIM. The buffers are the
// same `NetworkBuffer` / `WsBuffer` constructed on the CDP handle, `openActionTap`
// mints the same `NetworkTap`, and `fetchBody` delegates to the same
// `fetchResponseBody`. Output is byte-identical to the pre-seam path, so the
// chromium keystones + unit tests are unchanged. The CDP handle is captured here
// once; callers never see it.
//
// The CDP path is kept on chromium deliberately: the envelope is browxai's
// hottest path and benchmarking put the CDP tap at parity with the event tap on
// chromium, so there is no reason to move chromium off the substrate it already
// has.
//
// Dependency direction (architecture doctrine §1): tools / action-window →
// NetworkSubstrate (the port in `network-substrate-types.ts`) → this
// implementation → CDP. This file never imports back from the
// `network-substrate.js` barrel.

import type { CDPSession } from "playwright-core";
import type { SecretRegistry } from "../util/secrets.js";
import { NetworkBuffer, WsBuffer, NetworkTap, fetchResponseBody } from "./network.js";
import type {
  ActionNetworkTap,
  FetchBodyResult,
  NetworkSubstrate,
} from "./network-substrate-types.js";

/** Chromium substrate — the existing CDP network path, moved behind the interface
 *  VERBATIM. The buffers are the same `NetworkBuffer` / `WsBuffer` constructed on
 *  the CDP handle, `openActionTap` mints the same `NetworkTap`, and `fetchBody`
 *  delegates to the same `fetchResponseBody`. Output is byte-identical to the
 *  pre-seam path, so the chromium keystones + unit tests are unchanged. The CDP
 *  handle is captured here once; callers never see it. */
export class CdpNetworkSubstrate implements NetworkSubstrate {
  readonly engine = "chromium";
  readonly http: NetworkBuffer;
  readonly ws: WsBuffer;
  private secrets: SecretRegistry | null = null;

  constructor(private readonly cdp: CDPSession) {
    this.http = new NetworkBuffer(cdp);
    this.ws = new WsBuffer(cdp);
  }

  async attach(): Promise<void> {
    await this.http.attach();
    await this.ws.attach();
  }

  setSecrets(secrets: SecretRegistry): void {
    this.secrets = secrets;
    this.http.setSecrets(secrets);
    this.ws.setSecrets(secrets);
  }

  openActionTap(): ActionNetworkTap {
    return new NetworkTap(this.cdp, this.secrets);
  }

  fetchBody(requestId: string, secrets: SecretRegistry | null): Promise<FetchBodyResult> {
    return fetchResponseBody(this.cdp, requestId, undefined, secrets);
  }
}
