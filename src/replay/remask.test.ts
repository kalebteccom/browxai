import { describe, expect, it } from "vitest";
import { SecretRegistry } from "../util/secrets.js";
import { Redactor } from "./redact.js";
import { remaskEventLog } from "./remask.js";

const SECRET = "registered-late-hunter2";

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function jsonl(...lines: unknown[]): Buffer {
  return Buffer.from(
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
    "utf8",
  );
}

function redactorWith(name?: string): Redactor {
  const secrets = new SecretRegistry();
  if (name) secrets.register({ name, value: SECRET });
  return new Redactor({ secrets });
}

/** A log as it stands when its events were captured before the value was
 *  registered: the value is in a DOM node, a request body part and a console line. */
function capturedLog(): Buffer {
  return jsonl(
    {
      t: 0,
      type: "dom/rrweb",
      v: 1,
      payload: { type: 2, data: { node: { childNodes: [{ childNodes: [{ text: SECRET }] }] } } },
    },
    {
      t: 5,
      type: "net/request",
      v: 1,
      payload: {
        requestId: "1",
        request: {
          url: "https://app.test/api/login",
          method: "POST",
          postData: JSON.stringify({ password: SECRET }),
          postDataEntries: [
            { bytes: b64(JSON.stringify({ email: "a@b.co", password: SECRET })) },
            { bytes: { redacted: true, reason: "body-rule" } },
            {},
          ],
        },
      },
    },
    { t: 9, type: "console/message", v: 1, payload: { type: "log", text: `say "${SECRET}"` } },
  );
}

describe("the end-of-recording mask pass", () => {
  it("returns the log itself when no secret is registered", () => {
    const log = capturedLog();
    expect(remaskEventLog(log, redactorWith())).toBe(log);
    expect(remaskEventLog(log, new Redactor())).toBe(log);
  });

  it("masks a value registered after the events were captured", () => {
    const out = remaskEventLog(capturedLog(), redactorWith("TOKEN")).toString("utf8");
    expect(out).not.toContain(SECRET);
    expect(out.endsWith("\n")).toBe(true);
    const events = out
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { t: number; type: string; v: number; payload: unknown });
    expect(events.map((e) => [e.t, e.type, e.v])).toEqual([
      [0, "dom/rrweb", 1],
      [5, "net/request", 1],
      [9, "console/message", 1],
    ]);
    expect(events[0]?.payload).toEqual({
      type: 2,
      data: { node: { childNodes: [{ childNodes: [{ text: "<TOKEN>" }] }] } },
    });
    expect(events[2]?.payload).toEqual({ type: "log", text: 'say "<TOKEN>"' });
  });

  it("masks inside the base64 request body parts of a net/request event", () => {
    const out = remaskEventLog(capturedLog(), redactorWith("TOKEN")).toString("utf8");
    const request = (
      JSON.parse(out.split("\n")[1] ?? "") as {
        payload: { request: { postData: string; postDataEntries: { bytes?: unknown }[] } };
      }
    ).payload.request;
    expect(request.postData).toBe('{"password":"<TOKEN>"}');
    const [text, marker, empty] = request.postDataEntries;
    expect(Buffer.from(text?.bytes as string, "base64").toString("utf8")).toBe(
      '{"email":"a@b.co","password":"<TOKEN>"}',
    );
    expect(marker).toEqual({ bytes: { redacted: true, reason: "body-rule" } });
    expect(empty).toEqual({});
  });

  it("decodes a body part before masking, so an aligned value still decodes", () => {
    // 30 bytes come before the value and it is 21 bytes long, both multiples
    // of three, so the base64 of the body holds the value's own base64 whole.
    const aligned = "hunter2-real-password";
    const body = JSON.stringify({ email: "a@b.co", password: aligned });
    expect(b64(body)).toContain(b64(aligned));
    const secrets = new SecretRegistry();
    secrets.register({ name: "TOKEN", value: aligned });
    const log = jsonl({
      t: 0,
      type: "net/request",
      v: 1,
      payload: { requestId: "1", request: { postDataEntries: [{ bytes: b64(body) }] } },
    });
    const out = remaskEventLog(log, new Redactor({ secrets })).toString("utf8");
    const parsed = JSON.parse(out) as {
      payload: { request: { postDataEntries: { bytes: string }[] } };
    };
    const bytes = parsed.payload.request.postDataEntries[0]?.bytes ?? "";
    expect(Buffer.from(bytes, "base64").toString("utf8")).toBe(
      '{"email":"a@b.co","password":"<TOKEN>"}',
    );
  });

  it("masks a line that is not JSON as plain text and keeps it", () => {
    const log = jsonl(
      { t: 0, type: "console/message", v: 1, payload: { text: "ok" } },
      `{"t":1,"cut ${SECRET}`,
    );
    const out = remaskEventLog(log, redactorWith("TOKEN")).toString("utf8");
    expect(out).toBe(
      '{"t":0,"type":"console/message","v":1,"payload":{"text":"ok"}}\n{"t":1,"cut <TOKEN>\n',
    );
  });

  it("returns an empty log as an empty buffer", () => {
    expect(remaskEventLog(Buffer.alloc(0), redactorWith("TOKEN")).byteLength).toBe(0);
  });
});
