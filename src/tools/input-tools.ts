import { withDeadline } from "../util/deadline.js";
import { estimateTokens } from "../util/tokens.js";
import { mouseAction, touchAction } from "../page/gestures.js";
import { snapshotProfile, restoreProfile } from "../session/profile-snapshot.js";
import { requireCdp } from "../engine/session-cdp.js";
import { SESSION_ARG } from "./schemas.js";
import type { ToolHost } from "./host.js";

/**
 * Low-level input primitives: the raw mouse pipeline (mouse_down / mouse_move /
 * mouse_up), the CDP touch pipeline (touch_start / touch_move / touch_end), and
 * the profile checkpoint pair (profile_snapshot / profile_restore). Every block
 * is registered through the shared `ToolHost` seam; the host owns the closures
 * (gate, engine-gate, entry) and the registry/workspace state, this module owns
 * the registrations.
 */
export function registerInputTools(host: ToolHost): void {
  const { z, register, gateCheck, engineGate, entryFor, cfgActionTimeout, registry, workspace } =
    host;

  // A *factory* — each call returns a fresh schema instance. Reusing one
  // shared instance across `from`/`to`/`target` made zod-to-json-schema emit a
  // `$ref` for the repeats, which some MCP schema viewers render wrong (the
  // reported `drag.to.coords` showing as `string`). Distinct instances → no
  // `$ref` dedup → every field renders identically.
  for (const act of ["mouse_down", "mouse_move", "mouse_up"] as const) {
    register(
      act,
      {
        // mouse_down / mouse_move / mouse_up — low-level pointer dispatch.
        capability: "action",
        description: `Low-level ${act.replace("_", " ")} for custom gestures the higher-level tools don't cover (scrub/trim handles). ${act === "mouse_move" ? "Requires `coords`." : "`coords` optional — moves there first when given, else acts at the current pointer position."}`,
        inputSchema: {
          coords: z
            .object({ x: z.number(), y: z.number() })
            .optional()
            .describe("Viewport CSS px."),
          ...SESSION_ARG,
        },
      },
      async ({ coords, session }) => {
        const g = gateCheck(act);
        if (g) return g;
        const e = await entryFor(session);
        try {
          const r = await withDeadline(
            mouseAction(e.session.page(), act.slice(6) as "down" | "move" | "up", coords),
            cfgActionTimeout(),
            act,
          );
          return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ok: false, error: err instanceof Error ? err.message : String(err) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );
  }

  // ---------- Touch + multi-touch gestures ----------
  //
  // A separate dispatch pipeline from the `mouse_*` family. CDP
  // `Input.dispatchTouchEvent` is the touch sibling of `dispatchMouseEvent`;
  // mobile-default apps and canvas apps wire touch handlers that the mouse
  // pipeline does NOT reach. Touch events do not auto-fire mouse events
  // (browsers MAY synthesize mouse events from touchend, but it's app-policy
  // via `touch-action` / `preventDefault`); an agent that needs both must
  // dispatch both. The `identifier` field is the DOM-side
  // TouchEvent.changedTouches[].identifier — distinct ids for distinct
  // fingers across a multi-touch sequence (default 1).
  for (const act of ["touch_start", "touch_move", "touch_end"] as const) {
    const requiresCoords = act !== "touch_end";
    register(
      act,
      {
        // touch_start / touch_move / touch_end — CDP touch pipeline; deep (no
        // off-Chromium Playwright equivalent).
        capability: "action",
        deep: true,
        description:
          `Dispatch ${act.replace("_", " ")} via CDP Input.dispatchTouchEvent — a separate pipeline from \`mouse_*\` for mobile-default apps and canvas / map / drawing widgets that listen for \`touchstart\` / \`touchmove\` / \`touchend\`. ${requiresCoords ? "`coords` required (viewport CSS px)." : "`coords` optional — when omitted, dispatches an empty touchPoints[] (the 'all fingers up' form)."} ` +
          "`identifier` (default 1) maps to DOM `TouchEvent.changedTouches[].identifier` — use distinct ids per finger to fan out multi-touch. Touch does NOT synthesise mouse events — dispatch mouse_* explicitly if both pipelines are needed.",
        inputSchema: {
          coords: requiresCoords
            ? z.object({ x: z.number(), y: z.number() }).describe("Viewport CSS px.")
            : z
                .object({ x: z.number(), y: z.number() })
                .optional()
                .describe(
                  "Viewport CSS px. Omit to dispatch empty touchPoints[] (all fingers up).",
                ),
          identifier: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe(
              "Touch identifier (default 1) — distinct values per finger for multi-touch fan-out.",
            ),
          ...SESSION_ARG,
        },
      },
      async ({ coords, identifier, session }) => {
        const g = gateCheck(act);
        if (g) return g;
        const e = await entryFor(session);
        const eg = engineGate(act, e);
        if (eg) return eg;
        try {
          const r = await withDeadline(
            touchAction(requireCdp(e.session), act.slice(6) as "start" | "move" | "end", {
              coords,
              identifier,
            }),
            cfgActionTimeout(),
            act,
          );
          const json = JSON.stringify(r);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ ...r, tokensEstimate: estimateTokens(json) }, null, 2),
              },
            ],
          };
        } catch (err) {
          const body = { ok: false, error: err instanceof Error ? err.message : String(err) };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ...body, tokensEstimate: estimateTokens(JSON.stringify(body)) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );
  }

  for (const action of ["profile_snapshot", "profile_restore"] as const) {
    register(
      action,
      {
        // profile_snapshot / profile_restore — human coordination primitives.
        capability: "human",
        description:
          action === "profile_snapshot"
            ? 'Copy a persistent session\'s profile directory into a named snapshot under `<workspace>/profile-snapshots/` — checkpoint a clean authenticated state before a destructive media-editor test. `profile` defaults to "default". ALL sessions must be closed first (copying a live profile dir corrupts it).'
            : "Restore a named profile snapshot back over a session's profile directory — reset to a clean checkpoint between destructive test runs. ALL sessions must be closed first.",
        inputSchema: {
          snapshot: z.string().describe("Snapshot name (letters/digits/._- only)."),
          profile: z
            .string()
            .optional()
            .describe(
              'Profile to snapshot/restore. Default "default" (the legacy single-profile dir); else a named profile under <workspace>/profiles/.',
            ),
        },
      },
      async ({ snapshot, profile }) => {
        const g = gateCheck(action);
        if (g) return g;
        if (registry.list().length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    ok: false,
                    error: `${action}: close all sessions first (close_sessions({all:true})) — copying a profile directory while Chromium has it open corrupts it`,
                    openSessions: registry.list().map((s) => s.id),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        try {
          const r =
            action === "profile_snapshot"
              ? snapshotProfile(workspace.root, profile, snapshot)
              : restoreProfile(workspace.root, profile, snapshot);
          return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { ok: false, error: err instanceof Error ? err.message : String(err) },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      },
    );
  }
}
