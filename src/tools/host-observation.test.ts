import { describe, expect, it } from "vitest";
import { buildObservation } from "./host-observation.js";
import type { SessionRegistry } from "../session/registry.js";
import type { DiagnosticsRecord, DiagnosticsRecorder } from "../util/diagnostics.js";
import { SecretRegistry } from "../util/secrets.js";
import type { ToolResponse } from "./host.js";

const VALUE = "hunter2-refused-value";

function harness(secrets: SecretRegistry | null) {
  const written: DiagnosticsRecord[] = [];
  const diagnostics = {
    enabled: true,
    write: (r: DiagnosticsRecord) => written.push(r),
    noteDenial: () => undefined,
    denialsCount: () => 0,
  } as unknown as DiagnosticsRecorder;
  const registry = {
    peek: () => (secrets ? { secrets } : undefined),
  } as unknown as SessionRegistry;
  return { written, obs: buildObservation({ registry, diagnostics }) };
}

const refused: ToolResponse = {
  content: [{ type: "text", text: JSON.stringify({ ok: false, error: "refused" }) }],
};

describe("noteDiagnostics argument recording", () => {
  it("never records a register_secret value the registry refused", () => {
    const { written, obs } = harness(new SecretRegistry());
    obs.noteDiagnostics("register_secret", { name: "PW", value: VALUE }, refused, Date.now());
    expect(written).toHaveLength(1);
    const json = JSON.stringify(written[0]);
    expect(json).not.toContain(VALUE);
    expect(json).toContain('"name":"PW"');
  });

  it("drops a secret value in a nested action call", () => {
    const { written, obs } = harness(null);
    const args = { action: { tool: "cookies_set", args: { name: "sid", value: VALUE } } };
    obs.noteDiagnostics("act_and_diff", args, refused, Date.now());
    expect(JSON.stringify(written[0])).not.toContain(VALUE);
  });

  it("still masks a registered value echoed in another tool's args", () => {
    const secrets = new SecretRegistry();
    secrets.register({ name: "PW", value: VALUE });
    const { written, obs } = harness(secrets);
    obs.noteDiagnostics("fill", { target: "#pw", text: VALUE }, refused, Date.now());
    const json = JSON.stringify(written[0]);
    expect(json).not.toContain(VALUE);
    expect(json).toContain("<PW>");
  });
});
