import { SESSION_ARG } from "./schemas.js";
import type { RegisterHost, GateHost, SessionHost, ServerServicesHost } from "./host.js";

/**
 * Named-ref + learned-find-ranking tools: `name_ref` / `list_named_refs` /
 * `find_feedback`. Bind mnemonics to refs and feed the per-session find() ranker.
 * Split out of `forms-recording-tools` (RFC 0004 P3 / D3 SRP); registered through
 * the shared `ToolHost` seam in the same source order.
 */
export function registerFormsRefsTools(
  host: RegisterHost & GateHost & SessionHost & ServerServicesHost,
): void {
  const { z, register, gateCheck, entryFor } = host;

  // ---------- named refs () ----------

  register(
    "name_ref",
    {
      capability: "human",
      batchable: true,
      description:
        'Bind a mnemonic name to a ref. Subsequent action tools accept `named: "<name>"` in place of `ref` / `selector`. Refs are stable across snapshots (by element-key), so the binding survives navigation as long as the element persists. Carry session-wide anchor sets without remembering the bare `eN`s.',
      inputSchema: {
        name: z.string().describe('Mnemonic (e.g. "main_tab", "library_tab")'),
        ref: z.string().describe("The ref to bind to this name"),
        ...SESSION_ARG,
      },
    },
    async ({ name, ref, session }) => {
      const g = gateCheck("name_ref");
      if (g) return g;
      (await entryFor(session)).refs.nameRef(name, ref);
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, name, ref }, null, 2) }],
      };
    },
  );

  register(
    "list_named_refs",
    {
      capability: "read",
      batchable: true,
      description: "List all current name → ref bindings created via name_ref.",
      inputSchema: { ...SESSION_ARG },
    },
    async ({ session }) => {
      const g = gateCheck("list_named_refs");
      if (g) return g;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify((await entryFor(session)).refs.listNames(), null, 2),
          },
        ],
      };
    },
  );

  // ---------- learned find() ranking ----------

  register(
    "find_feedback",
    {
      capability: "human",
      batchable: true,
      description:
        "Tell browxai which candidate was the right answer to a prior `find(query)`. Subsequent finds whose query overlaps the token set will boost candidates matching this winner's identity (testId, or role+name). Session-scoped, in-memory, capped at 100 entries with LRU eviction. The learning is intentionally simple — a 'don't re-do that mistake' signal, not an ML model.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "The query you previously passed to find() (or a paraphrase — token overlap is what matters)",
          ),
        ref: z.string().describe("The ref the agent ended up acting on (the right candidate)"),
        ...SESSION_ARG,
      },
    },
    async ({ query, ref, session }) => {
      const g = gateCheck("find_feedback");
      if (g) return g;
      const e = await entryFor(session);
      const inputs = e.refs.locatorOf(ref);
      if (!inputs) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { ok: false, error: `ref "${ref}" not in the registry` },
                null,
                2,
              ),
            },
          ],
        };
      }
      e.feedback.record(query, {
        testId: inputs.testId,
        testIdAttr: inputs.testIdAttr,
        role: inputs.role,
        name: inputs.name,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ok: true, recorded: { query, identity: inputs }, memorySize: e.feedback.size() },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
