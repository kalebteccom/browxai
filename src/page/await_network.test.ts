import { describe, it, expect } from "vitest";
import { matchesResponse } from "./await_network.js";

const resp = { url: "https://api.example.com/v1/records?id=4", method: "POST", status: 201 };

describe("matchesResponse", () => {
  it("matches a case-insensitive URL substring", () => {
    expect(matchesResponse(resp, { urlPattern: "/v1/records" })).toBe(true);
    expect(matchesResponse(resp, { urlPattern: "/V1/RECORDS" })).toBe(true);
    expect(matchesResponse(resp, { urlPattern: "/other" })).toBe(false);
  });

  it("matches method case-insensitively", () => {
    expect(matchesResponse(resp, { method: "post" })).toBe(true);
    expect(matchesResponse(resp, { method: "GET" })).toBe(false);
  });

  it("matches an exact status", () => {
    expect(matchesResponse(resp, { status: 201 })).toBe(true);
    expect(matchesResponse(resp, { status: 200 })).toBe(false);
  });

  it("ANDs all provided fields", () => {
    expect(matchesResponse(resp, { urlPattern: "records", method: "POST", status: 201 })).toBe(true);
    expect(matchesResponse(resp, { urlPattern: "records", method: "POST", status: 500 })).toBe(false);
  });

  it("an empty match matches nothing (refuses to wait for anything)", () => {
    expect(matchesResponse(resp, {})).toBe(false);
  });
});
