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
        "Session-wide ring buffer of recent network requests (500 most recent; oldest evicted on overflow). For per-action attribution use `ActionResult.network` from any action tool — that's the primary surface. This is the 'what happened across the session' view; useful when an XHR isn't tied to a specific action you just ran. Noise types (Image/Font/Stylesheet/Media/beacons) folded into `summary.byType.other`.",
      inputSchema: { limit: z.number().int().positive().max(500).optional(), ...SESSION_ARG },
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
        "fetch a full response body by `requestId` (from `network_read` / `ActionResult.network.requests[].requestId`). **Gated behind the off-by-default `network-body` capability** — full bodies can carry PII / auth tokens; 's `responseShape` (keys only) is the safe default. Bounded (256 KB, `truncated:true` past that). Best-effort: the renderer discards bodies fast — fetch right after the request, not retained across navigations. Pairs with for realtime payload assertions.",
      inputSchema: {
        requestId: z
          .string()
          .describe(
            "CDP request id from network_read / ActionResult.network.requests[].requestId.",
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
        "session-wide ring of recent WebSocket / Server-Sent-Events frames (HTTP is `network_read`; this is the realtime channel). Each frame: `{ url, dir: sent|recv, kind: ws|sse, opcode?, event?, payload, truncated?, ts }`. Payloads are truncated. Use to verify realtime correctness — chat/multiplayer/collaborative/live-dashboard broadcasts. Per-action frames also land in `ActionResult.network.wsFrames`; this is the across-session view.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe("Most-recent N frames (default 50)."),
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
