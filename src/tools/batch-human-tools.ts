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
  answerHint: (devtoolsCall: string) => string,
  ticket: string,
): string {
  if (kind === "choose" && choices) {
    return `${prompt}\n${choices.map((c: string, i: number) => `    [${i}] ${c}`).join("\n")}\n→ ${answerHint(`__browx.choose(<index>, "${ticket}")`)}`;
  }
  if (kind === "confirm")
    return `${prompt} → ${answerHint(`__browx.confirm(true|false, "${ticket}")`)}`;
  if (kind === "input")
    return `${prompt} → ${answerHint(`__browx.input('your text', "${ticket}")`)}`;
  return `${prompt} → ${answerHint(`__browx.proceed("${ticket}")`)}`;
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
        "Ask the human a question and block until they answer: acknowledge, confirm, choose or input. Use it when a person must act (log in, clear a captcha, decide); for unattended runs use `approve_actions` instead of a long wait. The operator reads `prompt` on the server's stderr and answers from DevTools, in the `browxai-<random>` console context the prompt names (an isolated world that page scripts and extensions cannot reach; the page's own `window.__browx` is display-only):\n  - `acknowledge`: `__browx.proceed(ticket)`\n  - `confirm`: `__browx.confirm(true|false, ticket)`\n  - `choose`: `__browx.choose(<index-into-choices>, ticket)`\n  - `input`: `__browx.input('typed text', ticket)`\nThe world name and the per-prompt `ticket` are printed with the prompt; an answer without the current ticket is dropped. With the `operator-channel` capability (off by default) and a socket, the prompt goes to the host daemon on that socket, only the daemon's answer counts, and DevTools answers are ignored. An unanswered prompt is denied at its timeout; an operator abort returns an `error` starting `operator-aborted`. Returns `{ kind, value, timedOut }`. On engines without CDP (firefox, webkit, safari, the native engines) there is no isolated world, so it returns at once with an `error` starting `no-human-channel`.",
      inputSchema: {
        kind: z
          .enum(["acknowledge", "confirm", "choose", "input"])
          .default("acknowledge")
          .describe(
            "Prompt type: `acknowledge` (default), `confirm`, `choose` (needs `choices`) or `input`.",
          ),
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
            "Human response window in ms (default 300000, max 3600000). An unanswered prompt is denied at the timeout; there is no unbounded wait.",
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
      const ticket = e.bridge.newTicket();
      const promptBody = buildAwaitHumanPrompt(
        kind,
        prompt,
        choices,
        (call) => e.bridge.answerHint(call),
        ticket,
      );
      log.info(`await_human (${kind}): ${promptBody}`);
      const signalName = kind === "acknowledge" ? "proceed" : "respond";
      try {
        const sig = await e.bridge.awaitSignal(signalName, humanMs, ticket, {
          kind: "human",
          humanKind: kind,
          prompt,
          ...(kind === "choose" && choices ? { choices } : {}),
        });
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
        "Run up to 32 tool calls in order on the server and return all results in one response, to save round trips on a known sequence (fill several fields, then submit). Use `fill_form` for form fields only, and `flake_check` to repeat a sequence. Each call goes through the same handler as a top-level call, so capability gates, confirm hooks and ActionResults are unchanged. Only batchable tools run; a call naming any other tool returns an error naming it. `batch` itself, `await_human` and recording tools cannot be inner calls. Stops at the first failure unless `stopOnError:false`.",
      inputSchema: {
        calls: z
          .array(
            z.object({
              tool: z.string().describe("Tool name (must be in the batch whitelist)"),
              args: z
                .record(z.string(), z.unknown())
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
