import { runBatch } from "../util/batch.js";
import { log } from "../util/logging.js";
import { SESSION_ARG } from "./schemas.js";
import type { RegisterHost, GateHost, SessionHost, ServerServicesHost } from "./host.js";

/** Build the DevTools-prompt body for an `await_human` call. Extracting the
 *  four-way kind dispatch into a pure helper keeps the handler under the
 *  complexity budget (RFC 0004 P3 / D3) — byte-identical to the prior inline
 *  ternary chain. */
function buildAwaitHumanPrompt(
  kind: string,
  prompt: string,
  choices: string[] | undefined,
): string {
  if (kind === "choose" && choices) {
    return `${prompt}\n${choices.map((c: string, i: number) => `    [${i}] ${c}`).join("\n")}\n→ call __browx.choose(<index>) in DevTools to respond`;
  }
  if (kind === "confirm") return `${prompt} → call __browx.confirm(true|false)`;
  if (kind === "input") return `${prompt} → call __browx.input('your text')`;
  return `${prompt} → call __browx.proceed() to release`;
}

/**
 * Human-in-the-loop + batch protocol primitives: await_human / batch. Split out of
 * `extensions-batch-tools` by cohesive family (RFC 0004 P3 / D3 SRP); registered
 * through the shared `ToolHost` seam in the same source order. The host owns the
 * closures; this module owns the registrations.
 */
export function registerBatchHumanTools(
  host: RegisterHost & GateHost & SessionHost & ServerServicesHost,
): void {
  const {
    z,
    register,
    gateCheck,
    entryFor,
    toolHandlers,
    batchAllowedTools: BATCH_ALLOWED_TOOLS,
  } = host;

  // ---------- human↔agent helper ----------

  register(
    "await_human",
    {
      capability: "human",
      description:
        "Block until the human responds in the page. Operator reads `prompt` from the server's stderr (or a future banner UI) and triggers a response from DevTools:\n" +
        "  - `acknowledge` → `__browx.proceed()` (or `signal('proceed')`)\n" +
        "  - `confirm`     → `__browx.confirm(true|false)`\n" +
        "  - `choose`      → `__browx.choose(<index-into-choices>)`\n" +
        "  - `input`       → `__browx.input('typed text')`\n" +
        "Returns `{ kind, value, timedOut }`. `pick_element` kind (in-page hover-pick overlay) is deferred to .",
      inputSchema: {
        kind: z.enum(["acknowledge", "confirm", "choose", "input"]).default("acknowledge"),
        prompt: z
          .string()
          .describe("Human-readable instruction shown to the operator (logged to stderr)."),
        choices: z
          .array(z.string())
          .optional()
          .describe(
            'For `kind:"choose"` — labels shown in the prompt; the human responds with an index into this list.',
          ),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(3_600_000)
          .optional()
          .describe(
            "Human response window (ms). Human-paced default 300000 (5min); hard max 3600000 (1h). " +
              "there is no infinite wait — an unanswered prompt times out (the only previously " +
              "unbounded path). For unattended runs use `approve_actions` instead of a long wait.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ kind, prompt, choices, timeoutMs, session }) => {
      const g = gateCheck("await_human");
      if (g) return g;
      const e = await entryFor(session);
      // kill the only infinite path. 0/unset → 5min human-paced default,
      // hard-capped at 1h. await_human is human-paced — NOT under the 5s
      // action default — but never unbounded.
      const humanMs = Math.min(timeoutMs && timeoutMs > 0 ? timeoutMs : 300_000, 3_600_000);
      const promptBody = buildAwaitHumanPrompt(kind, prompt, choices);
      log.info(`await_human (${kind}): ${promptBody}`);
      const signalName = kind === "acknowledge" ? "proceed" : "respond";
      try {
        const sig = await e.bridge.awaitSignal(signalName, humanMs);
        // For typed kinds the page sends `{ kind, value }`; for acknowledge it sends any/null.
        let value: unknown = sig.data;
        if (
          kind !== "acknowledge" &&
          sig.data &&
          typeof sig.data === "object" &&
          "value" in (sig.data as Record<string, unknown>)
        ) {
          value = (sig.data as { value: unknown }).value;
        }
        return {
          content: [
            { type: "text", text: JSON.stringify({ kind, value, timedOut: false }, null, 2) },
          ],
        };
      } catch (e) {
        const timedOut = e instanceof Error && e.message.includes("timed out");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  kind,
                  value: null,
                  timedOut,
                  error: timedOut ? undefined : e instanceof Error ? e.message : String(e),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // ---------- batch protocol primitive ----------

  const BATCH_MAX_CALLS = 32;

  register(
    "batch",
    {
      description:
        "Run a sequence of tool calls server-side and return their results as one response. Eliminates round-trip overhead for known-safe sequences (e.g. fill several fields then submit). Each call is dispatched through the same handlers as a top-level call; capability gating, confirmation hooks, and ActionResults are unchanged. Stops at the first failure unless `stopOnError: false`. Disallows nested `batch` and human-blocking tools.",
      inputSchema: {
        calls: z
          .array(
            z.object({
              tool: z.string().describe("Tool name (must be in the batch whitelist)"),
              args: z
                .record(z.unknown())
                .optional()
                .describe("Args for the inner tool, same shape as a top-level call"),
              label: z
                .string()
                .optional()
                .describe("opaque label echoed in the result entry for cross-referencing"),
              expect: z
                .object({
                  valueEquals: z.string().optional(),
                  displayTextIncludes: z.string().optional(),
                  controlDisplayTextIncludes: z.string().optional(),
                  containerTextIncludes: z.string().optional(),
                  controlChanged: z.boolean().optional(),
                })
                .optional()
                .describe(
                  "optional post-call assertions on the inner ActionResult's element probe. Failing any assertion marks the call ok=false with `error: 'expect failed: …'` and respects `stopOnError`.",
                ),
            }),
          )
          .min(1)
          .max(BATCH_MAX_CALLS)
          .describe(`Up to ${BATCH_MAX_CALLS} inner calls. Run sequentially.`),
        stopOnError: z
          .boolean()
          .optional()
          .describe(
            "Default true. When true, the first inner-call failure halts the batch. When false, every call is attempted and individual results carry their own ok/error.",
          ),
      },
    },
    async ({
      calls,
      stopOnError,
    }: {
      calls: Array<{
        tool: string;
        args?: Record<string, unknown>;
        label?: string;
        expect?: import("../util/batch.js").BatchExpect;
      }>;
      stopOnError?: boolean;
    }) => {
      const g = gateCheck("batch");
      if (g) return g;
      const report = await runBatch(calls, {
        allowed: BATCH_ALLOWED_TOOLS,
        handlers: toolHandlers,
        stopOnError,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }],
      };
    },
  );
}
