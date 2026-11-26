// Which requests a canned response may answer.
//
// `route`, `route_queue` and `sw_intercept_fetch` hand the page a body the
// caller wrote. A page reads a data response and runs a document, script or
// worker response, and running caller-written script is what the `eval`
// capability is for. So a canned response answers the data and static resource
// types below, and every other type goes to the real network unless the server
// has `eval` enabled.
//
// The check is on the REQUEST's resource type. The response's content type does
// not settle it: a classic `<script src>` runs a response typed
// `application/json` when the server sends no `nosniff` header. The content-type
// check here is the earlier, coarser one, so a caller who asks for an HTML or
// JavaScript response learns at install time that it needs `eval`.
//
// Plain data: no engine handle and no playwright-core import, so the tool layer
// and both interception adapters read one copy.

/** `"data"`: only the resource types in `DATA_RESOURCE_TYPES` are answered.
 *  `"all"`: every matching request is answered (the server has `eval`). */
export type FulfilScope = "data" | "all";

/** Resource types whose response the page reads and does not run. Lower-case,
 *  which is Playwright's `request.resourceType()` spelling; a CDP
 *  `Network.ResourceType` (`XHR`, `EventSource`, `TextTrack`) matches after
 *  lower-casing. An allowlist, so a type a future browser adds goes to the
 *  network until it is listed here. */
export const DATA_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "xhr",
  "fetch",
  "eventsource",
  "image",
  "media",
  "font",
  "stylesheet",
  "texttrack",
  "manifest",
]);

/** True when a canned response may answer a request of this resource type on a
 *  server without `eval`. An absent type is not answered. */
export function isDataResourceType(resourceType: string | undefined): boolean {
  return resourceType !== undefined && DATA_RESOURCE_TYPES.has(resourceType.toLowerCase());
}

const MARKUP_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
]);

// Every JavaScript MIME type a browser accepts for a script: `text/javascript`,
// `application/javascript`, the `x-` forms, `ecmascript`, `jscript`,
// `livescript`, and the versioned `text/javascript1.N`.
const SCRIPT_CONTENT_TYPE =
  /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript|jscript|livescript)/;

/** True when `contentType` names a document or script type: HTML, XHTML, SVG or
 *  any JavaScript type. Parameters (`; charset=utf-8`), case and surrounding
 *  whitespace are ignored. */
export function isExecutableContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  const essence = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return MARKUP_CONTENT_TYPES.has(essence) || SCRIPT_CONTENT_TYPE.test(essence);
}

/** The `reason` a capability refusal carries when a canned response was asked
 *  for with a document or script content type. */
export function executableContentTypeReason(contentType: string): string {
  return (
    `a canned response with content type "${contentType}" is a document or script the page would run, ` +
    "which needs the `eval` capability. Without it, canned responses answer data and static " +
    `requests only (${[...DATA_RESOURCE_TYPES].join(", ")}).`
  );
}
