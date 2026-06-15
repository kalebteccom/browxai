import { withDeadline } from "../util/deadline.js";
import { confirmByobAction } from "../policy/confirm.js";
import {
  injectStorageState,
  authSave,
  authLoad,
  authList,
  authDelete,
} from "../session/storage.js";
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
 * Web-storage + named-auth-state tools: the localStorage / sessionStorage CRUD
 * family (registered via a `for` loop over both kinds) plus auth_save / auth_load /
 * auth_list / auth_delete. Split out of `storage-tools` by cohesive family (RFC
 * 0004 P3 / D3 SRP); registered through the shared `ToolHost` seam in the same
 * source order — the web-storage loop is kept verbatim so the 10 registered names
 * land in the same order.
 */
export function registerStorageWebAuthTools(
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
    workspace,
    cfgActionTimeout,
  } = host;

  // ---- layer 2: localStorage / sessionStorage --------------------------------
  // Origin-scoped, page-bound: the session must be navigated to the target
  // origin before any of these tools work. Driven via `page.evaluate(...)`
  // on `window.localStorage` / `window.sessionStorage` — the JS surface is
  // identical, so the implementation factors over a single helper family.

  for (const kind of ["localStorage", "sessionStorage"] as const) {
    const prefix = kind === "localStorage" ? "localstorage" : "sessionstorage";
    const human = kind === "localStorage" ? "localStorage" : "sessionStorage";
    const lifetimeNote =
      kind === "localStorage"
        ? 'Persists across reloads + browser restarts (within the origin\'s persistent storage; cleared by `inject_storage_state({mode:"replace"})` or a profile wipe).'
        : "Session-scoped: cleared automatically when the top-level browsing context ends (tab close). NOT included in `dump_storage_state`/`storageState()` — capture is intentionally a cookies+localStorage blob.";
    const originScope = `${human} is ORIGIN-SCOPED and tied to the current page — the session MUST be navigated to the target origin before this tool works. On about:blank / a different origin the call rejects with a navigation hint.`;

    register(
      `${prefix}_get`,
      {
        capability: "read",
        description: `Read one key from ${human} of the current page's origin. Returns \`{value: string|null, origin}\`. ${originScope} Read-only.`,
        inputSchema: { key: z.string().describe(`${human} key.`), ...SESSION_ARG },
      },
      async ({ key, session }) => {
        const g = gateCheck(`${prefix}_get`);
        if (g) return g;
        try {
          const e = await entryFor(session);
          const r = await withDeadline(
            storageFor(e).webStorageGet(kind, { key }, `${prefix}_get`),
            cfgActionTimeout(),
            `${prefix}_get`,
          );
          return okText({ ok: true, key, ...r });
        } catch (err) {
          return errText(`${prefix}_get`, err);
        }
      },
    );

    register(
      `${prefix}_list`,
      {
        capability: "read",
        description: `List every key/value pair in ${human} of the current page's origin. Returns \`{entries:[{key,value}...], origin}\`. ${originScope} Read-only.`,
        inputSchema: { ...SESSION_ARG },
      },
      async ({ session }) => {
        const g = gateCheck(`${prefix}_list`);
        if (g) return g;
        try {
          const e = await entryFor(session);
          const r = await withDeadline(
            storageFor(e).webStorageList(kind, `${prefix}_list`),
            cfgActionTimeout(),
            `${prefix}_list`,
          );
          return okText({ ok: true, count: r.entries.length, ...r });
        } catch (err) {
          return errText(`${prefix}_list`, err);
        }
      },
    );

    register(
      `${prefix}_set`,
      {
        capability: "action",
        description: `Set a key/value in ${human} of the current page's origin. ${lifetimeNote} ${originScope}`,
        inputSchema: {
          key: z.string().describe(`${human} key.`),
          value: z
            .string()
            .describe(
              `${human} value (string — same as the DOM API, non-strings must be JSON-stringified by the caller).`,
            ),
          ...SESSION_ARG,
        },
      },
      async ({ key, value, session }) => {
        const g = gateCheck(`${prefix}_set`);
        if (g) return g;
        try {
          const e = await entryFor(session);
          const c = await confirmByobAction(`${prefix}_set`, confirmCtxFor(e));
          if (!c.ok) return denyContent(`${prefix}_set`, c);
          const r = await withDeadline(
            storageFor(e).webStorageSet(kind, { key, value }, `${prefix}_set`),
            cfgActionTimeout(),
            `${prefix}_set`,
          );
          return okText({ ok: r.ok, key, origin: r.origin });
        } catch (err) {
          return errText(`${prefix}_set`, err);
        }
      },
    );

    register(
      `${prefix}_delete`,
      {
        capability: "action",
        description: `Remove a key from ${human} of the current page's origin. Idempotent. ${originScope}`,
        inputSchema: { key: z.string().describe(`${human} key.`), ...SESSION_ARG },
      },
      async ({ key, session }) => {
        const g = gateCheck(`${prefix}_delete`);
        if (g) return g;
        try {
          const e = await entryFor(session);
          const c = await confirmByobAction(`${prefix}_delete`, confirmCtxFor(e));
          if (!c.ok) return denyContent(`${prefix}_delete`, c);
          const r = await withDeadline(
            storageFor(e).webStorageDelete(kind, { key }, `${prefix}_delete`),
            cfgActionTimeout(),
            `${prefix}_delete`,
          );
          return okText({ ok: r.ok, key, origin: r.origin });
        } catch (err) {
          return errText(`${prefix}_delete`, err);
        }
      },
    );

    register(
      `${prefix}_clear`,
      {
        capability: "action",
        description: `Wipe ALL keys in ${human} of the current page's origin. ${originScope}`,
        inputSchema: { ...SESSION_ARG },
      },
      async ({ session }) => {
        const g = gateCheck(`${prefix}_clear`);
        if (g) return g;
        try {
          const e = await entryFor(session);
          const c = await confirmByobAction(`${prefix}_clear`, confirmCtxFor(e));
          if (!c.ok) return denyContent(`${prefix}_clear`, c);
          const r = await withDeadline(
            storageFor(e).webStorageClear(kind, `${prefix}_clear`),
            cfgActionTimeout(),
            `${prefix}_clear`,
          );
          return okText({ ok: r.ok, origin: r.origin });
        } catch (err) {
          return errText(`${prefix}_clear`, err);
        }
      },
    );
  }

  // ---- layer 3: named auth-states --------------------------------------------
  // Wraps layer 1: auth_save writes a workspace-rooted JSON of the bulk
  // storageState; auth_load reads it back. open_session({authState}) is the
  // canonical seeding path; inject_storage_state({state: <path or blob>})
  // is the in-flight reseat. NO parallel implementation.

  register(
    "auth_save",
    {
      capability: "action",
      description:
        "Capture the session's current storage state into a named slot at `$BROWX_WORKSPACE/.auth-states/<name>.json`. Names are letters/digits/`._-` only (no separators, no `..`). Overwrites an existing slot of the same name. Pair with `open_session({authState})` to spin up a session pre-logged-in, or with `auth_load` + `inject_storage_state` for in-flight reseating. SECURITY NOTE: cookie *values* may carry credentials — these files are sensitive (a future secrets-masking pass lands separately).",
      inputSchema: {
        name: z.string().describe("Slot name (letters/digits/`._-` only)."),
        ...SESSION_ARG,
      },
    },
    async ({ name, session }) => {
      const g = gateCheck("auth_save");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("auth_save", confirmCtxFor(e));
        if (!c.ok) return denyContent("auth_save", c);
        const r = await withDeadline(
          authSave(e.session.page().context(), workspace.root, name),
          cfgActionTimeout(),
          "auth_save",
        );
        return okText({ ...r });
      } catch (err) {
        return errText("auth_save", err);
      }
    },
  );

  register(
    "auth_load",
    {
      capability: "action",
      description:
        'Load a named storage-state slot AND apply it to an existing session (replaces the context\'s cookies/localStorage/IndexedDB — same semantics as `inject_storage_state({mode:"replace"})`). For SEEDING a new session at creation time, prefer `open_session({authState:"<name>"})` — that\'s cheaper (no clear-then-replace cycle on a fresh context) and lets incognito mode use the Playwright-native primitive.',
      inputSchema: {
        name: z.string().describe("Slot name (must exist; auth_save it first)."),
        ...SESSION_ARG,
      },
    },
    async ({ name, session }) => {
      const g = gateCheck("auth_load");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("auth_load", confirmCtxFor(e));
        if (!c.ok) return denyContent("auth_load", c);
        const blob = authLoad(workspace.root, name);
        const r = await withDeadline(
          injectStorageState(e.session.page().context(), e.session.page(), blob, {
            mode: "replace",
          }),
          cfgActionTimeout(),
          "auth_load",
        );
        return okText({ ok: true, name, applied: r });
      } catch (err) {
        return errText("auth_load", err);
      }
    },
  );

  register(
    "auth_list",
    {
      capability: "read",
      description:
        "Enumerate every named auth-state slot in the workspace. Returns `{name, path, bytes, modifiedAt}` per slot, sorted by name. Read-only.",
      inputSchema: {},
    },
    async () => {
      const g = gateCheck("auth_list");
      if (g) return g;
      try {
        const slots = authList(workspace.root);
        return okText({ ok: true, count: slots.length, slots });
      } catch (err) {
        return errText("auth_list", err);
      }
    },
  );

  register(
    "auth_delete",
    {
      capability: "action",
      description:
        "Remove a named auth-state slot from the workspace. Idempotent (`existed:false` if it wasn't there).",
      inputSchema: { name: z.string().describe("Slot name.") },
    },
    async ({ name }) => {
      const g = gateCheck("auth_delete");
      if (g) return g;
      try {
        const r = authDelete(workspace.root, name);
        return okText({ ...r, name });
      } catch (err) {
        return errText("auth_delete", err);
      }
    },
  );

  // ===========================================================================
  // Cache API + IndexedDB CRUD.
  //
  // Sibling families of the cookie / web-storage CRUD above. Both APIs are
  // ORIGIN-SCOPED — the page MUST be navigated to the target origin first
  // (same posture as localStorage / sessionStorage). On about:blank or a
  // different origin the call rejects with a navigation hint.
  //
  // Capability split:
  //   reads  (`caches_list_storages`, `caches_list`, `caches_get`,
  //           `idb_list_databases`, `idb_list_stores`, `idb_get`)  → `read`
  //   writes (`caches_put`, `caches_delete`, `caches_clear`,
  //           `caches_delete_storage`, `idb_put`, `idb_delete`,
  //           `idb_clear`)                                          → `action`
  // No new capability gate — same posture as web-storage CRUD.
  // ===========================================================================

}
