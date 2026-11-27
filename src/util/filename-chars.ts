// Characters Windows refuses in a file name. A name that holds one fails to
// write on NTFS, and on a Windows-shared folder, whatever system wrote it.
const WINDOWS_ILLEGAL_CHARS = /[<>:"|?*]/g;

/** The on-disk form of a name: each of `<>:"|?*` becomes `_`. One character in,
 *  one out, so the length and the position of every other character hold. A
 *  masked name `<NAME>` becomes `_NAME_` on disk. Callers keep the original
 *  form for every value they return. */
export function toDiskName(name: string): string {
  return name.replace(WINDOWS_ILLEGAL_CHARS, "_");
}
