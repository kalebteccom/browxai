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
        'Bind a name you choose to a ref, so later calls can pass `named: "<name>"` in place of `ref` or `selector`. Refs are keyed by element, so the binding survives snapshots and navigation while the element exists. If the element is gone the name stops resolving: call `find` or `snapshot` and bind it again. List bindings with `list_named_refs`. Per-session.',
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
      description: "List this session's current name to ref bindings created with `name_ref`.",
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
        "Record which candidate was the right answer to an earlier `find(query)`. Later finds with an overlapping query rank candidates with that identity (testId, or role and name) higher. Per-session, in memory, capped at 100 entries (least recently used dropped).",
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
                {
                  ok: false,
                  error: `unknown ref "${ref}". Refs reset when the page changes: call snapshot() or find() for fresh ones.`,
                },
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
