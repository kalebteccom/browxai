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
import { requirePage } from "../engine/index.js";

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
    subInterfaceGate,
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
        "Capture the session's storage state (cookies and per-origin localStorage) in the shape of Playwright's `storageState()`. Always returns the blob; with `path` it also writes JSON to a workspace-rooted file. Use it to checkpoint a login for `inject_storage_state`; use `auth_save` to keep it under a name and `cookies_list` for cookies only. sessionStorage is not included. Cookie values may carry credentials, so treat the blob and the file as sensitive: with the `secrets` capability on, registered values are masked in the returned blob, but a file written with `path` keeps the values as the browser holds them.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-rooted JSON file to write the state to, as well as returning it inline. A path that leaves $BROWX_WORKSPACE, including through a symlink, is rejected.",
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
          dumpStorageState(requirePage(e.session).context(), workspace.root, { path }),
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
        'Apply a bulk storage state to the session\'s context. `state` is an inline blob (from `dump_storage_state`) or a workspace-rooted JSON path. `mode:"replace"` (default) uses `setStorageState`, which first clears the context\'s cookies, localStorage and IndexedDB. `mode:"merge"` adds cookies without clearing and merges localStorage for the currently loaded origin only; other origins in the blob come back in `originsSkipped`. To seed a session at creation, prefer `open_session({storageState})` or `open_session({authState})`. Use `auth_load` to apply a named slot.',
      inputSchema: {
        state: z
          .union([
            z.string().describe("Workspace-rooted JSON path to a state file (escape rejected)."),
            z
              .object({ cookies: z.array(z.any()), origins: z.array(z.any()) })
              .passthrough()
              .describe("Inline state blob (the shape `dump_storage_state` returns)."),
          ])
          .describe(
            "Inline state blob `{cookies, origins}` (the shape `dump_storage_state` returns) or a workspace-rooted path to a JSON state file.",
          ),
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
          injectStorageState(requirePage(e.session).context(), requirePage(e.session), blob, {
            mode,
          }),
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
        "Read one cookie by name from the session's jar and return the full Playwright cookie object, or `null`. `url` narrows the jar to cookies that would be sent to that URL. Use `cookies_list` for several cookies and `dump_storage_state` for cookies plus localStorage.",
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
          cookiesGet(requirePage(e.session).context(), { name, url }),
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
        "List the cookies in the session's jar as full Playwright cookie objects. `urls` keeps only cookies that would be sent to those URLs. Use `cookies_get` for one cookie by name and `dump_storage_state` for cookies plus localStorage.",
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
        const sg = subInterfaceGate("cookies_list", "storage", e);
        if (sg) return sg;
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
        "Set one cookie. Pass `url` (recommended; it derives domain, path and secure) or both `domain` and `path`; any other combination is rejected. `expires` is Unix seconds (omit for a session cookie). Use `inject_storage_state` to seed many cookies and localStorage at once, and `auth_save` to keep a whole login under a name. Setting the same name, domain and path again overwrites it.",
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
        httpOnly: z.boolean().optional().describe("Set the HttpOnly flag."),
        secure: z.boolean().optional().describe("Set the Secure flag. Passing `url` derives it."),
        sameSite: z
          .enum(["Strict", "Lax", "None"])
          .optional()
          .describe(
            "SameSite attribute: `Strict`, `Lax` or `None`. Browsers require `secure:true` with `None`.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ name, value, url, domain, path, expires, httpOnly, secure, sameSite, session }) => {
      const g = gateCheck("cookies_set");
      if (g) return g;
      try {
        const e = await entryFor(session);
        const sg = subInterfaceGate("cookies_set", "storage", e);
        if (sg) return sg;
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
        "Delete cookies by name, optionally narrowed by `url` (derives domain and path) or an explicit `domain` and `path`. Returns `{ok:true}` even when nothing matched; call `cookies_get` first to check presence. `cookies_clear` removes every cookie.",
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
          cookiesDelete(requirePage(e.session).context(), { name, url, domain, path }),
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
        'Remove all cookies in the session\'s jar, across every domain in this context. localStorage and sessionStorage stay: use the `*_clear` tools for those, or `inject_storage_state({state, mode:"replace"})` to reset everything. Use `cookies_delete` for one cookie.',
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
          cookiesClear(requirePage(e.session).context()),
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
