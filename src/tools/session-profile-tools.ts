import { profileStatus, type LiveProfileProbe } from "../session/profile-status.js";
import type { SessionEntry } from "../session/registry.js";
import type {
  RegisterHost,
  GateHost,
  SessionHost,
  ConfigHost,
  EnvelopeHost,
  ServerServicesHost,
} from "./host.js";
import { requirePage } from "../engine/index.js";

/**
 * Managed-profile inventory: `profile_status`. Workspace introspection only —
 * it reads the profiles directory and the live session registry, and never
 * touches a page or launches a browser.
 */

const DESCRIPTION =
  "List the managed profile directories under `<workspace>/profiles/` (plus the default session's `<workspace>/profile`): which exist, their size, last write, and which are open now. Use it to pick a profile or find abandoned ones; it opens nothing. Per profile: `{name, path, bytes, files, modifiedAt}`, plus `live` while a session runs on it and `savedAuthState` when an `auth_save` slot has the same name. `scanTruncated:true` means the directory walk hit its entry budget, so `bytes`, `files` and `modifiedAt` are lower bounds.\n\nIt does not report whether a profile is logged in: Chromium encrypts cookie values with an OS key, so a closed profile's auth state is unreadable without launching it. Two substitutes: `live.cookieDomains` (domains the open context holds cookies for now; cookies there do not prove they still authenticate) and `savedAuthState` (the slot file as of `savedAt`; the link to the profile is the matching name only, and its cookies may have expired). For a closed profile `modifiedAt` is the staleness signal. To learn real auth state, open a session on the profile and navigate.";

/** Reduce the live registry to the profile probes the inventory consumes.
 *  Incognito and attached sessions carry no profile dir and drop out. */
function liveProbes(entries: readonly SessionEntry[]): LiveProfileProbe[] {
  const probes: LiveProfileProbe[] = [];
  for (const entry of entries) {
    const profileDir = entry.session.profileDir;
    if (profileDir === undefined) continue;
    probes.push({
      sessionId: entry.id,
      profileDir,
      cookieDomains: async () => {
        const cookies = await requirePage(entry.session).context().cookies();
        return cookies.map((c) => c.domain);
      },
    });
  }
  return probes;
}

export function registerSessionProfileTools(
  host: RegisterHost & GateHost & SessionHost & ConfigHost & EnvelopeHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, registry, workspace, okText, errText } = host;

  register(
    "profile_status",
    {
      capability: "read",
      description: DESCRIPTION,
      inputSchema: {
        profile: z
          .string()
          .optional()
          .describe(
            'Report only this profile (letters/digits/`._-`, no separators). `"default"` is the default session\'s `<workspace>/profile` dir. Omit for the whole inventory. An unknown name yields an empty list, not an error.',
          ),
      },
    },
    async ({ profile }) => {
      const g = gateCheck("profile_status");
      if (g) return g;
      try {
        const r = await profileStatus(workspace.root, liveProbes(registry.list()), { profile });
        return okText({
          ok: true,
          profilesRoot: r.profilesRoot,
          count: r.profiles.length,
          profiles: r.profiles,
          warnings: r.warnings,
        });
      } catch (err) {
        return errText("profile_status", err);
      }
    },
  );
}
