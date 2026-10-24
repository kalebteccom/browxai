// `browxai doctor` byob-attach warning — env set/unset x capability on/off.

import { describe, expect, it } from "vitest";
import { attachCapabilityCheck } from "./doctor-attach.js";
import { DEFAULT_CAPABILITIES, type Capability } from "../util/capabilities.js";

const DEFAULTS: ReadonlySet<Capability> = new Set(DEFAULT_CAPABILITIES);
const WITH_ATTACH: ReadonlySet<Capability> = new Set([...DEFAULT_CAPABILITIES, "byob-attach"]);

describe("attachCapabilityCheck", () => {
  it("warns, without failing, when BROWX_ATTACH_CDP is set and byob-attach is off", () => {
    const row = attachCapabilityCheck("http://127.0.0.1:9222", DEFAULTS);
    expect(row).not.toBeNull();
    expect(row!.ok).toBe(true);
    expect(row!.warn).toBe(true);
    expect(row!.info).toBeUndefined();
    expect(row!.fix).toContain("BROWX_CAPABILITIES=read,navigation,action,human,byob-attach");
  });

  it.each([
    { label: "byob-attach is enabled", cdp: "http://127.0.0.1:9222", caps: WITH_ATTACH },
    { label: "BROWX_ATTACH_CDP is unset", cdp: undefined, caps: DEFAULTS },
    { label: "BROWX_ATTACH_CDP is blank", cdp: "  ", caps: DEFAULTS },
  ])("is silent when $label", ({ cdp, caps }) => {
    expect(attachCapabilityCheck(cdp, caps)).toBeNull();
  });
});
