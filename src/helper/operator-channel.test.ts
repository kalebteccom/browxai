import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { chmodSync } from "node:fs";
import {
  openOperatorChannel,
  operatorCombinationWarnings,
  type OperatorAsk,
  type OperatorChannel,
} from "./operator-channel.js";
import { startFakeDaemon, type FakeDaemon } from "./__fixtures__/operator-daemon.js";
import { resolveCapabilities } from "../util/capabilities.js";
import { notificationPrompt } from "./operator-prompts.js";
import "../tools/tool-metadata.js";

const ON = resolveCapabilities({
  BROWX_CAPABILITIES: "read,navigation,action,human,operator-channel",
});
const OFF = resolveCapabilities({});

const identity = <T>(v: T): T => v;

function approvalAsk(over: Partial<OperatorAsk> = {}): OperatorAsk {
  return {
    session: "default",
    timeoutMs: 5_000,
    mask: identity,
    prompt: {
      kind: "approval",
      scope: "navigate_off_allowlist",
      tool: "navigate",
      summary: "navigate to https://pay.example.net/checkout (off the allowed-origins list)",
      grantable: "navigate_off_allowlist",
    },
    ...over,
  };
}

function humanAsk(
  humanKind: "acknowledge" | "confirm" | "choose" | "input",
  extra: { choices?: string[] } = {},
): OperatorAsk {
  return {
    session: "default",
    timeoutMs: 5_000,
    mask: identity,
    prompt: { kind: "human", humanKind, prompt: "Which account?", ...extra },
  };
}

let daemon: FakeDaemon;
let channel: OperatorChannel | null = null;
const logged: string[] = [];

function open(d: FakeDaemon = daemon): OperatorChannel {
  channel = openOperatorChannel(ON, {
    BROWX_OPERATOR_SOCKET: d.socketPath,
    BROWX_OPERATOR_TOKEN: d.token,
  });
  if (!channel) throw new Error("the channel did not open");
  return channel;
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  logged.length = 0;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  });
  daemon = await startFakeDaemon();
});

afterEach(async () => {
  channel?.close();
  channel = null;
  await daemon.close();
  vi.restoreAllMocks();
});

describe("openOperatorChannel — the gate", () => {
  it("opens nothing with the capability off, removes the variables, and warns by name", async () => {
    const env: NodeJS.ProcessEnv = {
      BROWX_OPERATOR_SOCKET: daemon.socketPath,
      BROWX_OPERATOR_TOKEN: daemon.token,
    };
    expect(openOperatorChannel(OFF, env)).toBeNull();
    expect(env.BROWX_OPERATOR_SOCKET).toBeUndefined();
    expect(env.BROWX_OPERATOR_TOKEN).toBeUndefined();
    await new Promise((r) => setTimeout(r, 150));
    expect(daemon.connections).toBe(0);
    const out = logged.join("");
    expect(out).toContain("operator-channel capability is off");
    expect(out).not.toContain(daemon.socketPath);
    expect(out).not.toContain(daemon.token);
  });

  it("stays quiet with the capability off and no variables", () => {
    expect(openOperatorChannel(OFF, {})).toBeNull();
    expect(logged.join("")).toBe("");
  });

  it("refuses to start when a variable is missing, naming the variable and not a value", async () => {
    for (const env of [
      { BROWX_OPERATOR_SOCKET: daemon.socketPath },
      { BROWX_OPERATOR_TOKEN: daemon.token },
      {},
    ]) {
      expect(() => openOperatorChannel(ON, { ...env })).toThrow(
        /BROWX_OPERATOR_SOCKET and BROWX_OPERATOR_TOKEN must both be set/,
      );
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(daemon.connections).toBe(0);
  });

  it("refuses to start on a directory that is not 0700, without naming it", () => {
    chmodSync(daemon.dir, 0o750);
    let message = "";
    try {
      open();
    } catch (e) {
      message = (e as Error).message;
    }
    chmodSync(daemon.dir, 0o700);
    expect(message).toContain("refusing to start the channel");
    expect(message).not.toContain(daemon.dir);
    expect(daemon.connections).toBe(0);
  });

  it("refuses to start on a socket that is not 0600", () => {
    chmodSync(daemon.socketPath, 0o666);
    expect(() => open()).toThrow(/refusing to start the channel.*0600/);
  });

  it("refuses a short token, without echoing it", () => {
    let message = "";
    try {
      openOperatorChannel(ON, {
        BROWX_OPERATOR_SOCKET: daemon.socketPath,
        BROWX_OPERATOR_TOKEN: "short",
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("shorter than");
    expect(message).not.toContain("short\n");
    expect(daemon.connections).toBe(0);
  });
});

describe("OperatorChannel — requests and answers", () => {
  it("sends an approval request and resolves on approve", async () => {
    const ch = open();
    const answer = ch.ask(approvalAsk());
    const req = await daemon.nextRequest();
    expect(req).toMatchObject({
      v: 1,
      type: "request",
      kind: "approval",
      session: "default",
      scope: "navigate_off_allowlist",
      tool: "navigate",
      untrusted: ["summary", "session"],
      answers: ["approve", "deny"],
      grantScopes: ["session", "workspace"],
    });
    expect(String(req.id)).toMatch(/^req_[0-9a-f]{32}$/);
    expect(Number(req.expiresAt) - Number(req.createdAt)).toBe(5_000);
    daemon.answer(req.id, { decision: "approve" });
    await expect(answer).resolves.toEqual({ decision: "approve" });
    await until(() => daemon.frames.some((f) => f.type === "resolved"));
    expect(daemon.frames.find((f) => f.type === "resolved")).toMatchObject({
      id: req.id,
      outcome: "approved",
      by: "operator",
    });
  });

  it("resolves a deny as a deny", async () => {
    const ch = open();
    const answer = ch.ask(approvalAsk());
    const req = await daemon.nextRequest();
    daemon.answer(req.id, { decision: "deny" });
    await expect(answer).resolves.toEqual({ decision: "deny" });
  });

  it("carries a grant on an approve", async () => {
    const ch = open();
    const answer = ch.ask(approvalAsk());
    const req = await daemon.nextRequest();
    daemon.answer(req.id, { decision: "approve", grant: { scope: "session", ttlSeconds: 900 } });
    await expect(answer).resolves.toEqual({
      decision: "approve",
      grant: { scope: "session", ttlSeconds: 900 },
    });
  });

  it("sends a human request and resolves with the typed value", async () => {
    const ch = open();
    const answer = ch.ask(humanAsk("choose", { choices: ["alice", "bob"] }));
    const req = await daemon.nextRequest();
    expect(req).toMatchObject({
      kind: "human",
      humanKind: "choose",
      prompt: "Which account?",
      choices: ["alice", "bob"],
      untrusted: ["prompt", "choices", "session"],
      answers: ["done", "abort"],
    });
    expect(req.grantScopes).toBeUndefined();
    daemon.answer(req.id, { decision: "done", value: 1 });
    await expect(answer).resolves.toEqual({ decision: "done", value: 1 });
  });

  it("answers an abort as an abort", async () => {
    const ch = open();
    const answer = ch.ask(humanAsk("acknowledge"));
    const req = await daemon.nextRequest();
    daemon.answer(req.id, { decision: "abort" });
    await expect(answer).resolves.toEqual({ decision: "abort" });
  });

  it("rejects an answer that does not fit the request and keeps waiting", async () => {
    const ch = open();
    const answer = ch.ask(approvalAsk());
    let settled = false;
    void answer.then(
      () => (settled = true),
      () => (settled = true),
    );
    const req = await daemon.nextRequest();
    daemon.answer(req.id, { decision: "done" });
    daemon.answer(req.id, { decision: "approve", grant: { scope: "global", ttlSeconds: 60 } });
    await until(() => daemon.frames.filter((f) => f.type === "error").length === 2);
    expect(daemon.frames.filter((f) => f.type === "error").map((f) => f.code)).toEqual([
      "invalid-answer",
      "invalid-answer",
    ]);
    expect(settled).toBe(false);
    daemon.answer(req.id, { decision: "approve" });
    await expect(answer).resolves.toMatchObject({ decision: "approve" });
  });

  it("makes a request id single-use", async () => {
    const ch = open();
    const answer = ch.ask(approvalAsk());
    const req = await daemon.nextRequest();
    daemon.answer(req.id, { decision: "deny" });
    await answer;
    daemon.answer(req.id, { decision: "approve" });
    await until(() => daemon.frames.some((f) => f.type === "error"));
    expect(daemon.frames.find((f) => f.type === "error")).toMatchObject({
      id: req.id,
      code: "unknown-request",
    });
  });

  it("answers an unknown id with unknown-request", async () => {
    open();
    await until(() => daemon.authenticated === 1);
    daemon.answer("req_nope", { decision: "approve" });
    await until(() => daemon.frames.some((f) => f.type === "error"));
    expect(daemon.frames.find((f) => f.type === "error")).toMatchObject({
      id: "req_nope",
      code: "unknown-request",
    });
  });

  it("masks secrets and strips URL queries from every string it sends", async () => {
    const ch = open();
    void ch
      .ask(
        approvalAsk({
          mask: <T>(v: T): T =>
            JSON.parse(JSON.stringify(v).replaceAll("hunter2", "<PASSWORD>")) as T,
          prompt: {
            kind: "approval",
            scope: "navigate_off_allowlist",
            tool: "navigate",
            summary: "navigate to https://pay.example.net/co?token=abc123 with hunter2",
          },
        }),
      )
      .catch(() => undefined);
    const req = await daemon.nextRequest();
    const text = String(req.summary);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("abc123");
    expect(text).toContain("<PASSWORD>");
  });

  it("ignores an answer that arrives before the handshake finishes", async () => {
    let knownId: unknown;
    const early = await startFakeDaemon({
      beforeWelcome: (send) => {
        if (knownId) send({ type: "answer", id: knownId, decision: "approve" });
      },
    });
    try {
      const ch = open(early);
      await until(() => early.authenticated === 1);
      const outcome = ch.ask(approvalAsk({ timeoutMs: 1_200 })).then(
        () => "answered",
        (e: Error) => e.message,
      );
      knownId = (await early.nextRequest()).id;
      early.drop();
      // The redial gets an answer ahead of the welcome. browxai drops that
      // connection, and the answer settles nothing.
      await until(() => early.connections >= 2, 5_000);
      expect(await outcome).toMatch(/timed out/);
      expect(early.authenticated).toBe(1);
    } finally {
      await early.close();
    }
  });
});

describe("OperatorChannel — fails closed", () => {
  it("denies at the timeout and tells the daemon", async () => {
    const ch = open();
    const answer = ch.ask(approvalAsk({ timeoutMs: 150 }));
    await expect(answer).rejects.toThrow(/timed out after 150ms/);
    await until(() => daemon.frames.some((f) => f.type === "resolved"));
    expect(daemon.frames.find((f) => f.type === "resolved")).toMatchObject({
      outcome: "timeout",
      by: "timeout",
    });
  });

  it("denies at the timeout when the daemon never connected", async () => {
    const ch = open();
    await daemon.close();
    const answer = ch.ask(approvalAsk({ timeoutMs: 150 }));
    await expect(answer).rejects.toThrow(/timed out after 150ms/);
    daemon = await startFakeDaemon();
  });

  it("keeps a request pending across a disconnect, resends it, and takes the late answer", async () => {
    const ch = open();
    await until(() => daemon.authenticated === 1);
    const answer = ch.ask(approvalAsk({ timeoutMs: 10_000 }));
    const first = await daemon.nextRequest();
    daemon.drop();
    await until(() => daemon.authenticated === 2, 5_000);
    const second = await daemon.nextRequest();
    expect(second.id).toBe(first.id);
    daemon.answer(second.id, { decision: "approve" });
    await expect(answer).resolves.toMatchObject({ decision: "approve" });
  });

  it("denies at the timeout when the daemon drops and stays away", async () => {
    const ch = open();
    await until(() => daemon.authenticated === 1);
    const answer = ch.ask(approvalAsk({ timeoutMs: 300 }));
    await daemon.nextRequest();
    await daemon.close();
    await expect(answer).rejects.toThrow(/timed out/);
    daemon = await startFakeDaemon();
  });

  it("closes for good, and denies at once, when the daemon cannot prove the token", async () => {
    const impostor = await startFakeDaemon({ proveWith: "x".repeat(32) });
    try {
      const ch = open(impostor);
      const answer = ch.ask(approvalAsk({ timeoutMs: 10_000 }));
      await expect(answer).rejects.toThrow(/channel is closed/);
      expect(impostor.frames.filter((f) => f.type === "request")).toHaveLength(0);
      expect(impostor.frames.filter((f) => f.type === "auth")).toHaveLength(0);
      await expect(ch.ask(approvalAsk())).rejects.toThrow(/channel is closed/);
      expect(logged.join("")).not.toContain(impostor.token);
    } finally {
      await impostor.close();
    }
  });

  it("never sends the token on the wire", async () => {
    const ch = open();
    void ch.ask(approvalAsk()).catch(() => undefined);
    await daemon.nextRequest();
    expect(JSON.stringify(daemon.frames)).not.toContain(daemon.token);
  });

  it("denies a pending request when the abort signal fires", async () => {
    const ch = open();
    const ac = new AbortController();
    const answer = ch.ask(approvalAsk({ timeoutMs: 10_000 }), ac.signal);
    await daemon.nextRequest();
    ac.abort();
    await expect(answer).rejects.toThrow(/bridge detached/);
    await until(() => daemon.frames.some((f) => f.type === "resolved"));
    expect(daemon.frames.find((f) => f.type === "resolved")).toMatchObject({ outcome: "aborted" });
  });

  it("denies everything pending when closed", async () => {
    const ch = open();
    const answer = ch.ask(approvalAsk({ timeoutMs: 10_000 }));
    ch.close();
    await expect(answer).rejects.toThrow(/channel is closed/);
    await expect(ch.ask(approvalAsk())).rejects.toThrow(/channel is closed/);
  });

  it("does not connect while the socket is unsafe, denies at the timeout, and recovers when it is fixed", async () => {
    const ch = open();
    await until(() => daemon.authenticated === 1);
    const first = ch.ask(approvalAsk({ timeoutMs: 10_000 }));
    const req = await daemon.nextRequest();
    chmodSync(daemon.socketPath, 0o666);
    daemon.drop();
    await until(() => logged.join("").includes("is not connecting"));
    expect(logged.join("")).not.toContain(daemon.dir);
    // Nothing connects, so a short request just times out.
    await expect(ch.ask(approvalAsk({ timeoutMs: 300 }))).rejects.toThrow(/timed out/);
    expect(daemon.connections).toBe(1);
    chmodSync(daemon.socketPath, 0o600);
    await until(() => daemon.authenticated === 2, 8_000);
    const again = await daemon.nextRequest();
    expect(again.id).toBe(req.id);
    daemon.answer(again.id, { decision: "approve" });
    await expect(first).resolves.toMatchObject({ decision: "approve" });
  });
});

describe("OperatorChannel — frames", () => {
  it("truncates prompt, choices and summary on send, and stays under the frame limit", async () => {
    const ch = open();
    const control = "\u0001".repeat(300_000);
    const answer = ch.ask({
      session: "s".repeat(1_000),
      timeoutMs: 10_000,
      mask: identity,
      prompt: {
        kind: "human",
        humanKind: "choose",
        prompt: control,
        choices: Array.from({ length: 1_000 }, () => control),
      },
    });
    const req = await daemon.nextRequest();
    expect(JSON.stringify(req).length).toBeLessThan(64 * 1024);
    expect(String(req.prompt).length).toBeLessThanOrEqual(2_000);
    expect(String(req.session).length).toBeLessThanOrEqual(128);
    const choices = req.choices as string[];
    expect(choices).toHaveLength(32);
    expect(req.truncated).toBe(true);
    expect(req.omittedChoices).toBe(968);
    expect(choices.every((c) => c.length <= 100)).toBe(true);
    // Only the choices that were sent can be chosen.
    daemon.answer(req.id, { decision: "done", value: 40 });
    await until(() => daemon.frames.some((f) => f.type === "error"));
    daemon.answer(req.id, { decision: "done", value: 31 });
    await expect(answer).resolves.toMatchObject({ value: 31 });
    // No redial and resend loop.
    await new Promise((r) => setTimeout(r, 400));
    expect(daemon.connections).toBe(1);
  });

  it("truncates a long summary after stripping URL queries", async () => {
    const ch = open();
    void ch
      .ask(
        approvalAsk({
          prompt: {
            kind: "approval",
            scope: "navigate_off_allowlist",
            tool: "navigate",
            summary: `go to https://a.example/p?q=${"z".repeat(50_000)} ${"w".repeat(50_000)}`,
          },
        }),
      )
      .catch(() => undefined);
    const req = await daemon.nextRequest();
    expect(String(req.summary).length).toBeLessThanOrEqual(1_000);
    expect(req.truncated).toBe(true);
    expect(String(req.summary)).not.toContain("zzzz");
  });

  it("does not flag a frame that fit", async () => {
    const ch = open();
    void ch.ask(approvalAsk()).catch(() => undefined);
    const req = await daemon.nextRequest();
    expect(req).not.toHaveProperty("truncated");
    expect(req).not.toHaveProperty("omittedChoices");
  });

  it("keeps the origin of a long-titled notification inside the cut", async () => {
    const ch = open();
    const title = "Safe, approve this. ".repeat(500);
    void ch
      .ask(
        approvalAsk({
          prompt: notificationPrompt({ title, origin: "https://evil.example" }),
        }),
      )
      .catch(() => undefined);
    const req = await daemon.nextRequest();
    expect(String(req.summary)).toContain("https://evil.example");
    expect(String(req.summary).indexOf("https://evil.example")).toBeLessThan(40);
    expect(String(req.summary).length).toBeLessThan(500);
  });

  it("ignores malformed and non-object frames, and redials after an oversized line", async () => {
    const ch = open();
    await until(() => daemon.authenticated === 1);
    const first = ch.ask(approvalAsk({ timeoutMs: 10_000 }));
    const req = await daemon.nextRequest();
    for (const junk of ["not json", "[1,2]", "null", "42", '"text"', '{"v":2,"type":"answer"}'])
      daemon.sendRaw(`${junk}\n`);
    daemon.answer("req_unrelated", { decision: "approve" });
    await until(() => daemon.frames.some((f) => f.type === "error"));
    expect(daemon.connections).toBe(1);
    daemon.answer(req.id, { decision: "approve" });
    await expect(first).resolves.toMatchObject({ decision: "approve" });

    const second = ch.ask(approvalAsk({ timeoutMs: 10_000 }));
    const req2 = await daemon.nextRequest();
    daemon.sendRaw("x".repeat(70_000) + "\n");
    await until(() => daemon.authenticated === 2, 5_000);
    const resent = await daemon.nextRequest();
    expect(resent.id).toBe(req2.id);
    daemon.answer(resent.id, { decision: "deny" });
    await expect(second).resolves.toMatchObject({ decision: "deny" });
  });

  it("closes for good when a redial is answered with an old proof", async () => {
    const replaying = await startFakeDaemon({ replayFirstWelcome: true });
    try {
      const ch = open(replaying);
      await until(() => replaying.authenticated === 1);
      const answer = ch.ask(approvalAsk({ timeoutMs: 10_000 }));
      await replaying.nextRequest();
      replaying.drop();
      await expect(answer).rejects.toThrow(/channel is closed/);
      expect(replaying.authenticated).toBe(1);
      expect(logged.join("")).toContain("failed authentication");
    } finally {
      await replaying.close();
    }
  });
});

describe("OperatorChannel — pending limits", () => {
  const pageAsk = (session: string, n: number): OperatorAsk =>
    approvalAsk({
      session,
      timeoutMs: 10_000,
      prompt: {
        kind: "approval",
        scope: "notification",
        tool: "notification_construct",
        summary: `show a notification titled "spam ${n}"`,
      },
    });

  /** "waiting" when the request was accepted, "refused" when it was turned away at once. */
  async function admission(p: Promise<unknown>): Promise<"waiting" | "refused"> {
    return Promise.race([
      p.then(
        () => "refused" as const,
        () => "refused" as const,
      ),
      new Promise<"waiting">((r) => setTimeout(() => r("waiting"), 25)),
    ]);
  }

  it("caps a page flood per session and per class, and leaves room for a confirm hook", async () => {
    const ch = open();
    const held: Array<Promise<unknown>> = [];
    let accepted = 0;
    for (const session of ["p1", "p2", "p3"]) {
      for (let i = 0; i < 10; i++) {
        const p = ch.ask(pageAsk(session, i));
        held.push(p.catch(() => undefined));
        if ((await admission(p)) === "waiting") accepted++;
      }
    }
    // 4 per session, 8 for the class: p1 and p2 fill it, p3 gets nothing.
    expect(accepted).toBe(8);
    const hook = ch.ask(approvalAsk({ session: "real", timeoutMs: 10_000 }));
    held.push(hook.catch(() => undefined));
    expect(await admission(hook)).toBe("waiting");
    const hookFrame = await vi.waitFor(
      () => {
        const f = daemon.frames.find((x) => x.type === "request" && x.session === "real");
        if (!f) throw new Error("no hook request yet");
        return f;
      },
      { timeout: 3_000 },
    );
    expect(hookFrame).toMatchObject({ scope: "navigate_off_allowlist" });
    expect(
      daemon.frames.filter((f) => f.type === "request" && f.scope === "notification"),
    ).toHaveLength(8);
    ch.close();
    await Promise.all(held);
  });

  it("caps hooks and await_human per session and per class, apart from each other", async () => {
    const ch = open();
    const held: Array<Promise<unknown>> = [];
    const take = async (p: Promise<unknown>) => {
      held.push(p.catch(() => undefined));
      return admission(p);
    };
    for (let i = 0; i < 8; i++)
      expect(await take(ch.ask(approvalAsk({ session: "a" })))).toBe("waiting");
    expect(await take(ch.ask(approvalAsk({ session: "a" })))).toBe("refused");
    for (let i = 0; i < 4; i++)
      expect(await take(ch.ask(approvalAsk({ session: "b" })))).toBe("waiting");
    expect(await take(ch.ask(approvalAsk({ session: "c" })))).toBe("refused");
    // A full hook class does not touch await_human.
    expect(await take(ch.ask(humanAsk("acknowledge")))).toBe("waiting");
    ch.close();
    await Promise.all(held);
  });

  it("answers identical page prompts from one request", async () => {
    const ch = open();
    const same = Array.from({ length: 10 }, () => ch.ask(pageAsk("p", 1)));
    const req = await daemon.nextRequest();
    await new Promise((r) => setTimeout(r, 200));
    expect(daemon.frames.filter((f) => f.type === "request")).toHaveLength(1);
    daemon.answer(req.id, { decision: "approve" });
    const results = await Promise.all(same);
    expect(results.every((r) => r.decision === "approve")).toBe(true);
    // Once answered, the same prompt is a new request.
    const next = ch.ask(pageAsk("p", 1));
    const req2 = await daemon.nextRequest();
    expect(req2.id).not.toBe(req.id);
    daemon.answer(req2.id, { decision: "deny" });
    await expect(next).resolves.toMatchObject({ decision: "deny" });
  });

  it("does not collapse hook prompts, or prompts from different sessions", async () => {
    const ch = open();
    const asks = [
      ch.ask(approvalAsk({ session: "a" })),
      ch.ask(approvalAsk({ session: "a" })),
      ch.ask(pageAsk("a", 1)),
      ch.ask(pageAsk("b", 1)),
    ];
    await until(() => daemon.frames.filter((f) => f.type === "request").length === 4);
    ch.close();
    await Promise.allSettled(asks);
  });
});

describe("operator-channel combined with self-approval or human-gate-override", () => {
  const caps = (extra: string) =>
    resolveCapabilities({
      BROWX_CAPABILITIES: `read,navigation,action,human,operator-channel${extra}`,
    });

  it("warns about each, naming what the daemon would miss", () => {
    const both = operatorCombinationWarnings(caps(",self-approval,human-gate-override"));
    expect(both).toHaveLength(2);
    expect(both[0]).toMatch(/self-approval.*approve_actions.*BEFORE the daemon is asked/);
    expect(both[1]).toMatch(/human-gate-override.*never reaches the daemon/);
  });

  it("is quiet for operator-channel alone", () => {
    expect(operatorCombinationWarnings(caps(""))).toEqual([]);
  });

  it("logs the warnings when the channel starts", () => {
    channel = openOperatorChannel(caps(",self-approval"), {
      BROWX_OPERATOR_SOCKET: daemon.socketPath,
      BROWX_OPERATOR_TOKEN: daemon.token,
    });
    expect(logged.join("")).toContain("operator-channel is on together with self-approval");
  });
});
