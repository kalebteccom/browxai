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

/**
 * Managed-profile inventory: `profile_status`. Workspace introspection only —
 * it reads the profiles directory and the live session registry, and never
 * touches a page or launches a browser.
 */

const DESCRIPTION =
  "Inventory the managed profile directories under `<workspace>/profiles/` (plus the default session's `<workspace>/profile`). Answers *which profiles exist, how big they are, when they were last written, and which are open right now* — the fields you need to pick a profile and to garbage-collect abandoned ones. Read-only; opens nothing.\n\n" +
  "Per profile: `{name, path, bytes, files, modifiedAt}`, plus `live` when a session is currently running out of it and `savedAuthState` when a same-named `auth_save` slot exists. `scanTruncated:true` means the directory walk hit its entry budget, so `bytes`/`files`/`modifiedAt` are lower bounds for that row.\n\n" +
  "WHAT THE ORIGIN DATA IS AND IS NOT. This tool does NOT report whether a profile is logged in anywhere. Chromium encrypts its cookie values with an OS key (Keychain / DPAPI), so a closed profile's authentication state is unreadable without launching the browser. Two clearly-labelled substitutes:\n" +
  "  - `live.cookieDomains` — domains the OPEN browser context holds cookies for at the instant of this call. A domain here means cookies exist, NOT that any of them still authenticate.\n" +
  "  - `savedAuthState` — the contents of `<workspace>/.auth-states/<name>.json` as of `savedAt`. browxai does not record which profile a slot was captured from: the link is the MATCHING NAME ONLY. Its `cookieDomains` / `originsWithLocalStorage` were true when the slot was saved and may be long expired.\n" +
  "For a closed profile, `modifiedAt` is the honest staleness signal. To learn a profile's real auth state, open a session on it and navigate.";

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
        const cookies = await entry.session.page().context().cookies();
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
