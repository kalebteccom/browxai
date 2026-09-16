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
 * IndexedDB tools: `idb_*` (list_databases / list_stores / get / put / delete /
 * clear). The sibling of `storage-caches-tools.ts`; the two were one module until
 * the sub-interface gate pushed it past the 450-line ceiling, and they split along
 * the line their own filename already named. Registered through the shared
 * `ToolHost` seam in the same source order.
 *
 * Every handler gates on the engine's declared `storage` sub-interface before it
 * dispatches: an engine that does not declare one must REFUSE, not answer from a
 * substrate that has nothing behind it. (RFC 0004 D5.)
 */
export function registerStorageIdbTools(
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
        const sg = subInterfaceGate("idb_list_databases", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("idb_list_stores", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("idb_get", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("idb_put", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("idb_delete", "storage", e);
        if (sg) return sg;
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
        const sg = subInterfaceGate("idb_clear", "storage", e);
        if (sg) return sg;
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
