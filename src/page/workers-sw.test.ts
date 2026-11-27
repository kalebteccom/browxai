import { describe, expect, it } from "vitest";
import { PLAIN_CUT, textCutFor } from "../util/frame-cap.js";
import { SecretRegistry } from "../util/secrets.js";
import { WorkersSwChannel } from "./workers-sw.js";

describe("WorkersSwChannel.recordSwMessage", () => {
  it("masks a value that crosses the 4,000-character cut before cutting", () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: "tok_0123456789abcdef" });
    const sw = new WorkersSwChannel();
    sw.recordSwMessage(
      "sw-1",
      "a".repeat(3995) + "tok_0123456789abcdef" + "b".repeat(50),
      1,
      textCutFor(secrets),
    );
    const [m] = sw.drainMessages("sw-1");
    expect(m!.data).not.toContain("tok_");
    expect(m!.data).toBe("a".repeat(3995) + "<TOKE…");
  });

  it("cuts as before with no secret registered", () => {
    const sw = new WorkersSwChannel();
    sw.recordSwMessage("sw-1", "a".repeat(4001), 1, PLAIN_CUT);
    sw.recordSwMessage("sw-1", "short", 2);
    expect(sw.drainMessages("sw-1").map((m) => m.data)).toEqual(["a".repeat(4000) + "…", "short"]);
  });
});
