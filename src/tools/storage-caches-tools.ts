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
 * Cache API tools: `caches_*` (list_storages / list / get / put / delete / clear /
 * delete_storage). Split out of `storage-tools` by cohesive family (RFC 0004 P3 /
 * D3 SRP); the IndexedDB half moved to `storage-idb-tools.ts` when the
 * sub-interface gate pushed the combined file past the size ceiling. Registered
 * through the shared `ToolHost` seam in the same source order.
 *
 * Every handler gates on the engine's declared `storage` sub-interface before it
 * dispatches: an engine that does not declare one must REFUSE, not answer from a
 * substrate that has nothing behind it. (RFC 0004 D5.)
 */
export function registerStorageCachesTools(
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
    subInterfaceGate,
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
        const sg = subInterfaceGate("caches_list_storages", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("caches_list", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("caches_get", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("caches_put", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("caches_delete", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("caches_clear", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("caches_delete_storage", "storage", e);
        if (sg) return sg;
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
}
