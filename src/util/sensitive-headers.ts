/** Request and response headers dropped from anything written to disk by default:
 *  the replay artifact's redactor and the HAR scrubber both start from this list.
 *  Lower-case; callers compare case-insensitively. */
export const DEFAULT_DROPPED_HEADERS: readonly string[] = ["authorization", "cookie", "set-cookie"];
