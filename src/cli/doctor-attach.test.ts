// `browxai doctor` byob-attach warning — env set/unset x capability on/off.

import { describe, expect, it } from "vitest";
import { attachCapabilityCheck, cdpAttachRow } from "./doctor-attach.js";
import { formatDoctor } from "./doctor-summary.js";
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

  it("is silent when byob-attach is enabled", () => {
    expect(attachCapabilityCheck("http://127.0.0.1:9222", WITH_ATTACH)).toBeNull();
  });

  it("is silent when BROWX_ATTACH_CDP is unset or blank", () => {
    expect(attachCapabilityCheck(undefined, DEFAULTS)).toBeNull();
    expect(attachCapabilityCheck("  ", DEFAULTS)).toBeNull();
  });
});

describe("cdpAttachRow", () => {
  const URL_WITH_TOKEN = "wss://user:s3cret@cdp.example.com/devtools/browser?token=t0ken#frag";

  it("prints the attach URL without its userinfo, query or fragment", () => {
    const up = cdpAttachRow(URL_WITH_TOKEN, { ok: true, version: "Chrome/140" });
    const down = cdpAttachRow(URL_WITH_TOKEN, {
      ok: false,
      error: `fetch ${URL_WITH_TOKEN} failed`,
    });
    for (const row of [up, down]) {
      expect(row.detail).toContain("cdp.example.com");
      expect(row.detail).not.toContain("s3cret");
      expect(row.detail).not.toContain("t0ken");
      expect(row.detail).not.toContain("user:");
    }
    expect(down.ok).toBe(false);
  });

  it("keeps the token out of the short summary and --verbose", () => {
    const row = cdpAttachRow(URL_WITH_TOKEN, { ok: false, error: "ECONNREFUSED" });
    for (const verbose of [false, true]) {
      const { text } = formatDoctor([row], { verbose, version: "0" });
      expect(text).toContain("cdp.example.com");
      expect(text).not.toContain("s3cret");
      expect(text).not.toContain("t0ken");
    }
  });
});
