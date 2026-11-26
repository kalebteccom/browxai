// One session per phone (RFC 0014 G11). A lease keyed on the CoreDevice
// identifier, held for the session's lifetime. In-process, like the android-app
// engine's serial lease: two browxai processes on one Mac are the operator's
// choice, and WebDriverAgent serves one session at a time anyway.

import { IosDeviceError } from "./device-errors.js";

/** identifier → the session id holding it. */
const LEASES = new Map<string, string>();

/** Claim the phone for `sessionId`, or refuse naming the holder. Returns the release. */
export function leaseIosDevice(identifier: string, sessionId: string): () => void {
  const holder = LEASES.get(identifier);
  if (holder !== undefined && holder !== sessionId) {
    throw new IosDeviceError(
      "native-device-leased",
      `the allowlisted phone is already leased by session "${holder}". One session drives a ` +
        "phone at a time. Close that session first.",
    );
  }
  LEASES.set(identifier, sessionId);
  return () => {
    if (LEASES.get(identifier) === sessionId) LEASES.delete(identifier);
  };
}
