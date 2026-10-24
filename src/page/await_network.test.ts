import { describe, it, expect } from "vitest";
import { matchesResponse } from "./await_network.js";

const resp = { url: "https://api.example.com/v1/records?id=4", method: "POST", status: 201 };

describe("matchesResponse", () => {
  it.each([
    { name: "a URL substring in another case", match: { urlPattern: "/V1/RECORDS" }, want: true },
    { name: "a URL substring that is absent", match: { urlPattern: "/other" }, want: false },
    { name: "method case-insensitively", match: { method: "post" }, want: true },
    { name: "a different method", match: { method: "GET" }, want: false },
    { name: "an exact status", match: { status: 201 }, want: true },
    { name: "a different status", match: { status: 200 }, want: false },
    {
      name: "an empty match matches nothing (refuses to wait for anything)",
      match: {},
      want: false,
    },
  ])("matchesResponse matches $name", ({ match, want }) => {
    expect(matchesResponse(resp, match)).toBe(want);
  });
});
