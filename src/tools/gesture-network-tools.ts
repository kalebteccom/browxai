import type { ToolHost } from "./host.js";
import { registerGestureCoordTools } from "./gesture-coord-tools.js";
import { registerGestureRouteTools } from "./gesture-route-tools.js";
import { registerGestureWebsocketTools } from "./gesture-websocket-tools.js";
import { registerGestureWorkerTools } from "./gesture-worker-tools.js";
import { registerGestureEmulationTools } from "./gesture-emulation-tools.js";

/**
 * Coordinate-space gestures (mouse_wheel / gesture_pinch / gesture_swipe),
 * route mocking (route / route_queue / unroute), interactive WebSocket
 * primitives (ws_send / ws_intercept / ws_unintercept), worker visibility
 * (workers_list / worker_message_send / worker_messages_read /
 * sw_intercept_fetch / sw_unintercept_fetch), and live network/CPU emulation
 * (network_emulate / cpu_emulate).
 *
 * RFC 0004 P3 / D3 (SRP): the registrations were split by cohesive family into
 * five sibling modules (coord / route / websocket / worker / emulation). This
 * module stays the single entry point `server.ts` + `tool-metadata.ts` call, and
 * invokes each family in the EXACT prior source order so the registered-name set
 * + the derived maps stay byte-identical. The host owns the closures (gate,
 * engine-gate, entry); the family modules own the registrations.
 */
export function registerGestureNetworkTools(host: ToolHost): void {
  registerGestureCoordTools(host);
  registerGestureRouteTools(host);
  registerGestureWebsocketTools(host);
  registerGestureWorkerTools(host);
  registerGestureEmulationTools(host);
}
