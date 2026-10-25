import { describe, expect, it } from "vitest";
import { withInstallHint } from "./missing-browser-hint.js";

const BANNER =
  "browserType.launch: Executable doesn't exist at /x/firefox\n  npx playwright install";

describe("withInstallHint", () => {
  it("keeps the banner and adds the pinned install command", () => {
    const out = withInstallHint("firefox", new Error(BANNER)) as Error;
    expect(out.message.startsWith(BANNER)).toBe(true);
    expect(out.message).toMatch(
      /\nbrowxai: firefox is not downloaded\. Run `npx playwright-core(@[\d.]+)? install firefox`\.$/,
    );
  });

  it("names the engine it was given", () => {
    const out = withInstallHint("webkit", new Error(BANNER)) as Error;
    expect(out.message).toContain("install webkit");
  });

  it("passes any other error through unchanged", () => {
    const err = new Error("something else");
    expect(withInstallHint("firefox", err)).toBe(err);
    expect(withInstallHint("firefox", "text")).toBe("text");
  });
  it("leaves a non-Error that names the missing executable alone", () => {
    const like = { message: "Executable doesn't exist at /x" };
    expect(withInstallHint("firefox", like)).toBe(like);
  });

  it("keeps the original error as the cause", () => {
    const err = new Error(BANNER);
    expect((withInstallHint("firefox", err) as Error).cause).toBe(err);
  });
});
