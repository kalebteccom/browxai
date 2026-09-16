// Cache API result vocabulary — the plain-data half of `cache-storage.ts`.
//
// Split out because the StorageSubstrate port
// (`src/page/storage-substrate-types.ts`) names `CacheEntryBody` in its
// `cachesGet` return type, and `cache-storage.ts` imports `Page` for the
// page-side helpers that do the work. Declarations here, helpers there;
// `cache-storage.ts` re-exports the name so existing importers are unchanged.

/** Result envelope for a cache-entry body — text-like content lands as a
 *  string, anything binary-ish as base64 + the byte count. */
export type CacheEntryBody =
  | {
      kind: "text";
      text: string;
      contentType: string | null;
      status: number;
      headers: Record<string, string>;
    }
  | {
      kind: "binary";
      contentBase64: string;
      byteLength: number;
      contentType: string | null;
      status: number;
      headers: Record<string, string>;
    };
