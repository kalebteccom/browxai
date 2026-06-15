import { withDeadline } from "../util/deadline.js";
import { confirmByobAction } from "../policy/confirm.js";
import { SESSION_ARG } from "./schemas.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ConfigHost,
  EnvelopeHost,
  StorageHost,
  ActionHost,
  ServerServicesHost,
} from "./host.js";

/**
 * Cache API + IndexedDB tools: caches_* (list_storages / list / get / put / delete
 * / clear / delete_storage) and idb_* (list_databases / list_stores / get / put /
 * delete / clear). Split out of `storage-tools` by cohesive family (RFC 0004 P3 /
 * D3 SRP); registered through the shared `ToolHost` seam in the same source order.
 */
export function registerStorageCacheIdbTools(
  host: RegisterHost &
    GateHost &
    SessionHost &
    ConfigHost &
    EnvelopeHost &
    StorageHost &
    ActionHost &
    ServerServicesHost,
): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    okText,
    errText,
    confirmCtxFor,
    denyContent,
    storageFor,
    cfgActionTimeout,
  } = host;

  // ---- Cache API -------------------------------------------------------------

  register(
    "caches_list_storages",
    {
      capability: "read",
      description:
        "List every cache storage visible to the current page's origin (`caches.keys()`). Cache API is ORIGIN-SCOPED — the session must be navigated to the target origin first; about:blank rejects with a navigation hint. Returns `{names:[...], origin}`. Read-only.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("caches_list_storages");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          storageFor(e).cachesListStorages("caches_list_storages"),
          cfgActionTimeout(),
          "caches_list_storages",
        );
        return okText({ ok: true, count: r.names.length, ...r });
      } catch (err) {
        return errText("caches_list_storages", err);
      }
    },
  );

  register(
    "caches_list",
    {
      capability: "read",
      description:
        "List entries in one cache. Returns `{entries:[{url, method}], origin, cacheName}`. Optional `urlPattern` is a case-sensitive substring filter on each entry's URL (no regex — adopters wanting richer filtering can post-filter the result). Origin-scoped — navigate first. Read-only.",
      inputSchema: {
        cacheName: z.string().describe("Cache storage name."),
        urlPattern: z
          .string()
          .optional()
          .describe("Optional substring filter on each entry's `request.url`."),
        ...SESSION_ARG,
      },
    },
    async ({ cacheName, urlPattern, session }) => {
      const g = gateCheck("caches_list");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          storageFor(e).cachesList({ cacheName, urlPattern }, "caches_list"),
          cfgActionTimeout(),
          "caches_list",
        );
        return okText({ ok: true, count: r.entries.length, ...r });
      } catch (err) {
        return errText("caches_list", err);
      }
    },
  );

  register(
    "caches_get",
    {
      capability: "read",
      description:
        'Read the response body of a single cache entry. Text-like content types (`text/*`, `application/json|javascript|xml|x-www-form-urlencoded`, or anything with a `charset=`) arrive as `{kind:"text", text}`. Everything else arrives as `{kind:"binary", contentBase64, byteLength}`. `{found:false}` if no entry matches the URL. Origin-scoped — navigate first. Read-only.',
      inputSchema: {
        cacheName: z.string().describe("Cache storage name."),
        url: z.string().describe("Entry URL key."),
        ...SESSION_ARG,
      },
    },
    async ({ cacheName, url, session }) => {
      const g = gateCheck("caches_get");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          storageFor(e).cachesGet({ cacheName, url }, "caches_get"),
          cfgActionTimeout(),
          "caches_get",
        );
        return okText({ ok: true, ...r });
      } catch (err) {
        return errText("caches_get", err);
      }
    },
  );

  register(
    "caches_put",
    {
      capability: "action",
      description:
        "Put one entry in a cache. `response.body` is a UTF-8 string (default); for binary content pass `response.contentBase64` instead — exactly one of the two. Optional `response.status` (default 200) and `response.headers` build the `Response`. Auto-opens (= creates) the named cache storage if it doesn't exist. Origin-scoped — navigate first.",
      inputSchema: {
        cacheName: z.string().describe("Cache storage name (auto-created)."),
        url: z.string().describe("Entry URL key."),
        response: z
          .object({
            status: z.number().optional().describe("HTTP status (default 200)."),
            headers: z.record(z.string()).optional().describe("Response headers."),
            body: z
              .string()
              .optional()
              .describe("UTF-8 string body. Mutually exclusive with `contentBase64`."),
            contentBase64: z
              .string()
              .optional()
              .describe("Base64-encoded binary body. Mutually exclusive with `body`."),
          })
          .describe("Response shape — body+headers+status."),
        ...SESSION_ARG,
      },
    },
    async ({ cacheName, url, response, session }) => {
      const g = gateCheck("caches_put");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("caches_put", confirmCtxFor(e));
        if (!c.ok) return denyContent("caches_put", c);
        const r = await withDeadline(
          storageFor(e).cachesPut({ cacheName, url, response }, "caches_put"),
          cfgActionTimeout(),
          "caches_put",
        );
        return okText({ ...r });
      } catch (err) {
        return errText("caches_put", err);
      }
    },
  );

  register(
    "caches_delete",
    {
      capability: "action",
      description:
        "Delete one entry from a cache. Returns `existed:true` when a record was present (idempotent — repeat calls return `existed:false`). Origin-scoped — navigate first.",
      inputSchema: {
        cacheName: z.string().describe("Cache storage name."),
        url: z.string().describe("Entry URL key."),
        ...SESSION_ARG,
      },
    },
    async ({ cacheName, url, session }) => {
      const g = gateCheck("caches_delete");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("caches_delete", confirmCtxFor(e));
        if (!c.ok) return denyContent("caches_delete", c);
        const r = await withDeadline(
          storageFor(e).cachesDelete({ cacheName, url }, "caches_delete"),
          cfgActionTimeout(),
          "caches_delete",
        );
        return okText({ ...r });
      } catch (err) {
        return errText("caches_delete", err);
      }
    },
  );

  register(
    "caches_clear",
    {
      capability: "action",
      description:
        "Clear every entry in a cache (the cache storage itself remains — use `caches_delete_storage` to drop the whole storage). Returns `cleared:N` (the count removed). Origin-scoped — navigate first.",
      inputSchema: {
        cacheName: z.string().describe("Cache storage name."),
        ...SESSION_ARG,
      },
    },
    async ({ cacheName, session }) => {
      const g = gateCheck("caches_clear");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("caches_clear", confirmCtxFor(e));
        if (!c.ok) return denyContent("caches_clear", c);
        const r = await withDeadline(
          storageFor(e).cachesClear({ cacheName }, "caches_clear"),
          cfgActionTimeout(),
          "caches_clear",
        );
        return okText({ ...r });
      } catch (err) {
        return errText("caches_clear", err);
      }
    },
  );

  register(
    "caches_delete_storage",
    {
      capability: "action",
      description:
        "Delete a cache storage entirely (`caches.delete(name)`). Returns `existed:true` when the storage was present (idempotent). To clear entries while keeping the storage, use `caches_clear`. Origin-scoped — navigate first.",
      inputSchema: {
        cacheName: z.string().describe("Cache storage name to delete."),
        ...SESSION_ARG,
      },
    },
    async ({ cacheName, session }) => {
      const g = gateCheck("caches_delete_storage");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("caches_delete_storage", confirmCtxFor(e));
        if (!c.ok) return denyContent("caches_delete_storage", c);
        const r = await withDeadline(
          storageFor(e).cachesDeleteStorage({ cacheName }, "caches_delete_storage"),
          cfgActionTimeout(),
          "caches_delete_storage",
        );
        return okText({ ...r });
      } catch (err) {
        return errText("caches_delete_storage", err);
      }
    },
  );

  // ---- IndexedDB ------------------------------------------------------------

  register(
    "idb_list_databases",
    {
      capability: "read",
      description:
        "Enumerate every IndexedDB database visible to the current page's origin (`indexedDB.databases()`). Returns `{databases:[{name, version}], origin, supported}`. `supported:false` on engines that don't expose `indexedDB.databases()` (older non-Chromium browsers) — the storage is still readable per-database via `idb_list_stores({dbName})`, you just have to know the names. IndexedDB is ORIGIN-SCOPED — navigate first. Read-only.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("idb_list_databases");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          storageFor(e).idbListDatabases("idb_list_databases"),
          cfgActionTimeout(),
          "idb_list_databases",
        );
        return okText({ ok: true, count: r.databases.length, ...r });
      } catch (err) {
        return errText("idb_list_databases", err);
      }
    },
  );

  register(
    "idb_list_stores",
    {
      capability: "read",
      description:
        "List the object-store names inside a database. Read-only — does NOT trigger an upgrade transaction, so it will only see stores that already exist. Returns `{stores:[...], dbName, version, origin}`. Origin-scoped — navigate first.",
      inputSchema: {
        dbName: z.string().describe("Database name."),
        ...SESSION_ARG,
      },
    },
    async ({ dbName, session }) => {
      const g = gateCheck("idb_list_stores");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          storageFor(e).idbListStores({ dbName }, "idb_list_stores"),
          cfgActionTimeout(),
          "idb_list_stores",
        );
        return okText({ ok: true, count: r.stores.length, ...r });
      } catch (err) {
        return errText("idb_list_stores", err);
      }
    },
  );

  register(
    "idb_get",
    {
      capability: "read",
      description:
        "Get the value at a key in an object store. Returns `{found:true, value}` or `{found:false}`. KEY SHAPES: IDB natively accepts strings, numbers, dates, and arrays as keys — all four shapes round-trip through JSON cleanly (Dates as ISO strings; pass the ISO string back in on subsequent calls). VALUE SHAPES: IDB stores structured-clonable values (Blob/ArrayBuffer/Map/Set/Date), but this tool returns over MCP's JSON-only transport — non-JSON-serialisable values surface as a structured error (the platform value is preserved IN the store; it just can't ride the wire). For binary payloads, store them base64-encoded at the app level. **JSON-string fidelity**: if the app under test stored a value via `JSON.stringify(obj)` (a localStorage-habit common in older code), `idb_get` returns the raw JSON STRING verbatim — IDB faithfully preserves shape, and browxai does NOT auto-detect-and-parse stringified values because some apps legitimately store JSON strings as strings. Call-site responsibility: `JSON.parse` if you expect an object. The companion `idb_put` warning surfaces the opposite footgun (an MCP client double-encoding the input). Origin-scoped — navigate first. Read-only.",
      inputSchema: {
        dbName: z.string().describe("Database name."),
        storeName: z.string().describe("Object store name (must exist)."),
        key: z
          .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
          .describe("Primary key — string, number, or array of strings/numbers."),
        ...SESSION_ARG,
      },
    },
    async ({ dbName, storeName, key, session }) => {
      const g = gateCheck("idb_get");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          storageFor(e).idbGet({ dbName, storeName, key }, "idb_get"),
          cfgActionTimeout(),
          "idb_get",
        );
        return okText({ ok: true, ...r });
      } catch (err) {
        return errText("idb_get", err);
      }
    },
  );

  register(
    "idb_put",
    {
      capability: "action",
      description:
        "Put a value at a key in an object store. The object store MUST already exist — this tool does not create stores (store creation requires an IDB upgrade transaction, which is the app's schema concern). `value` is anything JSON-serialisable; non-JSON inputs reject at MCP-validation time. If the store uses an in-line keyPath, `key` is ignored (the keyPath read off `value` is authoritative); otherwise `key` becomes the out-of-line primary key. Origin-scoped — navigate first.",
      inputSchema: {
        dbName: z.string().describe("Database name (must exist)."),
        storeName: z.string().describe("Object store name (must exist)."),
        key: z
          .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
          .describe(
            "Primary key — string, number, or array. Ignored if the store uses an in-line keyPath.",
          ),
        value: z.unknown().describe("JSON-serialisable value to store."),
        ...SESSION_ARG,
      },
    },
    async ({ dbName, storeName, key, value, session }) => {
      const g = gateCheck("idb_put");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("idb_put", confirmCtxFor(e));
        if (!c.ok) return denyContent("idb_put", c);
        // Defensive: if `value` reaches the handler as a JSON-shaped string
        // (some MCP clients double-encode complex args), the page-side path
        // faithfully stores a string — adopter wrote an object, IDB holds
        // a string, app reads back a string. Surface the case as a warning
        // without auto-parsing (some apps legitimately store JSON strings).
        const warnings: string[] = [];
        if (typeof value === "string" && value.length > 1) {
          const first = value[0];
          if (first === "{" || first === "[") {
            try {
              const parsed: unknown = JSON.parse(value);
              if (parsed !== null && typeof parsed === "object") {
                warnings.push(
                  "idb_put: `value` arrived as a JSON-encoded STRING (e.g. `'{\"k\":1}'`). " +
                    "browxai stored it verbatim as a string — IDB now holds a string, not the parsed object. " +
                    "Most MCP clients pass structured args directly; if yours double-encodes complex values, " +
                    "JSON.parse them client-side before calling idb_put. Use idb_get to confirm what was written.",
                );
              }
            } catch {
              /* not JSON; plain string — no warning */
            }
          }
        }
        const r = await withDeadline(
          storageFor(e).idbPut({ dbName, storeName, key, value }, "idb_put"),
          cfgActionTimeout(),
          "idb_put",
        );
        return okText({ ...r, ...(warnings.length > 0 ? { warnings } : {}) });
      } catch (err) {
        return errText("idb_put", err);
      }
    },
  );

  register(
    "idb_delete",
    {
      capability: "action",
      description:
        "Delete the value at a key in an object store. Idempotent — returns the same shape whether or not a record was there. Origin-scoped — navigate first.",
      inputSchema: {
        dbName: z.string().describe("Database name."),
        storeName: z.string().describe("Object store name."),
        key: z
          .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
          .describe("Primary key to delete."),
        ...SESSION_ARG,
      },
    },
    async ({ dbName, storeName, key, session }) => {
      const g = gateCheck("idb_delete");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("idb_delete", confirmCtxFor(e));
        if (!c.ok) return denyContent("idb_delete", c);
        const r = await withDeadline(
          storageFor(e).idbDelete({ dbName, storeName, key }, "idb_delete"),
          cfgActionTimeout(),
          "idb_delete",
        );
        return okText({ ...r });
      } catch (err) {
        return errText("idb_delete", err);
      }
    },
  );

  register(
    "idb_clear",
    {
      capability: "action",
      description:
        "Clear every record from an object store (the store itself remains). Origin-scoped — navigate first.",
      inputSchema: {
        dbName: z.string().describe("Database name."),
        storeName: z.string().describe("Object store name."),
        ...SESSION_ARG,
      },
    },
    async ({ dbName, storeName, session }) => {
      const g = gateCheck("idb_clear");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("idb_clear", confirmCtxFor(e));
        if (!c.ok) return denyContent("idb_clear", c);
        const r = await withDeadline(
          storageFor(e).idbClear({ dbName, storeName }, "idb_clear"),
          cfgActionTimeout(),
          "idb_clear",
        );
        return okText({ ...r });
      } catch (err) {
        return errText("idb_clear", err);
      }
    },
  );

}
