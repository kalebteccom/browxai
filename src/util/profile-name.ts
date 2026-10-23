// The one rule for a name that becomes a directory under the workspace: a browser
// profile name (`open_session({profile})`, `browxai chrome --profile`,
// `profile_snapshot` / `profile_restore`) and a session id (which names the
// session's `.downloads/<id>` and `.artifacts/<id>` directories). A valid name is
// one plain path segment, so it always lands directly under its parent directory.

/** Longest accepted name. Well under the 255-byte filename limit, leaving room
 *  for the files a browser writes inside a profile. */
export const MAX_PROFILE_NAME_LENGTH = 128;

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `name` is one plain directory name: letters, digits, `.`, `_`, `-`,
 *  starting with a letter or digit, no `..`, at most 128 characters. */
export function isValidProfileName(name: string): boolean {
  return name.length <= MAX_PROFILE_NAME_LENGTH && PLAIN_NAME.test(name) && !name.includes("..");
}

/** How to write a valid name, for refusal messages and schema errors. */
export const PROFILE_NAME_RULE =
  `use a plain name: letters, digits, '.', '_' and '-', starting with a letter or digit, ` +
  `at most ${MAX_PROFILE_NAME_LENGTH} characters, no path separators and no ".."`;

/** The `invalid-name` refusal for a `kind` ("profile", "session id", …) named
 *  `name`. The name is quoted with JSON escaping and cut short, so a NUL byte or
 *  a very long value cannot garble the message. */
export function invalidNameRefusal(kind: string, name: string): string {
  const shown = name.length > 64 ? `${name.slice(0, 64)}…` : name;
  return `invalid-name: ${kind} ${JSON.stringify(shown)} is not a plain name; ${PROFILE_NAME_RULE}.`;
}

/** Throws the `invalid-name` refusal unless `name` is a valid profile name. */
export function assertValidProfileName(kind: string, name: string): void {
  if (!isValidProfileName(name)) throw new Error(invalidNameRefusal(kind, name));
}
