// The strings a registered secret value is masked in. `SecretRegistry` matches
// each form as a literal substring, so this module only decides which
// renderings of a value exist. It never scans text.
//
// A value reaches a sink as typed, or re-encoded by whatever wrote the text:
// percent-encoded in a URL, base64 in a header, JSON-escaped inside a string
// that itself holds JSON, HTML-escaped inside markup. Each encoder is modelled
// as one rendering of the whole value. A rendering that mixes two encoders
// (half the characters escaped one way, half another) is not in the list.

/** Shorter values are masked as typed only. Their encodings are short
 *  enough to turn up by chance in unrelated text. */
export const ENCODED_FORM_MIN_LENGTH = 6;

/** The most forms one value is masked in: 6 base forms, 8 JSON-escaped and
 *  10 HTML-escaped. The base forms come first, so the cap never drops one. */
export const MAX_FORMS_PER_SECRET = 24;

/** Every form `value` is masked in. A value under `ENCODED_FORM_MIN_LENGTH`
 *  has one form, itself. Duplicates collapse, so a value made of letters and
 *  digits keeps only the forms that differ from it (its base64 ones). */
export function secretForms(value: string): string[] {
  if (value.length < ENCODED_FORM_MIN_LENGTH) return [value];
  const forms = new Set(baseForms(value));
  if (changesUnderJsonEscapes(value)) for (const f of jsonEscapedForms(value)) forms.add(f);
  if (changesUnderHtmlEscapes(value)) for (const f of htmlEscapedForms(value)) forms.add(f);
  return [...forms].slice(0, MAX_FORMS_PER_SECRET);
}

/** The value, its percent-encoded forms and its base64 forms. */
function baseForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  const forms = [
    value,
    encodeURIComponent(value),
    // application/x-www-form-urlencoded, as URLSearchParams and HTML forms write it.
    new URLSearchParams([["", value]]).toString().slice(1),
    base64,
    bytes.toString("base64url"),
  ];
  // Unpadded base64 too, so a value whose padding was stripped is caught.
  if (base64.endsWith("=")) forms.push(base64.replace(/=+$/, ""));
  return forms;
}

const HTML_SENSITIVE = "<>&'";

/** True when a JSON encoder can write `value` differently from how it was
 *  typed: it holds a quote, a backslash, a slash, a control character, a
 *  character an HTML-safe JSON encoder escapes, or a non-ASCII character. */
function changesUnderJsonEscapes(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const ch = value[i]!;
    if (code < 0x20 || code >= 0x80) return true;
    if (ch === '"' || ch === "\\" || ch === "/" || HTML_SENSITIVE.includes(ch)) return true;
  }
  return false;
}

/** True when an HTML encoder can write `value` differently: it holds one of
 *  `& < > " '` or a non-ASCII character. */
function changesUnderHtmlEscapes(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (value.charCodeAt(i) >= 0x80 || ch === '"' || HTML_SENSITIVE.includes(ch)) return true;
  }
  return false;
}

/** Rewrite a string one UTF-16 code unit at a time. `fn` returns the
 *  replacement, or undefined to keep the unit. One pass, no regex. */
function mapUnits(s: string, fn: (unit: string, code: number) => string | undefined): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const unit = s[i]!;
    out += fn(unit, s.charCodeAt(i)) ?? unit;
  }
  return out;
}

function unicodeEscape(code: number, upper: boolean): string {
  const hex = code.toString(16).padStart(4, "0");
  return `\\u${upper ? hex.toUpperCase() : hex}`;
}

/** The value as it appears inside a JSON string literal, in the ways common
 *  encoders write one. Each helper runs on already-escaped text, which is safe
 *  because an escape sequence holds none of the characters a later helper
 *  rewrites. */
function jsonEscapedForms(value: string): string[] {
  // Quote, backslash and control characters, as `JSON.stringify` writes them.
  const plain = JSON.stringify(value).slice(1, -1);
  const withSlash = (s: string): string => mapUnits(s, (u) => (u === "/" ? "\\/" : undefined));
  const asciiOnly = (s: string, upper: boolean): string =>
    mapUnits(s, (_u, code) => (code >= 0x80 ? unicodeEscape(code, upper) : undefined));
  // `< > & '` as `<` and so on, which encoders that write JSON into a
  // script tag do.
  const htmlSafe = (s: string, upper: boolean): string =>
    mapUnits(s, (u, code) => (HTML_SENSITIVE.includes(u) ? unicodeEscape(code, upper) : undefined));
  const ascii = asciiOnly(plain, false);
  const asciiUpper = asciiOnly(plain, true);
  return [
    plain,
    withSlash(plain),
    ascii,
    withSlash(ascii),
    asciiUpper,
    htmlSafe(plain, false),
    htmlSafe(ascii, false),
    htmlSafe(asciiUpper, true),
  ];
}

type QuoteStyle = "raw" | "&#39;" | "&#x27;" | "&#039;" | "&apos;";

/** `& < > "` as named entities, `'` in the given style. `quot` false leaves a
 *  double quote as typed, which is how a text node is serialised. */
function namedEntities(value: string, quot: boolean, apos: QuoteStyle, angles: boolean): string {
  return mapUnits(value, (u) => {
    if (u === "&") return "&amp;";
    if (u === "<") return angles ? "&lt;" : undefined;
    if (u === ">") return angles ? "&gt;" : undefined;
    if (u === '"') return quot ? "&quot;" : undefined;
    if (u === "'") return apos === "raw" ? undefined : apos;
    return undefined;
  });
}

/** `& < > " '` and every non-ASCII character as numeric character references.
 *  Walks code points, so a character outside the BMP is one reference. */
function numericEntities(value: string, write: (codePoint: number) => string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    out += cp >= 0x80 || ch === '"' || HTML_SENSITIVE.includes(ch) ? write(cp) : ch;
  }
  return out;
}

/** The value as it appears in HTML: in a text node, in an attribute, as a
 *  server-side escaper writes it (four spellings of the apostrophe), and as
 *  decimal and hex numeric references. */
function htmlEscapedForms(value: string): string[] {
  return [
    namedEntities(value, false, "raw", true),
    namedEntities(value, true, "raw", false),
    namedEntities(value, true, "raw", true),
    namedEntities(value, true, "&#39;", true),
    namedEntities(value, true, "&#x27;", true),
    namedEntities(value, true, "&#039;", true),
    namedEntities(value, true, "&apos;", true),
    numericEntities(value, (cp) => `&#${cp};`),
    numericEntities(value, (cp) => `&#x${cp.toString(16)};`),
    numericEntities(value, (cp) => `&#x${cp.toString(16).toUpperCase()};`),
  ];
}
