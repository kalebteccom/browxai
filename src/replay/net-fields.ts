// What a `net/request` and a `net/response` event keep from the CDP event they
// are built from. Each payload is assembled from the field lists below, so a
// field CDP adds later is left out until it is listed here. Everything else on
// the CDP event is dropped: the raw header text blocks (`requestHeadersText`,
// `headersText`), `response.requestHeaders`, the initiator stack, security
// details and timing.
//
// Three kinds of field:
//   - The listed scalars are copied as they are, and only when they hold a
//     string, a number or a boolean.
//   - A URL goes through `sanitizeUrl`, the helper `network_read` and `doctor`
//     use: no query string, no fragment, no userinfo, id-like path segments
//     patternised.
//   - Headers and bodies go through the redactor's header and payload rules.
// The registered-secret mask then runs over the assembled event.

import { sanitizeUrl } from "../util/url-sanitizer.js";
import type { Redactor } from "./redact.js";
import type { CaptureTier, MaybeRedacted } from "./schema.js";

type Rec = Readonly<Record<string, unknown>>;
type Scalar = string | number | boolean;

/** Scalars kept from `Network.requestWillBeSent`. */
export const NET_REQUEST_FIELDS = [
  "requestId",
  "loaderId",
  "frameId",
  "type",
  "timestamp",
  "wallTime",
  "hasUserGesture",
] as const;

/** Scalars kept from its `request`. */
export const REQUEST_FIELDS = [
  "method",
  "hasPostData",
  "initialPriority",
  "referrerPolicy",
] as const;

/** Scalars kept from `Network.responseReceived`. */
export const NET_RESPONSE_FIELDS = [
  "requestId",
  "loaderId",
  "frameId",
  "type",
  "timestamp",
  "encodedDataLength",
] as const;

/** Scalars kept from its `response`, and from a request's `redirectResponse`. */
export const RESPONSE_FIELDS = [
  "status",
  "statusText",
  "mimeType",
  "charset",
  "protocol",
  "remoteIPAddress",
  "remotePort",
  "fromDiskCache",
  "fromServiceWorker",
  "fromPrefetchCache",
  "encodedDataLength",
] as const;

type Picked<K extends string> = { [P in K]?: Scalar };

export interface PostDataEntry {
  /** Base64 of the masked text. Absent when the bytes were not UTF-8 text. */
  bytes?: MaybeRedacted<string>;
}

export type RequestShape = Picked<(typeof REQUEST_FIELDS)[number]> & {
  url?: string;
  headers?: Record<string, MaybeRedacted<string>>;
  postData?: MaybeRedacted<string>;
  /** Present only at the re-executable tier. */
  postDataEntries?: PostDataEntry[];
};

export type ResponseShape = Picked<(typeof RESPONSE_FIELDS)[number]> & {
  url?: string;
  headers?: Record<string, MaybeRedacted<string>>;
};

export type NetRequestPayload = Picked<(typeof NET_REQUEST_FIELDS)[number]> & {
  documentURL?: string;
  request: RequestShape;
  redirectResponse?: ResponseShape;
};

export type NetResponsePayload = Picked<(typeof NET_RESPONSE_FIELDS)[number]> & {
  response: ResponseShape;
  /** Present only at the re-executable tier, where bodies are captured. */
  body?: MaybeRedacted<string>;
};

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pick<K extends string>(src: Rec, fields: readonly K[]): Picked<K> {
  const out: Partial<Record<string, Scalar>> = {};
  for (const field of fields) {
    const v = src[field];
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[field] = v;
  }
  return out as Picked<K>;
}

function urlOf(v: unknown): string | undefined {
  return typeof v === "string" ? sanitizeUrl(v) : undefined;
}

/** Header values that are strings. CDP sends strings; anything else is left out. */
function headersOf(
  v: unknown,
  redact: Redactor,
): Record<string, MaybeRedacted<string>> | undefined {
  if (!isRec(v)) return undefined;
  const strings: Record<string, string> = {};
  for (const [name, value] of Object.entries(v)) {
    if (typeof value === "string") strings[name] = value;
  }
  return redact.headers(strings);
}

/**
 * Mask the request body CDP sends as base64 parts. The registry mask reads
 * text, and the base64 of a whole body does not contain the base64 of a value
 * inside it, so each part is decoded, masked as text and encoded again. A part
 * that is not UTF-8 text is recorded without its bytes. A part whose `bytes`
 * is not a string (a marker from an earlier pass) is kept as it is.
 */
export function maskPostDataEntries(
  entries: unknown,
  maskText: (text: string) => MaybeRedacted<string>,
): PostDataEntry[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  const list: unknown[] = entries;
  return list.map((entry): PostDataEntry => {
    const bytes = isRec(entry) ? entry.bytes : undefined;
    if (bytes === undefined) return {};
    if (typeof bytes !== "string") return { bytes: bytes as MaybeRedacted<string> };
    const raw = Buffer.from(bytes, "base64");
    const text = raw.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(raw)) return {};
    const masked = maskText(text);
    return {
      bytes: typeof masked === "string" ? Buffer.from(masked, "utf8").toString("base64") : masked,
    };
  });
}

function requestShape(request: Rec, redact: Redactor, tier: CaptureTier | undefined): RequestShape {
  const out: RequestShape = pick(request, REQUEST_FIELDS);
  const url = urlOf(request.url);
  if (url !== undefined) out.url = url;
  const headers = headersOf(request.headers, redact);
  if (headers) out.headers = headers;
  if (typeof request.postData === "string") out.postData = redact.payload(request.postData);
  // The base64 parts repeat the request body, so they follow the body tier.
  if (tier === "reexecutable") {
    const entries = maskPostDataEntries(request.postDataEntries, (text) => redact.payload(text));
    if (entries) out.postDataEntries = entries;
  }
  return out;
}

function responseShape(response: Rec, redact: Redactor): ResponseShape {
  const out: ResponseShape = pick(response, RESPONSE_FIELDS);
  const url = urlOf(response.url);
  if (url !== undefined) out.url = url;
  const headers = headersOf(response.headers, redact);
  if (headers) out.headers = headers;
  return out;
}

export function netRequestPayload(
  raw: Rec,
  redact: Redactor,
  tier: CaptureTier | undefined,
): NetRequestPayload {
  const out: NetRequestPayload = {
    ...pick(raw, NET_REQUEST_FIELDS),
    request: requestShape(isRec(raw.request) ? raw.request : {}, redact, tier),
  };
  const documentURL = urlOf(raw.documentURL);
  if (documentURL !== undefined) out.documentURL = documentURL;
  if (isRec(raw.redirectResponse)) {
    out.redirectResponse = responseShape(raw.redirectResponse, redact);
  }
  return out;
}

export function netResponsePayload(
  raw: Rec,
  redact: Redactor,
  body: string | undefined,
): NetResponsePayload {
  const out: NetResponsePayload = {
    ...pick(raw, NET_RESPONSE_FIELDS),
    response: responseShape(isRec(raw.response) ? raw.response : {}, redact),
  };
  if (body !== undefined) out.body = redact.payload(body);
  return out;
}
