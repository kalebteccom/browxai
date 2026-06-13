import { withDeadline } from "../util/deadline.js";
import { confirmByobAction } from "../policy/confirm.js";
import {
  dumpStorageState,
  injectStorageState,
  readStorageStateFile,
  cookiesGet,
  cookiesDelete,
  cookiesClear,
  authSave,
  authLoad,
  authList,
  authDelete,
  type StorageStateBlob,
} from "../session/storage.js";
import { startHar, stopHar, readHarIfSmall, HAR_INLINE_CAP_BYTES } from "../page/har.js";
import { stopVideo, readVideoIfReady, VIDEO_INLINE_CAP_BYTES } from "../page/video.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Storage-state tools — the three-layer storage surface plus the file-backed
 * artifact / HAR / video families. Layer 1 bulk dump/inject, layer 2 granular
 * cookies + web-storage + Cache API + IndexedDB CRUD, layer 3 named auth-state
 * slots, and the session artifact KV / HAR record / video record tools. Every
 * block registers through the shared `ToolHost` seam; the host owns the closures
 * (gate, confirm, storage port, workspace), this module owns the registrations.
 */
export function registerStorageTools(host: ToolHost): void {
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

  // ---- layer 1 ----------------------------------------------------------------
  register(
    "dump_storage_state",
    {
      description:
        "Storage-state bulk dump — capture the session's current storage state (cookies + per-origin localStorage), the blob format Playwright's `BrowserContext.storageState()` returns. ALWAYS returns the blob; with `path`, also writes JSON to a workspace-rooted file (path-traversal rejected — must resolve under $BROWX_WORKSPACE). Use this to checkpoint an authed state for later replay via `inject_storage_state` / `auth_save`. Read-only. SECURITY NOTE: cookie *values* may carry credentials — treat the dump as sensitive (a future egress-masking pass lands separately).",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Optional workspace-rooted JSON file to write the state to (in addition to returning it inline). Rejected if it escapes $BROWX_WORKSPACE.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ path, session }) => {
      const g = gateCheck("dump_storage_state");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          dumpStorageState(e.session.page().context(), workspace.root, { path }),
          cfgActionTimeout(),
          "dump_storage_state",
        );
        return okText({
          ok: true,
          cookies: r.state.cookies.length,
          origins: r.state.origins.length,
          ...(r.path ? { path: r.path, bytes: r.bytes } : {}),
          state: r.state,
        });
      } catch (err) {
        return errText("dump_storage_state", err);
      }
    },
  );

  register(
    "inject_storage_state",
    {
      description:
        "Storage-state bulk inject — apply a bulk storage state to the current session's context. `state` accepts either an inline blob OR a workspace-rooted JSON path (escape rejected). `mode:\"replace\"` (default) uses Playwright's `setStorageState` which CLEARS the context's existing cookies/localStorage/IndexedDB first — clean swap semantics. `mode:\"merge\"` adds cookies via `addCookies` without clearing AND best-effort merges localStorage for the currently-loaded origin only (other origins in the blob are skipped and returned in `originsSkipped` — localStorage is page-bound, not context-bound). For per-session seeding at CREATION, prefer `open_session({ storageState | authState })` — that's the Playwright-native primitive on incognito mode.",
      inputSchema: {
        state: z.union([
          z.string().describe("Workspace-rooted JSON path to a state file (escape rejected)."),
          z
            .object({ cookies: z.array(z.any()), origins: z.array(z.any()) })
            .passthrough()
            .describe("Inline state blob (the shape `dump_storage_state` returns)."),
        ]),
        mode: z
          .enum(["replace", "merge"])
          .optional()
          .describe(
            "`replace` (default) clears existing state then applies; `merge` adds without clearing (localStorage merge limited to current origin).",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ state, mode, session }) => {
      const g = gateCheck("inject_storage_state");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("inject_storage_state", confirmCtxFor(e));
        if (!c.ok) return denyContent("inject_storage_state", c);
        const blob: StorageStateBlob =
          typeof state === "string"
            ? readStorageStateFile(workspace.root, state, "inject_storage_state")
            : state;
        const r = await withDeadline(
          injectStorageState(e.session.page().context(), e.session.page(), blob, { mode }),
          cfgActionTimeout(),
          "inject_storage_state",
        );
        return okText({ ok: true, ...r });
      } catch (err) {
        return errText("inject_storage_state", err);
      }
    },
  );

  // ---- layer 2: cookies CRUD -------------------------------------------------
  register(
    "cookies_get",
    {
      description:
        "Read a single cookie by name. Optional `url` narrows the cookie jar (only cookies that would be sent on a request to that URL). Returns the full Playwright cookie object or `null`. Read-only.",
      inputSchema: {
        name: z.string().describe("Cookie name."),
        url: z
          .string()
          .optional()
          .describe(
            "Optional URL — restricts to cookies that match this URL's domain/path/secure-context.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ name, url, session }) => {
      const g = gateCheck("cookies_get");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          cookiesGet(e.session.page().context(), { name, url }),
          cfgActionTimeout(),
          "cookies_get",
        );
        return okText({ ok: true, cookie: r });
      } catch (err) {
        return errText("cookies_get", err);
      }
    },
  );

  register(
    "cookies_list",
    {
      description:
        "List cookies in the session's jar. `urls` filters to cookies that would be sent on requests to those URLs (Playwright's native filter). Returns the full Playwright cookie array. Read-only.",
      inputSchema: {
        urls: z
          .array(z.string())
          .optional()
          .describe("Optional URL list — restricts the result to cookies matching these URLs."),
        ...SESSION_ARG,
      },
    },
    async ({ urls, session }) => {
      const g = gateCheck("cookies_list");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          storageFor(e).cookiesList({ urls }),
          cfgActionTimeout(),
          "cookies_list",
        );
        return okText({ ok: true, count: r.length, cookies: r });
      } catch (err) {
        return errText("cookies_list", err);
      }
    },
  );

  register(
    "cookies_set",
    {
      description:
        'Set a single cookie. Playwright\'s `addCookies` requires either `url` (recommended — derives domain/path/secure for you) OR both `domain` AND `path` explicitly; one of those two forms must be supplied or the call is rejected. Optional `expires` (Unix seconds), `httpOnly`, `secure`, `sameSite` (`"Strict"|"Lax"|"None"`). Idempotent w.r.t. (name, domain, path).',
      inputSchema: {
        name: z.string().describe("Cookie name."),
        value: z.string().describe("Cookie value."),
        url: z
          .string()
          .optional()
          .describe(
            "Recommended: source URL. Derives domain/path/secure. Mutually exclusive with explicit `domain`+`path`.",
          ),
        domain: z.string().optional().describe("Explicit cookie domain. Requires `path` too."),
        path: z
          .string()
          .optional()
          .describe('Explicit cookie path (e.g. "/"). Requires `domain` too.'),
        expires: z.number().optional().describe("Unix time in seconds. Omit for a session cookie."),
        httpOnly: z.boolean().optional(),
        secure: z.boolean().optional(),
        sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
        ...SESSION_ARG,
      },
    },
    async ({ name, value, url, domain, path, expires, httpOnly, secure, sameSite, session }) => {
      const g = gateCheck("cookies_set");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("cookies_set", confirmCtxFor(e));
        if (!c.ok) return denyContent("cookies_set", c);
        const r = await withDeadline(
          storageFor(e).cookiesSet({
            name,
            value,
            url,
            domain,
            path,
            expires,
            httpOnly,
            secure,
            sameSite,
          }),
          cfgActionTimeout(),
          "cookies_set",
        );
        return okText({ ok: r.ok, name: r.name });
      } catch (err) {
        return errText("cookies_set", err);
      }
    },
  );

  register(
    "cookies_delete",
    {
      description:
        "Delete cookies by name, optionally narrowed by `url` (derives domain/path) or explicit `domain`/`path`. Returns `{ok:true}` even if no cookie matched (idempotent — distinguish presence via `cookies_get` first if needed).",
      inputSchema: {
        name: z.string().describe("Cookie name."),
        url: z.string().optional().describe("Optional URL — narrows by derived domain/path."),
        domain: z
          .string()
          .optional()
          .describe("Explicit domain narrowing (overrides url-derived)."),
        path: z.string().optional().describe("Explicit path narrowing (overrides url-derived)."),
        ...SESSION_ARG,
      },
    },
    async ({ name, url, domain, path, session }) => {
      const g = gateCheck("cookies_delete");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("cookies_delete", confirmCtxFor(e));
        if (!c.ok) return denyContent("cookies_delete", c);
        const r = await withDeadline(
          cookiesDelete(e.session.page().context(), { name, url, domain, path }),
          cfgActionTimeout(),
          "cookies_delete",
        );
        return okText({ ok: r.ok, name });
      } catch (err) {
        return errText("cookies_delete", err);
      }
    },
  );

  register(
    "cookies_clear",
    {
      description:
        'Wipe ALL cookies in the session\'s jar. Destructive across every domain in this context. localStorage and sessionStorage are untouched (use `*_clear` for those, or `inject_storage_state({state, mode:"replace"})` to reset everything via a bulk swap).',
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("cookies_clear");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("cookies_clear", confirmCtxFor(e));
        if (!c.ok) return denyContent("cookies_clear", c);
        const r = await withDeadline(
          cookiesClear(e.session.page().context()),
          cfgActionTimeout(),
          "cookies_clear",
        );
        return okText({ ok: r.ok });
      } catch (err) {
        return errText("cookies_clear", err);
      }
    },
  );

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

  // ---- Cache API -------------------------------------------------------------

  register(
    "caches_list_storages",
    {
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

  // ---- per-session artifact KV ----------------------------------------------
  //
  // Session-scoped workspace primitives. First-class save/get/list of string
  // or binary payloads (the "build your own library over time" loop). Before
  // this, agents round-tripped scripts/files/blobs through `name_ref`/
  // `name_region` — both ref-typed and a poor fit for raw bytes.
  //
  // Capability split: `artifact_save` → `action` (writes a file);
  // `artifact_get` / `artifact_list` → `read`. Workspace-rooted at
  // `$BROWX_WORKSPACE/.artifacts/<sessionId>/<name>`. Name restricted
  // (no separators / `..` / leading dots). Capacity-bounded (200 entries,
  // 50 MiB); oldest-write evicted. The on-disk dir is wiped on session
  // teardown — sessions that never wrote an artifact leave no trace.

  register(
    "artifact_save",
    {
      description:
        'Save a session-scoped artifact (string or binary) into the session\'s workspace-rooted KV. The artifact lives at `$BROWX_WORKSPACE/.artifacts/<sessionId>/<name>`. `name` must be letters / digits / `._-` only (no path separators, no `..`, no leading dot — workspace-escape rejected). `content` is text by default (`encoding:"utf8"`); pass `encoding:"base64"` for binary payloads. Overwrites an existing artifact with the same name. The session\'s KV is capacity-bounded at 200 entries / 50 MiB — past either cap the OLDEST-write entry is evicted to make room. Cleared on `close_session` — artifacts don\'t survive teardown. Retrieve with `artifact_get({name})`; enumerate with `artifact_list()`. → `{ ok, name, size, mtime, path }`. Capability `action`.',
      inputSchema: {
        name: z
          .string()
          .describe(
            "Artifact name. Letters/digits/`._-` only — no separators, no `..`, no leading dot.",
          ),
        content: z
          .string()
          .describe(
            'Content to store. Text by default; pass `encoding:"base64"` for binary payloads.',
          ),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe("How `content` is encoded. Default `utf8` (text). Use `base64` for binary."),
        ...SESSION_ARG,
      },
    },
    async ({ name, content, encoding, session }) => {
      const g = gateCheck("artifact_save");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const info = e.artifacts.save(name, content, encoding ?? "utf8");
        return okText({
          ok: true,
          name: info.name,
          size: info.size,
          mtime: info.mtime,
          path: e.artifacts.pathFor(name),
        });
      } catch (err) {
        return errText("artifact_save", err);
      }
    },
  );

  register(
    "artifact_get",
    {
      description:
        "Read back a previously-saved session artifact. `name` matches the value passed to `artifact_save`. `encoding` controls the return shape — `utf8` (default) returns the bytes as text; `base64` returns them base64-encoded (round-trip-faithful for binary payloads). Throws if the name is unknown in this session. → `{ ok, name, content, size, mtime, encoding }`. Capability `read`.",
      inputSchema: {
        name: z.string().describe("Artifact name (as passed to `artifact_save`)."),
        encoding: z
          .enum(["utf8", "base64"])
          .optional()
          .describe("Return encoding. Default `utf8`; use `base64` for binary payloads."),
        ...SESSION_ARG,
      },
    },
    async ({ name, encoding, session }) => {
      const g = gateCheck("artifact_get");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = e.artifacts.get(name, encoding ?? "utf8");
        return okText({
          ok: true,
          name,
          content: r.content,
          size: r.size,
          mtime: r.mtime,
          encoding: r.encoding,
        });
      } catch (err) {
        return errText("artifact_get", err);
      }
    },
  );

  register(
    "artifact_list",
    {
      description:
        "Enumerate every artifact in this session's KV (sorted by name asc). Read-only. → `{ ok, count, artifacts: [{ name, size, mtime }] }`. Per-session, capacity-bounded (200 entries / 50 MiB); cleared on `close_session`. Capability `read`.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("artifact_list");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const artifacts = e.artifacts.list();
        return okText({ ok: true, count: artifacts.length, artifacts });
      } catch (err) {
        return errText("artifact_list", err);
      }
    },
  );

  // ---- HAR record / replay ---------------------------------------------------
  //
  // Full-session reproducibility — capture every request the page made into a
  // HAR file, then later replay with `open_session({hars:[file]})` so XHR/fetch
  // are served from the archive. Recording sits under capability `action`
  // (writes a file). Replay is wired at `open_session` time (no separate tool).
  //
  // Finalize timing. Playwright writes the HAR file on `context.close()` —
  // there is no public mid-session flush. Both `start_har` (runtime) and
  // `open_session({har})` (creation-time, native) hit the same constraint:
  // the .har on disk is complete after `close_session`. `stop_har` removes
  // the recording route so further requests aren't logged, but the file
  // remains pending until session teardown.

  register(
    "start_har",
    {
      description:
        "Begin HAR recording on the current session via `context.routeFromHAR(path, {update:true})`. From the next request onward every page network event is captured into a HAR archive. **The file on disk is finalized when the session closes** (`close_session`) — Playwright provides no mid-session flush. Re-calling `start_har` while a recorder is already active transparently stops the prior one and swaps targets. For up-front recording across the whole session prefer the additive `open_session({har:{...}})` schema (Playwright's blessed native primitive — same finalize-on-close caveat). Capability `action`. Workspace-rooted paths only; traversal rejected.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted .har file path. Default: `<workspace>/har/<session-id>-<ISO>.har`. Rejected if it escapes `$BROWX_WORKSPACE`.",
          ),
        mode: z
          .enum(["full", "minimal"])
          .optional()
          .describe(
            "`full` (default) records full HAR; `minimal` records only what `routeFromHAR` needs for replay.",
          ),
        content: z
          .enum(["embed", "attach", "omit"])
          .optional()
          .describe(
            "Body persistence: `embed` (default, inline), `attach` (sidecar files / .zip entries), `omit` (drop bodies).",
          ),
        urlFilter: z
          .string()
          .optional()
          .describe("Optional glob/regex URL filter — only matching requests are stored."),
        ...SESSION_ARG,
      },
    },
    async ({ path, mode, content, urlFilter, session }) => {
      const g = gateCheck("start_har");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const c = await confirmByobAction("start_har", confirmCtxFor(e));
        if (!c.ok) return denyContent("start_har", c);
        const r = await withDeadline(
          startHar(e.session.page().context(), e.har, workspace.root, e.id, {
            path,
            mode,
            content,
            urlFilter,
          }),
          cfgActionTimeout(),
          "start_har",
        );
        return okText({
          ok: true,
          session: e.id,
          path: r.path,
          mode: r.mode,
          content: r.content,
          replacedPrior: r.replacedPrior,
          finalizesOn: "close_session",
          hint: "The HAR file is written to disk when the session closes (Playwright constraint). Call `close_session` to finalize; until then the file at `path` may be absent or incomplete. Re-call `start_har` to swap targets; `stop_har` removes the recording route.",
        });
      } catch (err) {
        return errText("start_har", err);
      }
    },
  );

  register(
    "stop_har",
    {
      description:
        "Stop HAR recording on the current session. Removes the recording route so further requests aren't logged. **The HAR file is finalized only when the session closes** (`close_session`) — there is no mid-session flush on Playwright's native HAR pipeline. Returns the reserved path; if the file already exists on disk and is under ~256 KB, an inline `har` field is also returned (only happens once the context has actually been closed and re-opened with the same path; usually you'll just read the file after `close_session`). Re-recording within the same session: stop_har, then start_har again with a fresh path. Capability `action`.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("stop_har");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const r = await withDeadline(
          stopHar(e.session.page().context(), e.har),
          cfgActionTimeout(),
          "stop_har",
        );
        // Best-effort inline: only succeeds when the file already exists AND
        // is under the cap. On the routeFromHAR(update:true) path that's
        // typically not until close_session — surface the path either way so
        // the caller can pick it up post-teardown.
        const inline = r.path ? readHarIfSmall(r.path, HAR_INLINE_CAP_BYTES) : undefined;
        return okText({
          ok: true,
          session: e.id,
          wasActive: r.wasActive,
          ...(r.path ? { path: r.path } : {}),
          finalized: r.finalized,
          nativeRecord: r.nativeRecord,
          ...(inline !== undefined
            ? { har: inline, inlineBytes: Buffer.byteLength(inline, "utf8") }
            : {}),
          hint: r.nativeRecord
            ? "HAR was wired at session creation via `open_session({har})` — the native `recordHar` primitive can't be toggled off mid-session. The file will be written when `close_session` runs."
            : r.wasActive
              ? "Recording route removed. The .har file is finalized when `close_session` runs (Playwright constraint). To re-record in this session: call `start_har` again with a new `path`."
              : "No HAR recorder was active.",
        });
      } catch (err) {
        return errText("stop_har", err);
      }
    },
  );

  // ---- Session video recording ----------------------------------------------
  //
  // Playwright's `recordVideo` is a context-creation primitive — there is no
  // public runtime start. Mirror of the native `recordHar` path: the recorder
  // is wired by `open_session({recordVideo})` and finalized on context.close
  // (which `close_session` triggers). `stop_video` signals intent — it
  // surfaces the constraint instead of pretending to flush mid-context.
  // `get_video` reads the finalized .webm. Both gated by `file-io`.

  register(
    "stop_video",
    {
      description:
        "Signal that the session's video recording should be finalized. Mirrors the `stop_har` native-record posture: **the .webm is written to disk only when the session closes** (`close_session`) — Playwright provides no mid-context flush on the `recordVideo` primitive. This call marks the recorder as `pendingFinalize:true` and returns the reserved target path; the actual file appears on disk after `close_session`. Use `get_video` afterwards to retrieve the bytes or absolute path. Returns a structured error if no video recorder is active (you didn't pass `recordVideo` to `open_session`). Capability `file-io`.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("stop_video");
      if (g) return g;
      try {
        const e = await entryFor(session);
        if (e.mode === "attached") {
          return errText(
            "stop_video",
            new Error(
              "stop_video: not supported on attached / BYOB sessions — recordVideo is " +
                "a context-creation primitive and we don't wire it on the consumer's " +
                'Chrome (not-owned). Open a managed session ({mode:"persistent"} or ' +
                '{mode:"incognito"}) with {recordVideo:{...}} and re-run.',
            ),
          );
        }
        if (!e.video.active) {
          return errText(
            "stop_video",
            new Error(
              "stop_video: no video recorder is active on this session. Video must be " +
                "wired at session creation via `open_session({recordVideo:{...}})` — " +
                "Playwright doesn't expose a runtime `start_video` primitive.",
            ),
          );
        }
        const r = stopVideo(e.video);
        return okText({
          ok: true,
          session: e.id,
          wasActive: r.wasActive,
          ...(r.targetPath ? { path: r.targetPath } : {}),
          pendingFinalize: r.pendingFinalize,
          finalized: r.finalized,
          finalizesOn: "close_session",
          hint: "Playwright finalizes the .webm only when the context closes. Call `close_session` to flush; then `get_video` to read the file. There is no mid-context flush on the native recordVideo primitive — same constraint shape as `open_session({har})`.",
        });
      } catch (err) {
        return errText("stop_video", err);
      }
    },
  );

  register(
    "get_video",
    {
      description:
        'Read the session\'s recorded video. **The .webm is written only after `close_session`** — calling `get_video` before then returns a structured error pointing at the close requirement. `format:"path"` (default) returns the absolute path + on-disk size. `format:"bytes"` additionally inlines the file as base64 when under ~1 MiB; larger files return path + `tooLargeToInline:true` so the caller reads them off disk. Returns a structured error if no recorder was wired (no `recordVideo` on `open_session`). Capability `file-io`.',
      inputSchema: {
        format: z
          .enum(["path", "bytes"])
          .optional()
          .describe(
            "`path` (default) returns absolute path + size. `bytes` additionally inlines the file as base64 when under ~1 MiB.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ format, session }) => {
      const g = gateCheck("get_video");
      if (g) return g;
      try {
        const e = await entryFor(session);
        if (e.mode === "attached") {
          return errText(
            "get_video",
            new Error(
              "get_video: not supported on attached / BYOB sessions — recordVideo is " +
                "a context-creation primitive and was refused at session-open time on " +
                "this session. Open a managed session with {recordVideo:{...}} to record.",
            ),
          );
        }
        if (!e.video.active || !e.video.targetPath) {
          return errText(
            "get_video",
            new Error(
              "get_video: no video recorder is active on this session. Video must be " +
                "wired at session creation via `open_session({recordVideo:{...}})`.",
            ),
          );
        }
        const r = readVideoIfReady(e.video.targetPath, format ?? "path", VIDEO_INLINE_CAP_BYTES);
        if (!r.exists) {
          return errText(
            "get_video",
            new Error(
              `get_video: the .webm is not yet on disk at "${e.video.targetPath}". ` +
                "Playwright finalizes recordVideo only when the context closes. " +
                "Call `close_session` to flush, then re-call `get_video`.",
            ),
          );
        }
        return okText({
          ok: true,
          session: e.id,
          path: r.path,
          bytes: r.bytes ?? 0,
          format: format ?? "path",
          ...(r.inlineBase64 !== undefined ? { videoBase64: r.inlineBase64 } : {}),
          ...(r.tooLargeToInline ? { tooLargeToInline: true } : {}),
          hint:
            r.inlineBase64 !== undefined
              ? "Video bytes inlined as base64 (under the 1 MiB inline cap). Decode and pipe to a .webm consumer."
              : r.tooLargeToInline
                ? "Video exceeds the 1 MiB inline cap. Read it off disk at `path`."
                : 'Video on disk. Read it at `path`, or re-call with `format:"bytes"` for inline base64 (under-cap files only).',
        });
      } catch (err) {
        return errText("get_video", err);
      }
    },
  );
}
