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
import { Redactor, redactedMarker } from "./redact.js";
import {
  consoleMessageEvent,
  createClock,
  netFailedEvent,
  netRequestEvent,
  netResponseEvent,
  pageErrorEvent,
} from "./sources.js";
import { SecretRegistry } from "../util/secrets.js";
import { indexEvents, fromIndex, upToIndex, windowUpTo } from "./player/panels/event-index.js";
import { mountPanels, type PanelDef, type PanelHost } from "./player/panels/panel-host.js";
import { displayText, formatBytes, matchesText } from "./player/panels/panel-ui.js";
import { blockText, MAX_DETAIL_CHARS } from "./player/panels/panel-detail.js";
import {
  bodyGap,
  buildNetworkRows,
  netViewMatches,
  networkDetail,
  NO_NET_FILTER,
  resolveNetwork,
  statusLine,
  statusText,
} from "./player/panels/network-panel.js";
import { buildWsConnections, resolveWs, closeText } from "./player/panels/ws-panel.js";
import {
  buildConsoleRows,
  consoleDetail,
  levelLabel,
  levelOf,
  resolveConsole,
} from "./player/panels/console-panel.js";
import { buildCoverage, resolveCoverage } from "./player/panels/coverage-panel.js";

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
  it("buckets by type once, including an unknown type, and windows a type inclusive at both ends", () => {
    const index = indexEvents(sampleEvents());
    expect(index.count("net/request")).toBe(2);
    expect(index.events("telemetry/flamechart")).toHaveLength(1);
    expect(index.duration).toBe(130);
    // One type windows to a time range, inclusive at both ends.
    expect(index.events("net/request", { from: 20 }).map((e) => e.t)).toEqual([90]);
    expect(index.events("net/request", { to: 10 }).map((e) => e.t)).toEqual([10]);
    expect(index.events("net/request", { from: 10, to: 90 }).map((e) => e.t)).toEqual([10, 90]);
    expect(index.events("net/request", { from: 200, to: 300 })).toEqual([]);
  });

  it("orders a bucket whose events did not arrive in time order", () => {
    const index = indexEvents([
      ev(90, "console/message", { type: "log", text: "late" }),
      ev(10, "console/message", { type: "log", text: "early" }),
    ]);
    expect(index.events("console/message").map((e) => e.t)).toEqual([10, 90]);
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
});

describe("websocket panel", () => {
  it("attaches frames to the connection on their url, reads the close, and hides it before the open", () => {
    const conns = buildWsConnections(indexEvents(sampleEvents()));
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ requestId: "w1", url: "wss://a.test/socket", closeT: 100 });
    expect(conns[0]?.frames).toHaveLength(1);
    const closed = resolveWs(conns, 130).rows[0]!;
    expect(closed.state).toBe("closed");
    expect(closeText(closed)).toBe("closed: 1001 going away");

    // Before the open the connection is hidden; a later close still reads as open.
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

  it("does not let an early frame's inferred connection steal the real socket", () => {
    // 1ms of skew between the WS ring's clock and the CDP tap that stamps the
    // open is all it takes: the frame at 99 has no open to attach to, and the
    // connection it infers must not then outrank the real one for every frame
    // after it.
    const conns = buildWsConnections(
      indexEvents([
        ev(99, "ws/frame", { url: "wss://a.test/s", dir: "recv", kind: "ws", payload: "early" }),
        ev(100, "ws/open", { requestId: "w1", url: "wss://a.test/s" }),
        ev(150, "ws/frame", { url: "wss://a.test/s", dir: "recv", kind: "ws", payload: "late" }),
        ev(160, "ws/frame", { url: "wss://a.test/s", dir: "sent", kind: "ws", payload: "reply" }),
      ]),
    );
    expect(conns.map((c) => c.requestId)).toEqual(["", "w1"]);
    expect(conns[0]?.frames.map((f) => f.payload)).toEqual(["early"]);
    expect(conns[1]?.frames.map((f) => f.payload)).toEqual(["late", "reply"]);
    const view = resolveWs(conns, 200).rows[1]!;
    expect({ sent: view.sent, received: view.received }).toEqual({ sent: 1, received: 1 });
  });

  it("gives a frame after a close to a live connection, never to the closed one", () => {
    const conns = buildWsConnections(
      indexEvents([
        ev(0, "ws/open", { requestId: "w1", url: "wss://a.test/s" }),
        ev(10, "ws/frame", { url: "wss://a.test/s", dir: "recv", kind: "ws", payload: "first" }),
        ev(20, "ws/close", { requestId: "w1", code: 1000 }),
        ev(30, "ws/open", { requestId: "w2", url: "wss://a.test/s" }),
        ev(40, "ws/frame", { url: "wss://a.test/s", dir: "recv", kind: "ws", payload: "second" }),
      ]),
    );
    expect(conns.map((c) => c.requestId)).toEqual(["w1", "w2"]);
    expect(conns[0]?.frames.map((f) => f.payload)).toEqual(["first"]);
    expect(conns[1]?.frames.map((f) => f.payload)).toEqual(["second"]);
  });

  it("gives frames on two live sockets to the newer one, because a frame has no id", () => {
    // The honest limit of correlating on url: `ws/frame` carries no requestId,
    // so two sockets open on one url cannot be told apart. The newer one wins,
    // and the older reads as open with no traffic — which is at least true of
    // what the log can prove.
    const conns = buildWsConnections(
      indexEvents([
        ev(0, "ws/open", { requestId: "w1", url: "wss://a.test/s" }),
        ev(5, "ws/open", { requestId: "w2", url: "wss://a.test/s" }),
        ev(10, "ws/frame", { url: "wss://a.test/s", dir: "sent", kind: "ws", payload: "x" }),
      ]),
    );
    expect(conns).toHaveLength(2);
    expect(conns[0]?.frames).toHaveLength(0);
    expect(conns[1]?.frames).toHaveLength(1);
  });

  it("keeps a close whose open never arrived, with its code and reason", () => {
    const conns = buildWsConnections(
      indexEvents([
        ev(40, "ws/close", {
          requestId: "gone",
          url: "wss://a.test/s",
          code: 1006,
          reason: "abnormal",
        }),
      ]),
    );
    expect(conns).toHaveLength(1);
    expect(conns[0]).toMatchObject({ requestId: "gone", inferred: true, closeT: 40 });
    const view = resolveWs(conns, 50).rows[0]!;
    expect(view.state).toBe("closed");
    expect(closeText(view)).toBe("closed: 1006 abnormal");
  });

  it("tells a url that was removed from one that was never there", () => {
    const conns = buildWsConnections(
      indexEvents([
        ev(0, "ws/open", { requestId: "r", url: redactedMarker("secret") }),
        ev(5, "ws/open", { requestId: "n" }),
      ]),
    );
    expect(displayText(conns[0]?.url)).toBe("[redacted: secret]");
    expect(conns[0]?.urlKey).toBe("");
    expect(displayText(conns[1]?.url)).toBe("—");
  });
});

describe("console panel", () => {
  it("merges console messages and page errors onto one clock, in order", () => {
    const rows = buildConsoleRows(indexEvents(sampleEvents()));
    expect(rows.map((r) => r.t)).toEqual([30, 70, 80, 130]);
    expect(rows.map((r) => r.source)).toEqual(["console", "console", "page", "console"]);
    expect(rows[2]).toMatchObject({ level: "error", stack: "at x" });
    // The last sample row carries a payload that is not an object. It degrades to
    // a plain log row instead of being dropped.
    expect(rows[3]).toMatchObject({ level: "log", source: "console" });
    expect(displayText(rows[3]?.text)).toBe("—");
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

  it("groups spans by label, lists the steps inside them, and shows an unclosed span running to the end", () => {
    const groups = buildCoverage(indexEvents(spans()));
    expect(groups.map((g) => g.label)).toEqual(["AC-1", "AC-2"]);
    expect(groups[0]).toMatchObject({ from: 10, to: 50, unclosed: false, failures: 1 });
    expect(groups[0]?.steps.map((s) => s.tool)).toEqual(["click", "verify_text"]);
    expect(groups[0]?.note).toBe("checkout");

    // A span that never ended shows as unclosed, running to the end of the log.
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

  it("counts a step once when an orphan end phase leaves a zero-width span", () => {
    // `end` with no `start` is a real shape: capture began mid-span. It folds
    // to a zero-width span that touches its neighbour, and the step at that
    // millisecond must not be counted by both.
    const groups = buildCoverage(
      indexEvents([
        ev(10, "action/result", { tool: "click", ok: true }),
        ev(10, "annotate/span", { label: "AC", phase: "end" }),
        ev(10, "annotate/span", { label: "AC", phase: "start" }),
        ev(20, "action/result", { tool: "fill", ok: true }),
        ev(30, "annotate/span", { label: "AC", phase: "end" }),
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.steps.map((s) => s.tool)).toEqual(["click", "fill"]);
  });

  it("takes the bounds of a label with more spans than a call frame has room for", () => {
    // Span counts this size are why the bounds are folded rather than spread
    // into `Math.min(...)`: argument-list spreading has a ceiling (a RangeError
    // around 124k on this V8), and a long session annotating in a loop reaches
    // it. The panel host's mount guard is the backstop; this pins the bounds.
    const events: ReplayEvent[] = [];
    for (let i = 0; i < 200_000; i++) {
      events.push(
        ev(i * 2, "annotate/span", { label: "AC", phase: i % 2 === 0 ? "start" : "end" }),
      );
    }
    const groups = buildCoverage(indexEvents(events));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ from: 0, to: 399_998 });
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

  it.each<[string, () => string, string]>([
    [
      "renders an object as JSON, never [object Object]",
      () => displayText({ frames: [1, 2] }),
      '{"frames":[1,2]}',
    ],
    ["renders an absent value as a dash", () => displayText(undefined), "—"],
    ["renders an absent size as a dash", () => formatBytes(undefined), "—"],
    ["names a redaction that has no reason", () => displayText({ redacted: true }), "[redacted]"],
    [
      "names a redaction whose reason is not a string",
      () => displayText({ redacted: true, reason: { kind: "future" } }),
      "[redacted]",
    ],
    [
      "names a redaction whose reason is empty",
      () => displayText({ redacted: true, reason: "" }),
      "[redacted]",
    ],
    [
      "names a redacted size that has no reason",
      () => formatBytes({ redacted: true }),
      "[redacted]",
    ],
  ])("%s", (_label, render, expected) => {
    expect(render()).toBe(expected);
  });
});

/** Enough of a document for the host to build its tab bar and its sections. The
 *  panels under test here render nothing: what is being asserted is the host's
 *  containment, not anyone's markup. */
interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  hidden: boolean;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  children: FakeNode[];
  append: (...nodes: FakeNode[]) => void;
  replaceChildren: (...nodes: FakeNode[]) => void;
  setAttribute: (name: string, value: string) => void;
  addEventListener: () => void;
}

function fakeNode(tagName: string): FakeNode {
  const node: FakeNode = {
    tagName,
    className: "",
    textContent: "",
    hidden: false,
    dataset: {},
    attrs: {},
    children: [],
    append: (...nodes) => node.children.push(...nodes),
    replaceChildren: (...nodes) => {
      node.children = [...nodes];
    },
    setAttribute: (name, value) => {
      node.attrs[name] = value;
    },
    addEventListener: () => undefined,
  };
  return node;
}

function withFakeDocument<T>(run: (make: (tag: string) => FakeNode) => T): T {
  const host = globalThis as { document?: unknown };
  const had = "document" in host;
  const previous = host.document;
  host.document = { createElement: (tag: string) => fakeNode(tag) };
  try {
    return run(fakeNode);
  } finally {
    if (had) host.document = previous;
    else delete host.document;
  }
}

function mountFake(
  panels: readonly PanelDef[],
  events = sampleEvents(),
): { body: FakeNode; tabs: FakeNode; host: PanelHost } {
  const tabs = fakeNode("div");
  const body = fakeNode("div");
  const host = mountPanels({
    tabs: tabs as unknown as HTMLElement,
    body: body as unknown as HTMLElement,
    index: indexEvents(events),
    panels,
    seekTo: () => undefined,
  });
  host.seek(100);
  return { body, tabs, host };
}

describe("panel host", () => {
  it("contains a panel that throws at mount instead of failing the whole open", () => {
    withFakeDocument(() => {
      let healthyMounted = false;
      const boom: PanelDef = {
        id: "boom",
        title: "Boom",
        eventTypes: ["net/request"],
        mount() {
          throw new Error("panel exploded");
        },
      };
      const healthy: PanelDef = {
        id: "healthy",
        title: "Healthy",
        eventTypes: ["console/message"],
        mount() {
          healthyMounted = true;
        },
      };
      const { body } = mountFake([boom, healthy]);
      expect(body.children.map((c) => c.dataset.panelId)).toEqual(["boom", "healthy"]);
      expect(body.children[0]?.dataset.failed).toBe("open");
      expect(healthyMounted).toBe(true);
    });
  });

  it("contains a panel that throws on a seek, and keeps seeking the others", () => {
    withFakeDocument(() => {
      let healthySeeks = 0;
      const boom: PanelDef = {
        id: "boom",
        title: "Boom",
        eventTypes: ["net/request"],
        mount(_container, api) {
          api.onSeek(() => {
            throw new Error("render exploded");
          });
        },
      };
      const healthy: PanelDef = {
        id: "healthy",
        title: "Healthy",
        eventTypes: ["console/message"],
        mount(_container, api) {
          api.onSeek(() => {
            healthySeeks++;
          });
        },
      };
      const { body, host } = mountFake([boom, healthy]);
      expect(body.children[0]?.dataset.failed).toBe("render");
      // A hidden panel is not seeked; selecting it catches it up, and the
      // failure next door does not follow it.
      host.select("healthy");
      expect(healthySeeks).toBe(1);
      host.seek(200);
      expect(healthySeeks).toBe(2);
      expect(body.children[1]?.dataset.failed).toBeUndefined();
    });
  });

  it("hands a panel only the event types it declared", () => {
    withFakeDocument(() => {
      let seen: Record<string, number> = {};
      const nosy: PanelDef = {
        id: "nosy",
        title: "Nosy",
        eventTypes: ["console/message"],
        mount(_container, api) {
          seen = {
            declared: api.events("console/message").length,
            undeclared: api.events("net/response").length,
            windowed: api.events("console/message", { from: 60 }).length,
          };
        },
      };
      mountFake([nosy]);
      expect(seen).toEqual({ declared: 3, undeclared: 0, windowed: 2 });
    });
  });

  it("counts the tab badge on the declared type a panel says to count", () => {
    withFakeDocument(() => {
      const tabs = fakeNode("div");
      const body = fakeNode("div");
      mountPanels({
        tabs: tabs as unknown as HTMLElement,
        body: body as unknown as HTMLElement,
        index: indexEvents(sampleEvents()),
        panels: [
          {
            id: "a",
            title: "A",
            eventTypes: ["net/request", "net/response"],
            mount: () => undefined,
          },
          {
            id: "b",
            title: "B",
            eventTypes: ["net/request", "net/response"],
            countType: "net/request",
            mount: () => undefined,
          },
        ],
        seekTo: () => undefined,
      });
      expect(tabs.children.map((t) => t.dataset.count)).toEqual(["3", "2"]);
    });
  });
});

describe("text matching", () => {
  it("matches case-insensitively over the values a row shows, and an empty needle matches all", () => {
    expect(matchesText("", ["anything"])).toBe(true);
    expect(matchesText("   ", [])).toBe(true);
    expect(matchesText("API/items", ["GET", "https://a.test/api/Items?page=2"])).toBe(true);
    expect(matchesText("post", ["GET", "https://a.test/x"])).toBe(false);
  });

  it("matches a redaction marker on its text, so a reviewer can search for what was taken out", () => {
    const marker = redactedMarker("header");
    expect(matchesText("redacted: header", [marker])).toBe(true);
    expect(matchesText("object", [marker])).toBe(false);
  });

  it("skips an absent value and reads a number or an object as the text it would show", () => {
    expect(matchesText("undefined", [undefined, null])).toBe(false);
    expect(matchesText("404", [404])).toBe(true);
    expect(matchesText("frames", [{ frames: [1] }])).toBe(true);
  });
});

describe("network filter", () => {
  /** Four requests: ok, 404, failed, and one still in flight at the end. */
  function filterRows() {
    return buildNetworkRows(
      indexEvents([
        ev(0, "net/request", {
          requestId: "a",
          request: { url: "https://x.test/api/items", method: "GET" },
          type: "XHR",
        }),
        ev(5, "net/response", { requestId: "a", response: { url: "u", status: 200 } }),
        ev(10, "net/request", {
          requestId: "b",
          request: { url: "https://x.test/api/missing", method: "GET" },
          type: "Fetch",
        }),
        ev(15, "net/response", { requestId: "b", response: { url: "u", status: 404 } }),
        ev(20, "net/request", {
          requestId: "c",
          request: { url: "https://x.test/img.png", method: "GET" },
          type: "Image",
        }),
        ev(25, "net/failed", { requestId: "c", errorText: "net::ERR_ABORTED" }),
        ev(30, "net/request", {
          requestId: "d",
          request: { url: "https://x.test/api/slow", method: "POST" },
          type: "Fetch",
        }),
      ]),
    );
  }

  it("gives every row a key that is its position, so a repeated request id stays distinct", () => {
    const rows = buildNetworkRows(
      indexEvents([
        ev(0, "net/request", { requestId: "same", request: { url: "u1", method: "GET" } }),
        ev(5, "net/request", { requestId: "same", request: { url: "u2", method: "GET" } }),
      ]),
    );
    expect(rows.map((r) => r.key)).toEqual(["0", "1"]);
  });

  it("filters by text over the method, url, status and type a row shows", () => {
    const rows = filterRows();
    const urls = (text: string) =>
      resolveNetwork(rows, 100, 300, { text, state: "all" }).rows.map((r) => r.requestId);
    expect(urls("api/")).toEqual(["a", "b", "d"]);
    expect(urls("POST")).toEqual(["d"]);
    expect(urls("image")).toEqual(["c"]);
    expect(urls("404")).toEqual(["b"]);
    expect(urls("aborted")).toEqual(["c"]);
    expect(urls("in flight")).toEqual(["d"]);
    expect(urls("nothing like this")).toEqual([]);
  });

  it("filters by the status class a row is in at the playhead", () => {
    const rows = filterRows();
    const ids = (state: "all" | "pending" | "ok" | "error" | "failed", t = 100) =>
      resolveNetwork(rows, t, 300, { text: "", state }).rows.map((r) => r.requestId);
    expect(ids("ok")).toEqual(["a"]);
    expect(ids("error")).toEqual(["b"]);
    expect(ids("failed")).toEqual(["c"]);
    expect(ids("pending")).toEqual(["d"]);
    // At t=12 the 404 had not arrived, so the request is in flight, not an error.
    expect(ids("error", 12)).toEqual([]);
    expect(ids("pending", 12)).toEqual(["b"]);
  });

  it("does not match text the playhead has not reached", () => {
    const rows = filterRows();
    // The failure text arrives at 25. At 22 the request is in flight.
    expect(resolveNetwork(rows, 22, 300, { text: "aborted", state: "all" }).rows).toEqual([]);
    expect(resolveNetwork(rows, 25, 300, { text: "aborted", state: "all" }).rows).toHaveLength(1);
  });

  it("windows over the rows that match, so a filter reaches past the newest rows", () => {
    const many: ReplayEvent[] = [];
    for (let i = 0; i < 500; i++) {
      many.push(
        ev(i, "net/request", {
          requestId: String(i),
          request: {
            url: i % 100 === 0 ? `https://x.test/rare/${i}` : `https://x.test/common/${i}`,
            method: "GET",
          },
        }),
      );
    }
    const rows = buildNetworkRows(indexEvents(many));
    const unfiltered = resolveNetwork(rows, 499);
    expect(unfiltered).toMatchObject({ hidden: 200, total: 500, matched: 500 });
    const rare = resolveNetwork(rows, 499, 300, { text: "rare", state: "all" });
    expect(rare.rows.map((r) => r.requestId)).toEqual(["0", "100", "200", "300", "400"]);
    expect(rare).toMatchObject({ hidden: 0, total: 500, matched: 5 });
    const capped = resolveNetwork(rows, 499, 2, { text: "rare", state: "all" });
    expect(capped.rows.map((r) => r.requestId)).toEqual(["300", "400"]);
    expect(capped).toMatchObject({ hidden: 3, matched: 5 });
  });

  it("says how many rows match, and how many there are, in the count line", () => {
    const rows = filterRows();
    expect(statusLine(resolveNetwork(rows, 100), NO_NET_FILTER)).toBe("4 requests");
    expect(statusLine(resolveNetwork(rows, 0), NO_NET_FILTER)).toBe("1 request");
    const filter = { text: "api/", state: "all" as const };
    expect(statusLine(resolveNetwork(rows, 100, 300, filter), filter)).toBe(
      "3 of 4 requests match",
    );
  });

  it("matches a view the same way the resolver does", () => {
    const view = resolveNetwork(filterRows(), 100).rows[0]!;
    expect(netViewMatches(view, NO_NET_FILTER)).toBe(true);
    expect(netViewMatches(view, { text: "items", state: "ok" })).toBe(true);
    expect(netViewMatches(view, { text: "items", state: "error" })).toBe(false);
  });
});

describe("network details", () => {
  const request = ev(10, "net/request", {
    requestId: "1",
    request: {
      url: "https://a.test/api/save",
      method: "POST",
      headers: { "X-Trace": "t-1", Authorization: redactedMarker("header") },
      postData: '{"name":"ada"}',
    },
    type: "Fetch",
  });
  const response = ev(40, "net/response", {
    requestId: "1",
    response: {
      url: "https://a.test/api/save",
      status: 201,
      mimeType: "application/json",
      headers: { "content-type": "application/json", "Set-Cookie": redactedMarker("header") },
    },
  });

  const section = (id: string, sections: ReturnType<typeof networkDetail>) =>
    sections.find((s) => s.id === id)!;

  it("carries the request, the response, the timing and the headers in sorted order", () => {
    const [row] = buildNetworkRows(indexEvents([request, response]));
    const sections = networkDetail(row!, "replay");
    expect(sections.map((s) => s.id)).toEqual([
      "general",
      "request-headers",
      "request-body",
      "response-headers",
      "response-body",
    ]);
    const general = Object.fromEntries(
      section("general", sections).fields!.map((f) => [f.label, f.text ?? displayText(f.value)]),
    );
    expect(general).toMatchObject({
      URL: "https://a.test/api/save",
      Method: "POST",
      Status: "201",
      "MIME type": "application/json",
      "Started at": "10 ms",
      "Finished at": "40 ms",
      Duration: "30 ms",
    });
    expect(section("request-headers", sections).fields!.map((f) => f.label)).toEqual([
      "Authorization",
      "X-Trace",
    ]);
    expect(section("request-body", sections).text).toBe('{"name":"ada"}');
    expect(section("response-headers", sections).fields!.map((f) => f.label)).toEqual([
      "content-type",
      "Set-Cookie",
    ]);
  });

  it("keeps a header that was taken out as the marker, never as a blank or an object", () => {
    const [row] = buildNetworkRows(indexEvents([request, response]));
    const auth = section("request-headers", networkDetail(row!)).fields!.find(
      (f) => f.label === "Authorization",
    );
    expect(displayText(auth?.value)).toBe("[redacted: header]");
  });

  it("says a body was not captured at a tier that never records one", () => {
    const [row] = buildNetworkRows(indexEvents([request, response]));
    for (const tier of ["replay", "actions", undefined] as const) {
      const body = section("response-body", networkDetail(row!, tier));
      expect(body.text).toBeUndefined();
      expect(body.empty).toBe(bodyGap(tier));
      expect(body.empty).toContain("Not captured at this tier");
    }
  });

  it("tells a body missing at the body tier from a body the tier never records", () => {
    const [row] = buildNetworkRows(indexEvents([request, response]));
    expect(section("response-body", networkDetail(row!, "reexecutable")).empty).toBe(
      "No body was recorded for this response.",
    );
  });

  it("shows a body the log carries, and a redacted one as its marker", () => {
    const withBody = (body: unknown) =>
      buildNetworkRows(
        indexEvents([request, { ...response, payload: { ...(response.payload as object), body } }]),
      )[0]!;
    expect(
      section("response-body", networkDetail(withBody('{"ok":true}'), "reexecutable")).text,
    ).toBe('{"ok":true}');
    const dropped = section(
      "response-body",
      networkDetail(withBody(redactedMarker("body-rule")), "reexecutable"),
    );
    expect(displayText(dropped.text)).toBe("[redacted: body-rule]");
  });

  it("names the gap for a request with no response, and for one with no body or headers", () => {
    const [row] = buildNetworkRows(
      indexEvents([ev(5, "net/request", { requestId: "9", request: { url: "u", method: "GET" } })]),
    );
    const sections = networkDetail(row!, "replay");
    const general = section("general", sections).fields!;
    expect(general.find((f) => f.label === "Status")?.text).toBe("no response recorded");
    expect(general.find((f) => f.label === "Finished at")?.text).toBe("not recorded");
    expect(section("request-headers", sections).empty).toBe("No request headers recorded.");
    expect(section("request-body", sections).empty).toBe("No request body.");
    expect(section("response-headers", sections).empty).toBe("No response recorded.");
    expect(section("response-body", sections).empty).toBe("No response recorded.");
  });

  it("reads a failed request as its error text", () => {
    const [row] = buildNetworkRows(
      indexEvents([
        ev(5, "net/request", { requestId: "9", request: { url: "u", method: "GET" } }),
        ev(8, "net/failed", { requestId: "9", errorText: "net::ERR_ABORTED" }),
      ]),
    );
    const status = section("general", networkDetail(row!)).fields!.find(
      (f) => f.label === "Status",
    );
    expect(status?.text).toBe("failed: net::ERR_ABORTED");
  });

  it("cuts a very long block at the display cap and says how much it left out", () => {
    const long = "x".repeat(MAX_DETAIL_CHARS + 25);
    expect(blockText(long)).toEqual({ text: "x".repeat(MAX_DETAIL_CHARS), cut: 25 });
    expect(blockText("short")).toEqual({ text: "short", cut: 0 });
  });
});

describe("console filter and details", () => {
  it("filters by message text and by the level label a row shows, with the level filter", () => {
    const rows = buildConsoleRows(
      indexEvents([
        ev(10, "console/message", { type: "log", text: "loaded cart" }),
        ev(20, "console/message", { type: "warning", text: "slow cart render" }),
        ev(30, "console/message", { type: "error", text: "cart failed" }),
        ev(40, "page/error", { text: "Uncaught ReferenceError", stack: "at app.js:1" }),
      ]),
    );
    expect(rows.map((r) => r.key)).toEqual(["0", "1", "2", "3"]);
    const texts = (text: string, level: "debug" | "warn" | "error" = "debug") =>
      resolveConsole(rows, 100, level, 400, text).rows.map((r) => r.t);
    expect(texts("cart")).toEqual([10, 20, 30]);
    expect(texts("CART", "warn")).toEqual([20, 30]);
    expect(texts("page error")).toEqual([40]);
    expect(texts("referenceerror")).toEqual([40]);
    expect(texts("absent")).toEqual([]);
    // The playhead still gates the text filter.
    expect(resolveConsole(rows, 15, "debug", 400, "cart").rows.map((r) => r.t)).toEqual([10]);
  });

  it("labels a row the way its level cell does", () => {
    const rows = buildConsoleRows(
      indexEvents([
        ev(0, "console/message", { type: "timeEnd", text: "t" }),
        ev(1, "console/message", { type: "warning", text: "w" }),
        ev(2, "page/error", { text: "boom" }),
      ]),
    );
    expect(rows.map(levelLabel)).toEqual(["timeEnd", "warn", "page error"]);
  });

  it("shows the whole message, and a page error's stack or the lack of one", () => {
    const long = "m".repeat(500);
    const rows = buildConsoleRows(
      indexEvents([
        ev(1, "console/message", { type: "error", text: long }),
        ev(2, "page/error", { text: "boom", stack: "at a\nat b" }),
        ev(3, "page/error", { text: "no stack" }),
      ]),
    );
    const log = consoleDetail(rows[0]!);
    expect(log.map((s) => s.id)).toEqual(["general", "message"]);
    expect(log[1]?.text).toBe(long);
    const withStack = consoleDetail(rows[1]!);
    expect(withStack.map((s) => s.id)).toEqual(["general", "message", "stack"]);
    expect(withStack[2]?.text).toBe("at a\nat b");
    expect(consoleDetail(rows[2]!)[2]).toMatchObject({ empty: "No stack trace recorded." });
  });
});

describe("registered secrets in the panels", () => {
  const SECRET = "s3cr3t-value-0xDEADBEEF";

  /** A log written through the real capture adapters with a registered secret, so
   *  the masking is the shipped masking and the panels see what an archive holds.
   *  The response carries a body, which only the reexecutable tier records and is
   *  the widest thing a panel can show. */
  function maskedLog(): ReplayEvent[] {
    const registry = new SecretRegistry();
    registry.register({ name: "TOKEN", value: SECRET });
    const ctx = { clock: createClock(0), redact: new Redactor({ secrets: registry }) };
    return [
      netRequestEvent(
        ctx,
        {
          requestId: "1",
          request: {
            url: `https://a.test/api?token=${SECRET}`,
            method: "POST",
            headers: { "x-api-key": SECRET, "content-type": "application/json" },
            postData: JSON.stringify({ token: SECRET }),
          },
          type: "Fetch",
        },
        10,
      ),
      netResponseEvent(
        ctx,
        {
          requestId: "1",
          response: {
            url: `https://a.test/api?token=${SECRET}`,
            status: 200,
            headers: { "x-echo": SECRET },
          },
        },
        { body: JSON.stringify({ echo: SECRET }), wallMs: 20 },
      ),
      netRequestEvent(
        ctx,
        { requestId: "2", request: { url: "https://a.test/b", method: "GET" } },
        30,
      ),
      netFailedEvent(ctx, { requestId: "2", errorText: `refused ${SECRET}` }, 40),
      consoleMessageEvent(ctx, { type: "log", text: `signed in with ${SECRET}` }, 50),
      pageErrorEvent(ctx, { text: `bad ${SECRET}`, stack: `at login (${SECRET})` }, 60),
    ];
  }

  it("never appears in any row, any detail, or anything a filter can match", () => {
    const index = indexEvents(maskedLog());
    const netRows = buildNetworkRows(index);
    const consoleRows = buildConsoleRows(index);

    const everything = JSON.stringify({
      network: resolveNetwork(netRows, 1000).rows,
      networkDetails: netRows.map((r) => networkDetail(r, "reexecutable")),
      console: resolveConsole(consoleRows, 1000).rows,
      consoleDetails: consoleRows.map((r) => consoleDetail(r)),
    });
    expect(everything).not.toContain(SECRET);
    expect(everything).toContain("<TOKEN>");

    // A filter cannot find a value that was never stored.
    expect(resolveNetwork(netRows, 1000, 300, { text: SECRET, state: "all" }).rows).toEqual([]);
    expect(resolveConsole(consoleRows, 1000, "debug", 400, SECRET).rows).toEqual([]);
    // It finds the mask that stands in for it.
    expect(resolveConsole(consoleRows, 1000, "debug", 400, "<TOKEN>").rows).toHaveLength(2);
    // One network row: the failed request's error text. The first request's
    // URL is recorded without its query string, so the mask is not in it.
    expect(resolveNetwork(netRows, 1000, 300, { text: "<TOKEN>", state: "all" }).rows).toHaveLength(
      1,
    );
  });
});

describe("panel host tier", () => {
  it("hands a panel the manifest tier, and leaves it unset when the host does not know it", () => {
    withFakeDocument(() => {
      const seen: (string | undefined)[] = [];
      const probe: PanelDef = {
        id: "probe",
        title: "Probe",
        eventTypes: [],
        mount(_container, api) {
          seen.push(api.tier);
        },
      };
      const tabs = fakeNode("div");
      const body = fakeNode("div");
      const base = {
        tabs: tabs as unknown as HTMLElement,
        body: body as unknown as HTMLElement,
        index: indexEvents(sampleEvents()),
        panels: [probe],
        seekTo: () => undefined,
      };
      mountPanels(base);
      mountPanels({ ...base, tier: "actions" });
      expect(seen).toEqual([undefined, "actions"]);
    });
  });
});
