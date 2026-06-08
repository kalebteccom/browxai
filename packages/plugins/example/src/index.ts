// @kalebtec/browxai-plugin-example — the canonical reference plugin.
//
// Exercises every primitive of the v1 plugin-runtime contract:
//   - `register(api)` entry point as a named export.
//   - Three tools, all under the declared namespace `example.`.
//   - No declared capabilities (the simplest case — runs on a server
//     with the default capability set).
//   - Empty `dependsOn` (no inter-plugin composition).
//
// Plugin authors: copy this layout, change `package.json#browxai`,
// add your own tools in `register(api)`. See `docs/plugin-authoring.md`.
//
// The `PluginApi` shape is documented in the host's plugin-authoring
// guide. We inline a minimal type here so the plugin doesn't import
// from a host-internal module — once `@kalebtec/browxai-plugin-types`
// ships, plugins will import the interface from there.

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ToolResponse {
  readonly content: ReadonlyArray<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
}

interface PluginApi {
  readonly namespace: string;
  readonly declaredCapabilities: ReadonlyArray<string>;
  registerTool(
    name: string,
    def: { description: string; inputSchema?: Record<string, any> | undefined },
    handler: (args: unknown) => Promise<ToolResponse>,
  ): void;
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolResponse>;
  log: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
}

const json = (obj: unknown): ToolResponse => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});

/**
 * Build the per-tool handlers as plain functions so the plugin's
 * unit-test suite can exercise them WITHOUT spinning up the full
 * runtime — the test file imports these directly.
 */
export const handlers = {
  /** `example.echo({ msg })` → `{ ok: true, result: msg }`. The
   *  classic round-trip primitive — used by the keystone to assert
   *  end-to-end MCP dispatch through the plugin runtime. */
  async echo(args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as { msg?: unknown };
    const msg = typeof a.msg === "string" ? a.msg : "";
    return json({ ok: true, result: msg });
  },

  /** `example.add({ a, b })` → `{ ok: true, sum: a + b }`. Trivial
   *  math primitive — demonstrates the handler's typed-arg pattern. */
  async add(args: unknown): Promise<ToolResponse> {
    const a = (args ?? {}) as { a?: unknown; b?: unknown };
    const left = typeof a.a === "number" ? a.a : 0;
    const right = typeof a.b === "number" ? a.b : 0;
    return json({ ok: true, sum: left + right });
  },

  /** `example.now()` → `{ ok: true, iso, epochMs }`. Argless tool
   *  shape; demonstrates that an empty input schema is fine. */
  async now(): Promise<ToolResponse> {
    const ms = Date.now();
    return json({ ok: true, iso: new Date(ms).toISOString(), epochMs: ms });
  },
};

/**
 * Plugin entry. The runtime imports this module via
 * `await import(<entryPath>)` and calls `register(api)`. The named
 * export takes precedence over a default export.
 */
export function register(api: PluginApi): void {
  api.log.info("example plugin: registering tools", { namespace: api.namespace });

  // Tool names MUST be prefixed with the plugin's namespace. The
  // runtime throws synchronously if a registration violates this.
  // The Zod schema is the same shape host tools use; the plugin
  // doesn't have to import Zod itself if the inputSchema is an
  // empty object — the schema is consulted by MCP's `tools/list` and
  // is purely informational at the plugin layer.
  api.registerTool(
    `${api.namespace}.echo`,
    {
      description:
        "Round-trip primitive — returns whatever `msg` was passed. Useful for proving the plugin runtime is reachable end-to-end (keystone uses this).",
      inputSchema: {},
    },
    handlers.echo,
  );

  api.registerTool(
    `${api.namespace}.add`,
    {
      description:
        "Sums two numeric args. Trivial demonstration of the handler's typed-arg pattern.",
      inputSchema: {},
    },
    handlers.add,
  );

  api.registerTool(
    `${api.namespace}.now`,
    {
      description: "Returns the current ISO timestamp + epoch milliseconds. No args.",
      inputSchema: {},
    },
    handlers.now,
  );
}

// Also export as default for the "default export is the register fn"
// alternative loading path (the runtime accepts either).
export default register;
