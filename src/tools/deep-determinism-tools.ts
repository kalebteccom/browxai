import { requireCdp } from "../engine/index.js";
import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { matchesResponse } from "../page/await_network.js";
import { sanitizeUrl } from "../util/url-sanitizer.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Deep tools — determinism injection & compound network waits. `clock` (virtual
 * time), `seed_random` (deterministic Math.random), `act_and_wait_for_network`
 * (one action then a settle-window), and `poll_eval`. Registered through the
 * shared `ToolHost` seam.
 */
export function registerDeepDeterminismTools(host: ToolHost): void {
  const {
    z,
    register,
    gateCheck,
    engineGate,
    entryFor,
    batchAllowedTools: BATCH_ALLOWED_TOOLS,
    toolHandlers,
  } = host;


  register(
    "clock",
    {
      capability: "action",
      batchable: true,
      deep: true,
      description:
        'Control the page\'s virtual clock via CDP `Emulation.setVirtualTimePolicy` — deterministic testing of date-sensitive flows (renewal dates, "today" filters, scheduling, expiry edges) without changing the OS clock. Three modes: `freeze` pauses virtual time at `atIso` (or wall-clock now if omitted); `advance` jumps the clock by `byMs` or to an absolute `atIso`, then re-pins; `release` resumes real time. Per-session; persists across navigation (re-applied on main-frame nav in case CDP drops it). Independent of `network_emulate` / `cpu_emulate` — compose freely. **BYOB:** the policy stays in effect on the attached Chrome until released, reloaded, or closed; a `warning` field surfaces this in `attached` mode.',
      inputSchema: {
        mode: z
          .enum(["freeze", "advance", "release"])
          .describe(
            "freeze: pause virtual time at `atIso` (or now). advance: jump by `byMs` or to `atIso`. release: resume real time.",
          ),
        atIso: z
          .string()
          .optional()
          .describe(
            "ISO-8601 instant. freeze → pin time here; advance → jump to this absolute instant. Mutually exclusive with `byMs` on advance.",
          ),
        byMs: z
          .number()
          .int()
          .positive()
          .max(365 * 24 * 60 * 60 * 1000)
          .optional()
          .describe(
            "Advance only — relative jump in ms (max 1 year). Mutually exclusive with `atIso`.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ mode, atIso, byMs, session }) => {
      const g = gateCheck("clock");
      if (g) return g;
      const e = await entryFor(session);
      const eg = engineGate("clock", e);
      if (eg) return eg;
      try {
        const {
          state,
          mode: appliedMode,
          appliedAtIso,
        } = await e.clock.apply(requireCdp(e.session), e.session.page(), { mode, atIso, byMs });
        const body: Record<string, unknown> = {
          ok: true,
          applied: {
            mode: appliedMode,
            nowIso: appliedAtIso,
            paused: state?.paused ?? false,
          },
        };
        if (e.mode === "attached") {
          body.warning =
            'BYOB / attached Chrome: this virtual-clock policy stays in effect on the attached browser even after browxai detaches — release it (mode:"release"), reload, or close the page when you\'re done. A page with a frozen wall clock is a debugging trap.';
        }
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      }
    },
  );

  register(
    "seed_random",
    {
      capability: "action",
      batchable: true,
      description:
        "Override the page's `Math.random` with a deterministic Mulberry32 PRNG seeded from `seed`. For flake-repros where unseeded randomness drives id generation, dice / card / A-B picks, or jittered retry timing. Injected via Playwright `addInitScript`, so every new document in the session — including subsequent navigations — bootstraps the same override; the current page's main realm is re-seeded immediately so the effect is visible without navigating. Per-session; persists across navigation (re-applied on main-frame `framenavigated` for symmetry with `network_emulate` / `clock`). **MVP scope:** only `Math.random` is overridden — `crypto.randomUUID` / `crypto.getRandomValues` are NOT touched (web-crypto is a much bigger deterministic-stub surface; revisit later). Workers are out of scope (the init script runs in document realms, not worker realms). **BYOB:** the override is installed on the attached Chrome's context for as long as the context lives; surfaced as a `warning` in `attached` session mode.",
      inputSchema: {
        seed: z
          .number()
          .int()
          .min(0)
          .max(0xffffffff)
          .describe(
            "Non-negative integer in [0, 2^32 - 1]. The Mulberry32 state domain — 0 is valid.",
          ),
        ...SESSION_ARG,
      },
    },
    async ({ seed, session }) => {
      const g = gateCheck("seed_random");
      if (g) return g;
      const e = await entryFor(session);
      try {
        const { state } = await e.seededRandom.apply(e.session.page().context(), e.session.page(), {
          seed,
        });
        const body: Record<string, unknown> = { ok: true, applied: state };
        if (e.mode === "attached") {
          body.warning =
            "BYOB / attached Chrome: this Math.random override is installed on the attached browser's context and stays in effect for as long as the context lives — close the tab / context when you're done to drop it.";
        }
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      } catch (err) {
        const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
        const tokensEstimate = estimateTokens(JSON.stringify(body));
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ ...body, tokensEstimate }, null, 2) },
          ],
        };
      }
    },
  );

  register(
    "act_and_wait_for_network",
    {
      capability: "read",
      description:
        "Run ONE action and wait for a specific network response to complete — async SPAs fire follow-up requests after the action-result window, so `ActionResult.network` misses them. The waiter is armed BEFORE the action dispatches (no race). `action` is `{tool,args}` from the batch whitelist. `match` selects the response: `urlPattern` (case-insensitive substring), `method`, `status` — at least one required. Returns `{ action: <inner result>, network: { matched, method?, url?, status? } }` (url redacted, same as `network_read`). `timeoutMs` is the max wait (default 10000).",
      inputSchema: {
        action: z.object({
          tool: z.string().describe("Inner tool name (batch whitelist)."),
          args: z.record(z.unknown()).optional(),
        }),
        match: z
          .object({
            urlPattern: z
              .string()
              .optional()
              .describe("Case-insensitive substring of the request URL."),
            method: z.string().optional(),
            status: z.number().int().optional(),
          })
          .describe("At least one field required."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe("Max wait for the matching response (default 10000)."),
        ...SESSION_ARG,
      },
    },
    async (args) => {
      const g = gateCheck("act_and_wait_for_network");
      if (g) return g;
      const innerTool = args.action.tool;
      if (!BATCH_ALLOWED_TOOLS.has(innerTool) || innerTool === "act_and_wait_for_network") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error: `act_and_wait_for_network: inner tool "${innerTool}" not allowed (batch whitelist; no batch / await_human / recording / self)`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const ig = gateCheck(innerTool);
      if (ig) return ig;
      if (
        args.match.urlPattern === undefined &&
        args.match.method === undefined &&
        args.match.status === undefined
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  ok: false,
                  error:
                    "act_and_wait_for_network: `match` needs at least one of urlPattern / method / status",
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const e = await entryFor(args.session);
      const timeout = args.timeoutMs ?? 10_000;
      const parseInner = (resp: { content: Array<{ type: string; text?: string }> }): unknown => {
        const first = resp.content[0];
        if (!first || first.type !== "text" || first.text === undefined) return first ?? null;
        try {
          return JSON.parse(first.text);
        } catch {
          return first.text;
        }
      };
      // arm the waiter BEFORE dispatching the action so a fast response can't slip past.
      const waitP = e.session
        .page()
        .waitForResponse(
          (r) =>
            matchesResponse(
              { url: r.url(), method: r.request().method(), status: r.status() },
              args.match,
            ),
          { timeout },
        )
        .then(
          (r) => ({
            matched: true as const,
            method: r.request().method(),
            url: sanitizeUrl(r.url()),
            status: r.status(),
          }),
          () => ({ matched: false as const }),
        );
      const innerArgs = { ...(args.action.args ?? {}), session: args.session };
      const [aRes, network] = await Promise.all([toolHandlers[innerTool]!(innerArgs), waitP]);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ action: parseInner(aRes), network }, null, 2),
          },
        ],
      };
    },
  );

  register(
    "poll_eval",
    {
      capability: "eval",
      description:
        "Repeatedly evaluate a JS expression in the page until it returns a truthy value or `timeoutMs` elapses — for waiting on async job completion / store updates without ad-hoc in-page loops (a long in-page promise would trip the anti-wedge deadline). The value is page-controlled — treat it as untrusted, like `eval_js`. Capability: `eval`. Returns `{ ok, truthy, value, polls, elapsedMs, timedOut }`.",
      inputSchema: {
        expr: z
          .string()
          .describe(
            "JS expression; must be JSON-serializable. Wrap statements in `(() => { … })()`.",
          ),
        intervalMs: z
          .number()
          .int()
          .min(50)
          .max(10_000)
          .optional()
          .describe("Poll interval (default 250, min 50)."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .max(120_000)
          .optional()
          .describe("Total budget (default 5000)."),
        ...SESSION_ARG,
      },
    },
    async ({ expr, intervalMs, timeoutMs, session }) => {
      const g = gateCheck("poll_eval");
      if (g) return g;
      const s = (await entryFor(session)).session;
      const interval = intervalMs ?? 250;
      const budget = timeoutMs ?? 5000;
      const perPoll = Math.min(budget, 5000);
      const start = Date.now();
      let polls = 0;
      let value: unknown;
      while (Date.now() - start < budget) {
        polls++;
        try {
          value = await withDeadline(s.page().evaluate(expr), perPoll, "poll_eval");
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error: err instanceof Error ? err.message : String(err),
                    polls,
                    elapsedMs: Date.now() - start,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        if (value) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: true,
                    truthy: true,
                    value,
                    polls,
                    elapsedMs: Date.now() - start,
                    timedOut: false,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        if (Date.now() - start + interval >= budget) break;
        await new Promise((r) => setTimeout(r, interval));
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: true,
                truthy: false,
                value,
                polls,
                elapsedMs: Date.now() - start,
                timedOut: true,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
