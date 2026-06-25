// Compatibility re-export. The SocketTransport wire primitive moved to the
// neutral `src/transport/` module because it is shared by BOTH the server
// (src/cli/serve.ts) and the SDK client (src/sdk/transport-socket.ts); homing
// it here forced the CLI to reach into the SDK package surface — an ownership
// inversion. This barrel keeps the historical import path intact.

export { SocketTransport } from "../transport/socket-transport.js";
