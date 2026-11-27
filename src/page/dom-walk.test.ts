import { describe, expect, it } from "vitest";
import type { CDPSession } from "playwright-core";
import { textCutFor } from "../util/frame-cap.js";
import { SecretRegistry } from "../util/secrets.js";
import { runDomWalk, runDomWalkViaExecute, type DomWalkEntry } from "./dom-walk.js";

const VALUE = "tok_" + "0123456789".repeat(30); // 304 characters, longer than the cap
const FULL_NAME = VALUE + " and more";

function entry(name: string): DomWalkEntry {
  return {
    role: "textbox",
    name,
    tag: "input",
    structuralPath: "body/input[1]",
    cssPath: "body > input:nth-child(1)",
  } as DomWalkEntry;
}

/** A page whose input value is `FULL_NAME`: the walk reads as many characters
 *  of it as the script's last argument says. */
function cdpReading(): { cdp: CDPSession; reads: number[] } {
  const reads: number[] = [];
  const cdp = {
    send: async (_m: string, params: { expression: string }) => {
      const read = Number(/, (\d+)\)$/.exec(params.expression)![1]);
      reads.push(read);
      return { result: { value: [entry(FULL_NAME.slice(0, read))] } };
    },
  } as unknown as CDPSession;
  return { cdp, reads };
}

describe("DOM-walk names over the 120-character cap", () => {
  it("reads one character past the cap and cuts as before with no secret registered", async () => {
    const { cdp, reads } = cdpReading();
    const [e] = await runDomWalk(cdp, {});
    expect(reads).toEqual([121]);
    expect(e!.name).toBe(FULL_NAME.slice(0, 120));
  });

  it("reads past the cap by the mask slack and masks before cutting", async () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: VALUE });
    const cut = textCutFor(secrets);
    const { cdp, reads } = cdpReading();
    const [e] = await runDomWalk(cdp, { textCut: cut });
    expect(reads).toEqual([121 + cut.slack]);
    expect(e!.name).toBe("<TOKEN> and more");
  });

  it("passes the read length to the WebDriver walk too", async () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: VALUE });
    const cut = textCutFor(secrets);
    const args: unknown[][] = [];
    const out = await runDomWalkViaExecute(
      async (_body, a) => {
        args.push(a);
        return [entry(FULL_NAME.slice(0, a[3] as number))];
      },
      { textCut: cut },
    );
    expect(args[0]![3]).toBe(121 + cut.slack);
    expect(out[0]!.name).not.toContain("tok_");
  });
});
