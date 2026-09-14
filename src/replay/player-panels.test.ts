// Unit coverage for the four panels (RFC 0007 P3): the event index every panel
// resolves the playhead through, the correlation each one does once at mount,
// and the text a cell renders. The rendering half — the DOM the panels build —
// is covered by test/keystone/replay-player.keystone.test.ts, which opens the
// BUILT single file in a real browser.
//
// Everything asserted here is pure, which is the constraint the panel contract
// exists to hold: a panel is a function of the event log and the playhead.

import { describe, it, expect } from "vitest";

import type { ReplayEvent } from "./schema.js";
import { redactedMarker } from "./redact.js";
import { indexEvents, fromIndex, upToIndex, windowUpTo } from "./player/panels/event-index.js";
import { displayText, formatBytes } from "./player/panels/panel-ui.js";
import {
  buildNetworkRows,
  resolveNetwork,
  statusText,
  NETWORK_EMPTY,
  NETWORK_NONE_YET,
} from "./player/panels/network-panel.js";
import {
  buildWsConnections,
  resolveWs,
  closeText,
  WS_EMPTY,
  WS_NONE_YET,
} from "./player/panels/ws-panel.js";
import {
  buildConsoleRows,
  resolveConsole,
  levelOf,
  CONSOLE_EMPTY,
} from "./player/panels/console-panel.js";
import { buildCoverage, resolveCoverage, COVERAGE_EMPTY } from "./player/panels/coverage-panel.js";

function ev(t: number, type: string, payload: unknown, v = 1): ReplayEvent {
  return { t, type, v, payload };
}

/** A log with something for every panel, plus one event type this build has
 *  never heard of and one known type carrying a payload of the wrong shape. */
function sampleEvents(): ReplayEvent[] {
  return [
    ev(10, "net/request", { requestId: "1", request: { url: "https://a.test/x", method: "GET" } }),
    ev(20, "ws/open", { requestId: "w1", url: "wss://a.test/socket" }),
    ev(30, "console/message", { type: "log", text: "hello" }),
    ev(40, "net/response", {
      requestId: "1",
      response: { url: "https://a.test/x", status: 200, headers: { "Content-Length": "2048" } },
      type: "XHR",
    }),
    ev(50, "ws/frame", { url: "wss://a.test/socket", dir: "sent", kind: "ws", payload: "ping" }),
    ev(60, "telemetry/flamechart", { frames: [1, 2, 3] }, 7),
    ev(70, "console/message", { type: "error", text: "boom" }),
    ev(80, "page/error", { text: "Uncaught TypeError", stack: "at x" }),
    ev(90, "net/request", { requestId: "2", request: { url: "https://a.test/y", method: "POST" } }),
    ev(100, "ws/close", { requestId: "w1", code: 1001, reason: "going away" }),
    ev(120, "net/failed", { requestId: "2", errorText: "net::ERR_ABORTED", type: "Fetch" }),
    // A known type whose payload is not the shape the panel expects.
    ev(130, "console/message", "not an object"),
  ];
}

describe("event index", () => {
  it("buckets by type once, including a type this build has never heard of", () => {
    const index = indexEvents(sampleEvents());
    expect(index.count("net/request")).toBe(2);
    expect(index.has("telemetry/flamechart")).toBe(true);
    expect(index.count("telemetry/flamechart")).toBe(1);
    expect(index.duration).toBe(130);
  });

  it("reports a type the log does not carry as absent rather than throwing", () => {
    const index = indexEvents(sampleEvents());
    expect(index.has("ws/nonesuch")).toBe(false);
    expect(index.byType("ws/nonesuch")).toEqual([]);
    expect(index.count("ws/nonesuch")).toBe(0);
  });

  it("orders a bucket whose events did not arrive in time order", () => {
    const index = indexEvents([
      ev(90, "console/message", { type: "log", text: "late" }),
      ev(10, "console/message", { type: "log", text: "early" }),
    ]);
    expect(index.byType("console/message").map((e) => e.t)).toEqual([10, 90]);
  });

  it("clamps a negative or non-numeric t instead of corrupting the search", () => {
    const index = indexEvents([
      ev(-5, "console/message", { type: "log", text: "a" }),
      { t: Number.NaN, type: "console/message", v: 1, payload: { type: "log", text: "b" } },
    ]);
    expect(index.duration).toBe(0);
    expect(buildConsoleRows(index).map((r) => r.t)).toEqual([0, 0]);
  });

  it("resolves the playhead by binary search, not by scanning", () => {
    const items = [{ t: 0 }, { t: 10 }, { t: 20 }, { t: 30 }];
    const key = (x: { t: number }): number => x.t;
    expect(upToIndex(items, 20, key)).toBe(3);
    expect(upToIndex(items, 25, key)).toBe(3);
    expect(upToIndex(items, -1, key)).toBe(0);
    expect(fromIndex(items, 20, key)).toBe(2);
    expect(windowUpTo(items, 30, 2, key)).toMatchObject({ hidden: 2, total: 4 });
  });
});

describe("network panel", () => {
  it("correlates a request with its response and with its failure by requestId", () => {
    const rows = buildNetworkRows(indexEvents(sampleEvents()));
    expect(rows.map((r) => r.requestId)).toEqual(["1", "2"]);
    expect(rows[0]).toMatchObject({ method: "GET", status: 200, startT: 10, endT: 40 });
    expect(rows[1]).toMatchObject({ method: "POST", error: "net::ERR_ABORTED", endT: 120 });
  });

  it("hides a request that had not started and marks one still in flight", () => {
    const rows = buildNetworkRows(indexEvents(sampleEvents()));
    expect(resolveNetwork(rows, 5).rows).toHaveLength(0);
    const midflight = resolveNetwork(rows, 20).rows;
    expect(midflight).toHaveLength(1);
    expect(midflight[0]?.state).toBe("pending");
    // The status it will eventually get is NOT shown before it arrived.
    expect(midflight[0]?.status).toBeUndefined();
    expect(statusText(midflight[0]!)).toBe("in flight");
    const settled = resolveNetwork(rows, 40).rows;
    expect(settled[0]).toMatchObject({ state: "ok", status: 200, durationMs: 30 });
  });

  it("reads a failure as failed and a 4xx as an error, once each has landed", () => {
    const rows = buildNetworkRows(indexEvents(sampleEvents()));
    expect(resolveNetwork(rows, 100).rows[1]?.state).toBe("pending");
    const done = resolveNetwork(rows, 130).rows;
    expect(done[1]?.state).toBe("failed");
    expect(statusText(done[1]!)).toBe("net::ERR_ABORTED");

    const notFound = buildNetworkRows(
      indexEvents([
        ev(0, "net/request", { requestId: "a", request: { url: "u", method: "GET" } }),
        ev(5, "net/response", { requestId: "a", response: { url: "u", status: 404 } }),
      ]),
    );
    expect(resolveNetwork(notFound, 10).rows[0]?.state).toBe("error");
  });

  it("takes the size from the declared length, and says so when it was redacted", () => {
    const rows = buildNetworkRows(indexEvents(sampleEvents()));
    expect(resolveNetwork(rows, 40).rows[0]?.size).toBe(2048);
    expect(formatBytes(2048)).toBe("2.0 KB");

    const redacted = buildNetworkRows(
      indexEvents([
        ev(0, "net/request", { requestId: "a", request: { url: "u", method: "GET" } }),
        ev(5, "net/response", {
          requestId: "a",
          response: {
            url: "u",
            status: 200,
            headers: { "content-length": redactedMarker("header") },
          },
        }),
      ]),
    );
    const size = resolveNetwork(redacted, 10).rows[0]?.size;
    // Never blank, never the literal object: the marker says something was taken
    // out, which is the whole reason capture records it.
    expect(formatBytes(size)).toBe("[redacted: header]");
    expect(displayText(size)).toBe("[redacted: header]");
  });

  it("keeps a response whose request never appeared, marked as an orphan", () => {
    const rows = buildNetworkRows(
      indexEvents([
        ev(20, "net/response", {
          requestId: "z",
          response: { url: "https://a.test/z", status: 204 },
        }),
      ]),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orphan: true, status: 204, method: "?" });
  });

  it("renders an empty state for a log with no network events at all", () => {
    const rows = buildNetworkRows(indexEvents([ev(0, "telemetry/flamechart", { a: 1 })]));
    expect(rows).toEqual([]);
    expect(NETWORK_EMPTY).toMatch(/No network events/);
    expect(NETWORK_NONE_YET).toMatch(/timeline/);
  });

  it("bounds the row window and reports what it left out", () => {
    const many: ReplayEvent[] = [];
    for (let i = 0; i < 500; i++) {
      many.push(
        ev(i, "net/request", { requestId: String(i), request: { url: "u", method: "GET" } }),
      );
    }
    const resolved = resolveNetwork(buildNetworkRows(indexEvents(many)), 499, 100);
    expect(resolved.rows).toHaveLength(100);
    expect(resolved.hidden).toBe(400);
    expect(resolved.total).toBe(500);
  });
});

describe("websocket panel", () => {
  it("attaches frames to the connection on their url and reads the close", () => {
    const conns = buildWsConnections(indexEvents(sampleEvents()));
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ requestId: "w1", url: "wss://a.test/socket", closeT: 100 });
    expect(conns[0]?.frames).toHaveLength(1);
    const closed = resolveWs(conns, 130).rows[0]!;
    expect(closed.state).toBe("closed");
    expect(closeText(closed)).toBe("closed: 1001 going away");
  });

  it("hides a connection that had not opened and keeps a later close as open", () => {
    const conns = buildWsConnections(indexEvents(sampleEvents()));
    expect(resolveWs(conns, 10).rows).toHaveLength(0);
    const atFrame = resolveWs(conns, 50).rows[0]!;
    expect(atFrame.state).toBe("open");
    expect(closeText(atFrame)).toBe("open");
    expect(atFrame.sent).toBe(1);
    expect(atFrame.received).toBe(0);
    // The frame had not been sent yet at t=40.
    expect(resolveWs(conns, 40).rows[0]?.visibleFrames).toHaveLength(0);
  });

  it("infers a connection for frames whose stream was never opened, so SSE shows up", () => {
    const conns = buildWsConnections(
      indexEvents([
        ev(10, "ws/frame", {
          url: "https://a.test/stream",
          dir: "recv",
          kind: "sse",
          payload: "{}",
          event: "tick",
        }),
        ev(20, "ws/frame", {
          url: "https://a.test/stream",
          dir: "recv",
          kind: "sse",
          payload: "{}",
        }),
      ]),
    );
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ inferred: true, kind: "sse", openT: 10 });
    expect(resolveWs(conns, 20).rows[0]?.received).toBe(2);
  });

  it("renders a redacted frame payload as the marker, never as the raw object", () => {
    const conns = buildWsConnections(
      indexEvents([
        ev(0, "ws/open", { requestId: "s", url: "wss://a.test/s" }),
        ev(5, "ws/frame", {
          url: "wss://a.test/s",
          dir: "recv",
          kind: "ws",
          payload: redactedMarker("body-rule"),
        }),
      ]),
    );
    const frame = resolveWs(conns, 10).rows[0]?.visibleFrames[0];
    expect(displayText(frame?.payload)).toBe("[redacted: body-rule]");
  });

  it("renders an empty state for a log with no socket traffic", () => {
    expect(buildWsConnections(indexEvents([ev(0, "telemetry/flamechart", {})]))).toEqual([]);
    expect(WS_EMPTY).toMatch(/No WebSocket/);
    expect(WS_NONE_YET).toMatch(/timeline/);
  });
});

describe("console panel", () => {
  it("merges console messages and page errors onto one clock, in order", () => {
    const rows = buildConsoleRows(indexEvents(sampleEvents()));
    expect(rows.map((r) => r.t)).toEqual([30, 70, 80, 130]);
    expect(rows.map((r) => r.source)).toEqual(["console", "console", "page", "console"]);
    expect(rows[2]).toMatchObject({ level: "error", stack: "at x" });
  });

  it("maps a level it knows, and keeps one it does not as a log that says what it was", () => {
    expect(levelOf("warning")).toBe("warn");
    expect(levelOf("ASSERT")).toBe("error");
    expect(levelOf("timeEnd")).toBe("log");
    const rows = buildConsoleRows(
      indexEvents([ev(0, "console/message", { type: "timeEnd", text: "t" })]),
    );
    expect(rows[0]).toMatchObject({ level: "log", rawType: "timeEnd" });
  });

  it("shows nothing logged after the playhead and filters by level", () => {
    const rows = buildConsoleRows(indexEvents(sampleEvents()));
    expect(resolveConsole(rows, 20).rows).toHaveLength(0);
    expect(resolveConsole(rows, 75).rows.map((r) => r.t)).toEqual([30, 70]);
    expect(resolveConsole(rows, 200, "error").rows.map((r) => r.t)).toEqual([70, 80]);
    expect(resolveConsole(rows, 200, "warn").rows).toHaveLength(2);
  });

  it("degrades a message whose payload is not an object instead of dropping the row", () => {
    const rows = buildConsoleRows(indexEvents(sampleEvents()));
    const malformed = rows.find((r) => r.t === 130);
    expect(malformed).toMatchObject({ level: "log", source: "console" });
    expect(displayText(malformed?.text)).toBe("—");
  });

  it("walks back from the playhead only as far as the window, and says there is more", () => {
    const many: ReplayEvent[] = [];
    for (let i = 0; i < 300; i++)
      many.push(ev(i, "console/message", { type: "log", text: `m${i}` }));
    const resolved = resolveConsole(buildConsoleRows(indexEvents(many)), 299, "debug", 50);
    expect(resolved.rows).toHaveLength(50);
    expect(resolved.rows[0]?.t).toBe(250);
    expect(resolved.more).toBe(true);
    expect(resolved.total).toBe(300);
  });

  it("renders an empty state for a log with no console output", () => {
    expect(buildConsoleRows(indexEvents([ev(0, "telemetry/flamechart", {})]))).toEqual([]);
    expect(CONSOLE_EMPTY).toMatch(/No console output/);
  });
});

describe("coverage view", () => {
  const spans = (): ReplayEvent[] => [
    ev(10, "annotate/span", { label: "AC-1", phase: "start", note: "checkout" }),
    ev(20, "action/call", { tool: "click" }),
    ev(30, "action/result", { tool: "click", ok: true }),
    ev(40, "assert/result", { tool: "verify_text", ok: false }),
    ev(50, "annotate/span", { label: "AC-1", phase: "end" }),
    ev(60, "annotate/span", { label: "AC-2", phase: "start" }),
    ev(70, "action/result", { tool: "fill", ok: true }),
    ev(90, "console/message", { type: "log", text: "after" }),
  ];

  it("groups spans by label and lists the steps that ran inside them", () => {
    const groups = buildCoverage(indexEvents(spans()));
    expect(groups.map((g) => g.label)).toEqual(["AC-1", "AC-2"]);
    expect(groups[0]).toMatchObject({ from: 10, to: 50, unclosed: false, failures: 1 });
    expect(groups[0]?.steps.map((s) => s.tool)).toEqual(["click", "verify_text"]);
    expect(groups[0]?.note).toBe("checkout");
  });

  it("shows an unclosed span as unclosed, running to the end of the log", () => {
    const groups = buildCoverage(indexEvents(spans()));
    const open = groups[1]!;
    expect(open).toMatchObject({ label: "AC-2", unclosed: true, from: 60, to: 90 });
    expect(open.spans[0]?.open).toBe(true);
    expect(open.steps.map((s) => s.tool)).toEqual(["fill"]);
  });

  it("keeps every label visible and lets the playhead colour the state instead", () => {
    const groups = buildCoverage(indexEvents(spans()));
    const early = resolveCoverage(groups, 30);
    // Coverage is a whole-run answer: a span the playhead has not reached is
    // still listed, marked as ahead.
    expect(early.map((g) => g.state)).toEqual(["active", "ahead"]);
    expect(early[0]?.stepsSoFar).toBe(1);
    expect(resolveCoverage(groups, 55).map((g) => g.state)).toEqual(["done", "ahead"]);
    expect(resolveCoverage(groups, 70).map((g) => g.state)).toEqual(["done", "active"]);
  });

  it("groups a label that was entered more than once under one row", () => {
    const groups = buildCoverage(
      indexEvents([
        ev(0, "annotate/span", { label: "AC", phase: "start" }),
        ev(10, "annotate/span", { label: "AC", phase: "end" }),
        ev(20, "annotate/span", { label: "AC", phase: "start" }),
        ev(25, "action/result", { tool: "click", ok: true }),
        ev(30, "annotate/span", { label: "AC", phase: "end" }),
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.spans).toHaveLength(2);
    expect(groups[0]).toMatchObject({ from: 0, to: 30, unclosed: false });
    expect(groups[0]?.steps).toHaveLength(1);
  });

  it("renders an empty state when nothing was annotated", () => {
    expect(
      buildCoverage(indexEvents([ev(0, "action/result", { tool: "click", ok: true })])),
    ).toEqual([]);
    expect(COVERAGE_EMPTY).toMatch(/record_annotate/);
  });
});

describe("forward compatibility — a log this build does not understand", () => {
  const future = (): ReplayEvent[] => [
    ev(0, "telemetry/flamechart", { frames: [1] }, 9),
    ev(10, "redux/action", { type: "cart/add" }, 2),
    ev(20, "net/request", { requestId: "1", request: { url: "u", method: "GET" }, futureField: 1 }),
    ev(30, "net/response", { requestId: "1", response: { url: "u", status: 200 }, newThing: {} }),
  ];

  it("leaves every panel mountable and empty rather than failing on an unknown type", () => {
    const index = indexEvents(future());
    expect(buildWsConnections(index)).toEqual([]);
    expect(buildConsoleRows(index)).toEqual([]);
    expect(buildCoverage(index)).toEqual([]);
    expect(buildNetworkRows(index)).toHaveLength(1);
  });

  it("ignores payload fields it does not recognise instead of choking on them", () => {
    const rows = buildNetworkRows(indexEvents(future()));
    expect(resolveNetwork(rows, 30).rows[0]).toMatchObject({ status: 200, state: "ok" });
  });

  it("never renders a value as [object Object]", () => {
    expect(displayText({ frames: [1, 2] })).toBe('{"frames":[1,2]}');
    expect(displayText(undefined)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
  });
});
