import { withDeadline } from "../util/deadline.js";
import { confirmByobAction } from "../policy/confirm.js";
import {
  dumpStorageState,
  injectStorageState,
  readStorageStateFile,
  cookiesGet,
  cookiesDelete,
  cookiesClear,
  type StorageStateBlob,
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
 * Storage-state + cookies tools: dump_storage_state / inject_storage_state and the
 * cookies CRUD family (cookies_get / cookies_list / cookies_set / cookies_delete /
 * cookies_clear). Split out of `storage-tools` by cohesive family (RFC 0004 P3 /
 * D3 SRP); registered through the shared `ToolHost` seam in the same source order.
 */
export function registerStorageStateCookiesTools(
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

  // ---- layer 1 ----------------------------------------------------------------
  register(
    "dump_storage_state",
    {
      capability: "read",
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
      capability: "action",
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
      capability: "read",
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
      capability: "read",
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
      capability: "action",
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
      capability: "action",
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
      capability: "action",
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
}
