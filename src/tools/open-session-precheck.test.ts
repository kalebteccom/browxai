import { describe, it, expect } from "vitest";
import { openSessionPrecheck } from "./open-session-precheck.js";

describe("openSessionPrecheck", () => {
  it("passes a plain new session id, with or without a profile", () => {
    expect(openSessionPrecheck(false, "agent-a", undefined)).toBeNull();
    expect(openSessionPrecheck(false, "agent-a", "work")).toBeNull();
  });

  it("refuses a session id or profile that is not one plain name", () => {
    expect(openSessionPrecheck(false, "../x", undefined)).toMatchObject({
      ok: false,
      code: "invalid-name",
    });
    expect(openSessionPrecheck(false, "ok", "a/b")).toMatchObject({
      ok: false,
      code: "invalid-name",
    });
  });

  it("refuses a session id that is already open", () => {
    expect(openSessionPrecheck(true, "agent-a", undefined)).toEqual({
      ok: false,
      error:
        'session "agent-a" is already open. Close it with close_session, or pick another name.',
    });
  });
});
