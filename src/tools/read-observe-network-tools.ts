// Read / observe — the network + WebSocket ring reads.
//
// `network_read` and `ws_read` serve the session-wide rings the network
// substrate attached at session creation; `network_body` fetches one full
// response body through the same substrate. Split out of
// `read-observe-buffer-tools.ts`, which was at the 450-line ceiling, along the
// reason-to-change all three share and the console read does not: they need the
// engine to observe protocol-level network, and an engine that cannot must
// REFUSE rather than serve an empty ring.
//
// THE GATE IS THE POINT. Safari declares no `network` sub-interface — real
// Safari has no protocol-level network tap at all, so `SafariNoopNetworkSubstrate`
// answers with empty rings. Without the gate, `network_read` on a Safari session
// returned `{summary:{total:0,…}, requests:[]}`: a well-formed, plausible "no
// traffic occurred" for a question the engine cannot answer. That is the same
// defect the `verify_*` family had (an engine incapability rendered as a
// product-shaped result), and it is worse here, because the answer feeds a
// QA-evidence bundle a human signs off on and nothing in it says the check never
// ran. `subInterfaceGate(tool, "network", e)` returns the structured refusal
// instead — `{ok:false, error, engine, hint}`, no `requests` key to misread.
// (RFC 0004 D5; RFC 0009.)

import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/** Register the three network-observation tools. */
export function registerReadObserveNetworkTools(host: ToolHost): void {
  const { z, register, gateCheck, subInterfaceGate, entryFor, caps } = host;

  register(
    "network_read",
    {
      capability: "read",
      batchable: true,
      description:
        "Read the session's recent network requests from a ring buffer (the 500 most recent; older ones drop off). Use `ActionResult.network` for what one action caused, and this for requests not tied to an action you just ran. Image, font, stylesheet, media and beacon traffic is folded into `summary.byType.other`. Bodies need `network_body`.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Most recent N requests to return (default 50, max 500)."),
        ...SESSION_ARG,
      },
    },
    async ({ limit, session }) => {
      const g = gateCheck("network_read");
      if (g) return g;
      const e = await entryFor(session);
      const sg = subInterfaceGate("network_read", "network", e);
      if (sg) return sg;
      const result = e.network.recent(limit ?? 50);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );

  register(
    "network_body",
    {
      capability: "network-body",
      batchable: true,
      description:
        "Fetch one response body by `requestId` (from `network_read` or `ActionResult.network.requests[].requestId`). Requires the `network-body` capability (off by default): bodies can hold personal data and tokens, and `ActionResult.network.mutations[].responseShape` (top-level keys only) is the safe default. Capped at 256 KB: Chromium returns `truncated:true` past that, Firefox and WebKit return `ok:false`. Fetch right after the request, because the renderer drops bodies quickly and they do not survive navigation. For realtime payloads use `ws_read`.",
      inputSchema: {
        requestId: z
          .string()
          .describe(
            "Request id from `network_read` or `ActionResult.network.requests[].requestId`.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ requestId, session }) => {
      const g = gateCheck("network_body");
      if (g) return g;
      const e = await entryFor(session);
      const sg = subInterfaceGate("network_body", "network", e);
      if (sg) return sg;
      // secrets masking: a full response body routinely echoes auth tokens
      // and session blobs. Pass the per-session registry so any registered
      // real-value gets substituted with its alias on egress. Base64 bodies
      // pass through unchanged (the literal scan would never match an
      // encoded form; documented in tool-reference.md as a known limitation).
      // Engine-agnostic via the network substrate: chromium fetches
      // on demand (CDP Network.getResponseBody); firefox/webkit return the body
      // captured at response time into the substrate's bounded recent-window cache.
      const r = await e.networkSubstrate.fetchBody(
        requestId,
        caps.enabled.has("secrets") ? e.secrets : null,
      );
      return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
    },
  );

  register(
    "ws_read",
    {
      capability: "read",
      batchable: true,
      description:
        "Read recent WebSocket and Server-Sent-Events frames from a ring buffer, each `{ url, dir: sent|recv, kind: ws|sse, opcode?, event?, payload, truncated?, ts }` with payloads truncated. Use it to check realtime behaviour (chat, multiplayer, live dashboards); `network_read` covers HTTP. `ActionResult.network.wsFrames` holds the frames from one action.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Most recent N frames to return (default 50, max 500)."),
        urlPattern: z.string().optional().describe("Substring filter on the frame's endpoint URL."),
        ...SESSION_ARG,
      },
    },
    async ({ limit, urlPattern, session }) => {
      const g = gateCheck("ws_read");
      if (g) return g;
      const e = await entryFor(session);
      const sg = subInterfaceGate("ws_read", "network", e);
      if (sg) return sg;
      const result = e.ws.recent(limit ?? 50, urlPattern);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    },
  );
}
