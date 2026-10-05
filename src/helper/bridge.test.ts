import { describe, it, expect, vi } from "vitest";
import { BrowxBridge } from "./bridge.js";
import type { OperatorAsk, OperatorChannel } from "./operator-channel.js";

describe("BrowxBridge — detach state", () => {
  it("isDetached() is false until detach() runs", async () => {
    const b = new BrowxBridge();
    expect(b.isDetached()).toBe(false);
    await b.detach();
    expect(b.isDetached()).toBe(true);
  });

  it("awaitSignal() refuses at once when no page carries the human channel", async () => {
    // An unattached bridge stands in for an engine without CDP: there is no
    // isolated world to answer from, so a caller must not be left waiting.
    const b = new BrowxBridge();
    expect(b.humanChannelAvailable()).toBe(false);
    await expect(b.awaitSignal("respond", 0)).rejects.toThrow(/^no-human-channel:/);
  });

  it("awaitSignal() refuses after detach()", async () => {
    const b = new BrowxBridge();
    await b.detach();
    await expect(b.awaitSignal("proceed", 0)).rejects.toThrow(/no-human-channel/);
  });

  it("detach() is idempotent — second call is a no-op", async () => {
    const b = new BrowxBridge();
    await b.detach();
    await b.detach();
    expect(b.isDetached()).toBe(true);
  });
});

describe("BrowxBridge — operator channel", () => {
  const approval = {
    kind: "approval",
    scope: "byob_action",
    tool: "click",
    summary: "click on an attached browser",
  } as const;

  function withOperator(ask: OperatorChannel["ask"]) {
    return new BrowxBridge({
      operator: { ask, close: () => undefined },
      sessionId: "alpha",
      mask: <T>(v: T): T => v,
    });
  }

  it("counts as a human channel with no CDP page attached", async () => {
    const b = withOperator(async () => ({ decision: "approve" }));
    expect(b.humanChannelAvailable()).toBe(true);
    expect(b.usesOperatorChannel()).toBe(true);
    await b.detach();
    expect(b.humanChannelAvailable()).toBe(false);
  });

  it("maps approve and deny to the confirm signal the callers parse", async () => {
    const b = withOperator(async (req) => ({
      decision:
        req.prompt.kind === "approval" && req.prompt.scope === "byob_action" ? "approve" : "deny",
    }));
    await expect(b.awaitSignal("respond", 1_000, "t", approval)).resolves.toMatchObject({
      name: "respond",
      data: { kind: "confirm", value: true },
    });
    await expect(
      b.awaitSignal("respond", 1_000, "t", { ...approval, scope: "other" }),
    ).resolves.toMatchObject({ data: { kind: "confirm", value: false } });
  });

  it("maps human answers to the signal shapes await_human parses", async () => {
    const answers = [
      { decision: "done" as const },
      { decision: "done" as const, value: 2 },
      { decision: "done" as const, value: "typed" },
    ];
    const b = withOperator(async () => answers.shift()!);
    await expect(
      b.awaitSignal("proceed", 1_000, "t", {
        kind: "human",
        humanKind: "acknowledge",
        prompt: "p",
      }),
    ).resolves.toMatchObject({ name: "proceed", data: null });
    await expect(
      b.awaitSignal("respond", 1_000, "t", {
        kind: "human",
        humanKind: "choose",
        prompt: "p",
        choices: ["a", "b", "c"],
      }),
    ).resolves.toMatchObject({ name: "respond", data: { kind: "choose", value: 2 } });
    await expect(
      b.awaitSignal("respond", 1_000, "t", { kind: "human", humanKind: "input", prompt: "p" }),
    ).resolves.toMatchObject({ data: { kind: "input", value: "typed" } });
  });

  it("passes a grant through on the signal", async () => {
    const b = withOperator(async () => ({
      decision: "approve",
      grant: { scope: "session", ttlSeconds: 60 },
    }));
    const sig = await b.awaitSignal("respond", 1_000, "t", approval);
    expect(sig.grant).toEqual({ scope: "session", ttlSeconds: 60 });
  });

  it("rejects an operator abort", async () => {
    const b = withOperator(async () => ({ decision: "abort" }));
    await expect(b.awaitSignal("respond", 1_000, "t", approval)).rejects.toThrow(
      /operator-aborted/,
    );
  });

  it("refuses a prompt with no operator form instead of leaving it to DevTools", async () => {
    const ask = vi.fn();
    const b = withOperator(ask);
    await expect(b.awaitSignal("respond", 1_000, "t")).rejects.toThrow(/no operator form/);
    expect(ask).not.toHaveBeenCalled();
  });

  it("ignores a DevTools answer while a request is out", async () => {
    let release!: (a: { decision: "approve" | "deny" }) => void;
    const b = withOperator(() => new Promise((r) => (release = r)));
    const pending = b.awaitSignal("respond", 1_000, "abc123", approval);
    let settled = false;
    void pending.then(() => (settled = true));
    // The signal a DevTools console call would produce, with the right ticket.
    (b as unknown as { onSignal(s: unknown): void }).onSignal({
      name: "respond",
      data: { kind: "confirm", value: true },
      ticket: "abc123",
      ts: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    release({ decision: "deny" });
    await expect(pending).resolves.toMatchObject({ data: { value: false } });
  });

  it("sends the session id and a bounded timeout, never zero", async () => {
    const ask = vi.fn(async (_req: OperatorAsk) => ({ decision: "approve" as const }));
    const b = withOperator(ask);
    await b.awaitSignal("respond", 0, "t", approval);
    expect(ask.mock.calls[0]![0]).toMatchObject({ session: "alpha", timeoutMs: 300_000 });
  });

  it("aborts requests that are out when the bridge detaches", async () => {
    let signal: AbortSignal | undefined;
    const b = withOperator((_req, s) => {
      signal = s;
      return new Promise(() => undefined);
    });
    void b.awaitSignal("respond", 1_000, "t", approval).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    await b.detach();
    expect(signal?.aborted).toBe(true);
  });

  it("a successor keeps the operator wiring, and the plain bridge has none", () => {
    const b = withOperator(async () => ({ decision: "approve" }));
    expect(b.successor().usesOperatorChannel()).toBe(true);
    expect(new BrowxBridge().usesOperatorChannel()).toBe(false);
  });

  it("answerHint names DevTools only when the operator channel is off", () => {
    const plain = new BrowxBridge({ worldName: "browxai-w" });
    expect(plain.answerHint('__browx.proceed("t")')).toContain("browxai-w");
    const on = withOperator(async () => ({ decision: "approve" }));
    expect(on.answerHint('__browx.proceed("t")')).toContain("operator channel");
    expect(on.answerHint('__browx.proceed("t")')).not.toContain("__browx");
  });
});
