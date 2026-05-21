// act_and_wait_for_network matcher.
//
// `ActionResult.network` only sees requests inside the action window; async
// SPAs fire follow-up requests after it. This lets a caller drive an action
// and wait for a *specific* request to complete, with a precise match.

export interface NetworkMatch {
  /** case-insensitive substring of the request URL. */
  urlPattern?: string;
  /** exact HTTP method (case-insensitive). */
  method?: string;
  /** exact response status. */
  status?: number;
}

export interface ResponseLike {
  url: string;
  method: string;
  status: number;
}

/** Pure predicate — does this response satisfy the match? An empty match
 *  matches nothing (refuse to "wait for anything"). Exported for tests. */
export function matchesResponse(resp: ResponseLike, match: NetworkMatch): boolean {
  if (match.urlPattern === undefined && match.method === undefined && match.status === undefined) {
    return false;
  }
  if (match.urlPattern !== undefined &&
      !resp.url.toLowerCase().includes(match.urlPattern.toLowerCase())) {
    return false;
  }
  if (match.method !== undefined &&
      resp.method.toUpperCase() !== match.method.toUpperCase()) {
    return false;
  }
  if (match.status !== undefined && resp.status !== match.status) {
    return false;
  }
  return true;
}
