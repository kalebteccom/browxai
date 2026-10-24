// The checks `open_session` makes before it launches anything. Split out of
// the lifecycle tools so the handler stays a short sequence.

import { invalidNameRefusal, isValidProfileName } from "../util/profile-name.js";

/** The body of an `open_session` refusal. */
export interface OpenSessionRefusal {
  ok: false;
  code?: "invalid-name";
  error: string;
}

/** The refusal `open_session` returns before launching anything, or null: a
 *  session id or profile that is not one plain name (checked here as well as in
 *  the schema, because in-process SDK callers skip the MCP schema parse), or a
 *  session id that is already open. */
export function openSessionPrecheck(
  isOpen: boolean,
  session: string,
  profile: string | undefined,
): OpenSessionRefusal | null {
  const badName = !isValidProfileName(session)
    ? invalidNameRefusal("session id", session)
    : profile !== undefined && !isValidProfileName(profile)
      ? invalidNameRefusal("profile", profile)
      : null;
  if (badName) return { ok: false, code: "invalid-name", error: badName };
  if (isOpen) return { ok: false, error: `session "${session}" already open; close_session first` };
  return null;
}
