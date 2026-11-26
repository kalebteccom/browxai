import { describe, it, expect } from "vitest";
import { ENCODED_FORM_MIN_LENGTH, MAX_FORMS_PER_SECRET, secretForms } from "./secret-forms.js";

/** The forms a value had before JSON and HTML escapes were added: itself, its
 *  two percent-encodings and its base64 spellings. */
function baseForms(value: string): string[] {
  const bytes = Buffer.from(value, "utf8");
  const base64 = bytes.toString("base64");
  return [
    ...new Set([
      value,
      encodeURIComponent(value),
      new URLSearchParams([["", value]]).toString().slice(1),
      base64,
      bytes.toString("base64url"),
      base64.replace(/=+$/, ""),
    ]),
  ];
}

describe("secretForms: values that no JSON or HTML escape rewrites", () => {
  it.each<[string, string]>([
    ["letters and digits", "Abc123xyz"],
    ["a token with dashes, dots and underscores", "tok-xyz_123.abc"],
    ["characters only percent-encoding rewrites", "a b+c=d!~*()"],
  ])("%s: adds no escaped form", (_label, value) => {
    const forms = secretForms(value);
    expect(forms).toEqual(baseForms(value));
    expect(forms).toHaveLength(baseForms(value).length);
  });

  it("letters and digits keep exactly two forms, the value and its base64", () => {
    expect(secretForms("Abc123xyz")).toEqual([
      "Abc123xyz",
      Buffer.from("Abc123xyz").toString("base64"),
    ]);
  });
});

describe("secretForms: the minimum length", () => {
  it("a value under the minimum has one form even when escapes would rewrite it", () => {
    const short = 'a"b&c';
    expect(short.length).toBeLessThan(ENCODED_FORM_MIN_LENGTH);
    expect(secretForms(short)).toEqual([short]);
  });

  it("a value at the minimum gets its escaped forms", () => {
    const atMin = 'a"b&cd';
    expect(atMin).toHaveLength(ENCODED_FORM_MIN_LENGTH);
    expect(secretForms(atMin)).toContain("a&quot;b&amp;cd");
    expect(secretForms(atMin)).toContain('a\\"b&cd');
  });
});

describe("secretForms: escaped renderings", () => {
  // [label, value, renderings that must be among the forms]
  it.each<[string, string, string[]]>([
    [
      "a quote and a backslash",
      'pa"ss\\1x',
      ['pa\\"ss\\\\1x', "pa&quot;ss\\1x", "pa&#34;ss\\1x", "pa&#x22;ss\\1x"],
    ],
    ["a slash", "ab/cd+ef==", ["ab\\/cd+ef=="]],
    [
      "an ampersand",
      "tom&jerry",
      ["tom\\u0026jerry", "tom&amp;jerry", "tom&#38;jerry", "tom&#x26;jerry"],
    ],
    [
      "angle brackets",
      "x<y>z123",
      [
        "x\\u003cy\\u003ez123",
        "x\\u003Cy\\u003Ez123",
        "x&lt;y&gt;z123",
        "x&#60;y&#62;z123",
        "x&#x3c;y&#x3e;z123",
        "x&#x3C;y&#x3E;z123",
      ],
    ],
    [
      "an apostrophe",
      "it's-a-key",
      [
        "it\\u0027s-a-key",
        "it&#39;s-a-key",
        "it&#x27;s-a-key",
        "it&#039;s-a-key",
        "it&apos;s-a-key",
      ],
    ],
    [
      "a non-ASCII letter",
      "contraseña",
      [
        "contrase\\u00f1a",
        "contrase\\u00F1a",
        "contrase&#241;a",
        "contrase&#xf1;a",
        "contrase&#xF1;a",
      ],
    ],
    [
      "a character outside the BMP",
      "key\u{1f600}value",
      ["key\\ud83d\\ude00value", "key&#128512;value", "key&#x1f600;value", "key&#x1F600;value"],
    ],
    [
      "a slash next to a non-ASCII letter",
      "niño/2024",
      ["niño\\/2024", "ni\\u00f1o/2024", "ni\\u00f1o\\/2024"],
    ],
    [
      "every HTML-sensitive character at once",
      "a&b\"c<d>e'f",
      [
        // a text node: quotes stay as typed
        "a&amp;b\"c&lt;d&gt;e'f",
        // an attribute value: angle brackets stay as typed
        "a&amp;b&quot;c<d>e'f",
        "a&amp;b&quot;c&lt;d&gt;e'f",
        "a&amp;b&quot;c&lt;d&gt;e&#39;f",
        "a&amp;b&quot;c&lt;d&gt;e&#x27;f",
        "a&amp;b&quot;c&lt;d&gt;e&#039;f",
        "a&amp;b&quot;c&lt;d&gt;e&apos;f",
        "a&#38;b&#34;c&#60;d&#62;e&#39;f",
        'a\\u0026b\\"c\\u003cd\\u003ee\\u0027f',
      ],
    ],
  ])("%s", (_label, value, renderings) => {
    const forms = secretForms(value);
    for (const rendering of renderings) expect(forms).toContain(rendering);
    // The forms a value already had are all still there, and come first.
    expect(forms.slice(0, baseForms(value).length)).toEqual(baseForms(value));
  });
});

describe("secretForms: how many forms a value gets", () => {
  it.each<[string, string, number]>([
    // JSON: `\/`.
    ["a slash adds one", "ab/cd+ef==", 1],
    // JSON: `&`. HTML: `&amp;`, `&#38;`, `&#x26;`.
    ["an ampersand adds four", "tom&jerry", 4],
    // JSON: `ñ`, `ñ`. HTML: `&#241;`, `&#xf1;`, `&#xF1;`.
    ["a non-ASCII letter adds five", "contraseña", 5],
  ])("%s", (_label, value, extra) => {
    expect(secretForms(value)).toHaveLength(baseForms(value).length + extra);
  });

  it("has no duplicates", () => {
    const forms = secretForms("a&b\"c<d>e'f/ñ\\");
    expect(new Set(forms).size).toBe(forms.length);
  });

  it("stays within the cap for a value every escape rewrites", () => {
    const value = "a&b\"c<d>e'f/ñ\\";
    const forms = secretForms(value);
    expect(MAX_FORMS_PER_SECRET).toBe(24);
    expect(forms.length).toBeLessThanOrEqual(MAX_FORMS_PER_SECRET);
    // 8 JSON-escaped and 10 HTML-escaped forms, all distinct for this value.
    expect(forms).toHaveLength(baseForms(value).length + 18);
    expect(forms[0]).toBe(value);
  });
});
