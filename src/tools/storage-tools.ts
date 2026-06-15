import type { ToolHost } from "./host.js";
import { registerStorageStateCookiesTools } from "./storage-state-cookies-tools.js";
import { registerStorageWebAuthTools } from "./storage-web-auth-tools.js";
import { registerStorageCacheIdbTools } from "./storage-cache-idb-tools.js";
import { registerStorageArtifactHarVideoTools } from "./storage-artifact-har-video-tools.js";

/**
 * Storage-state tools — the three-layer storage surface plus the file-backed
 * artifact / HAR / video families. Layer 1 bulk dump/inject, layer 2 granular
 * cookies + web-storage + Cache API + IndexedDB CRUD, layer 3 named auth-state
 * slots, and the session artifact KV / HAR record / video record tools.
 *
 * RFC 0004 P3 / D3 (SRP): the registrations were split by cohesive family into
 * four sibling modules (state+cookies / web-storage+auth / cache+idb /
 * artifact+har+video). This module stays the single entry point `server.ts` +
 * `tool-metadata.ts` call, and invokes each family in the EXACT prior source order
 * so the registered-name set + the derived maps stay byte-identical (the
 * web-storage `for` loop over localStorage/sessionStorage is kept verbatim inside
 * its family module). The host owns the closures (gate, confirm, storage port,
 * workspace); the family modules own the registrations.
 */
export function registerStorageTools(host: ToolHost): void {
  registerStorageStateCookiesTools(host);
  registerStorageWebAuthTools(host);
  registerStorageCacheIdbTools(host);
  registerStorageArtifactHarVideoTools(host);
}
