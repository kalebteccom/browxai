import { DEFAULT_SESSION_ID, type SessionRegistry } from "../session/registry.js";
import { type DispatchOutcome } from "../session/metrics.js";
import { withDeadline } from "../util/deadline.js";
import {
  buildEvalJsCapture,
  redactArgs,
  type DiagnosticsRecorder,
  type DiagnosticsRecord,
} from "../util/diagnostics.js";
import type { ToolResponse } from "./host.js";

/** The createServer locals the post-dispatch observation closures close over.
 *  A narrow slice of `HostDeps` — only the two stores the noters read: the
 *  per-session `registry` (peeked, never created from, so a denial that fired
 *  before lazy session creation is silently skipped) and the diagnostics JSONL
 *  recorder. Kept separate from `HostDeps` so this leaf never imports back from
 *  the `buildHost` barrel that consumes it (no import cycle). */
export interface ObservationDeps {
  /** The per-session registry — entry peek for wedge/metrics/diagnostics. */
  registry: SessionRegistry;
  /** The diagnostics JSONL recorder. */
  diagnostics: DiagnosticsRecorder;
}

/** The post-dispatch observation pipeline `register`'s wrapper threads each
 *  result through: the wedge tracker (page-exercising tools only), the
 *  per-session metrics counter, and the diagnostics JSONL recorder. Plus the
 *  `isWedgeTracked` predicate `register` consults at wire time to decide whether
 *  a tool's result routes through the wedge tracker. */
export interface Observation {
  /** Update the session's wedge counter from a tool result and, once the
   *  session is wedged, splice `sessionWedged` + a recovery hint onto it. */
  noteWedgeOutcome: (args: unknown, res: ToolResponse) => Promise<ToolResponse>;
  /** Record one dispatch on the session's metrics counter (peek-only). */
  noteMetrics: (toolName: string, args: unknown, res: ToolResponse, startedAt: number) => void;
  /** Record one dispatched call into the diagnostics JSONL store. */
  noteDiagnostics: (toolName: string, args: unknown, res: ToolResponse, startedAt: number) => void;
  /** Whether a tool with this capability routes its result through the wedge
   *  tracker. `register` calls `isWedgeTracked(def.capability ?? "")` once at
   *  registration to set the per-tool `tracked` flag. */
  isWedgeTracked: (capability: string) => boolean;
}

/**
 * Build the post-dispatch observation pipeline injected into `buildHost`. Every
 * closure body is byte-identical to the inline `buildHost` version; the
 * createServer locals they close over (`registry`, `diagnostics`) arrive through
 * `deps`, and `firstJsonResult` / `classifyOutcome` / the `WEDGE_TRACKED_CAPABILITIES`
 * set stay private to this module (they had no consumer outside these noters).
 */
export function buildObservation(deps: ObservationDeps): Observation {
  const { registry, diagnostics } = deps;

  // Wedge tracking. Only tools that actually exercise the page can
  // wedge a session; session-management / config / coordination tools are
  // excluded so their (always fast) results don't reset the streak.
  const WEDGE_TRACKED_CAPABILITIES = new Set<string>([
    "read",
    "navigation",
    "action",
    "eval",
    "network-body",
    "file-io",
  ]);
  /** First text item of a result, parsed as a JSON object — or null when the
   *  result has no leading JSON object (a plain-text snapshot, an image). */
  const firstJsonResult = (
    res: ToolResponse,
  ): { obj: Record<string, unknown>; idx: number } | null => {
    for (let i = 0; i < res.content.length; i++) {
      const item = res.content[i];
      if (item && item.type === "text") {
        try {
          const parsed: unknown = JSON.parse(item.text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { obj: parsed as Record<string, unknown>, idx: i };
          }
        } catch {
          /* not JSON — a plain-text result, e.g. a snapshot tree */
        }
        return null;
      }
    }
    return null;
  };
  /** Update the session's wedge counter from a tool result and, once the
   *  session is wedged, splice `sessionWedged` + a recovery hint onto it.
   *  An anti-wedge timeout increments the streak; any responsive result
   *  (success, or a fast non-timeout error) clears it.
   *
   *  Before stamping `sessionWedged: true`, the threshold-trip path probes
   *  the page with a 1s `evaluate(() => 1)` — if the page answers, the
   *  session is alive (the timeouts were action-shaped, not page-shaped:
   *  perpetually-busy SPAs hold WS keepalives / rAF loops that prevent
   *  Playwright actionability from settling, but the page itself responds
   *  fine to evaluate). A successful probe clears the streak instead of
   *  falsely tipping the caller into a session-discard. */
  const noteWedgeOutcome = async (args: unknown, res: ToolResponse): Promise<ToolResponse> => {
    const sessionId = (args as { session?: string } | undefined)?.session ?? DEFAULT_SESSION_ID;
    const entry = registry.peek(sessionId);
    if (!entry) return res;
    const parsed = firstJsonResult(res);
    const timedOut =
      !!parsed &&
      parsed.obj.ok === false &&
      typeof parsed.obj.error === "string" &&
      /anti-wedge timeout/i.test(parsed.obj.error);
    if (!timedOut || !parsed) {
      entry.wedge.recordResponsive();
      return res;
    }
    entry.wedge.recordTimeout();
    if (!entry.wedge.wedged()) return res;
    // Threshold tripped — confirm before stamping. Cheap liveness probe:
    // if the page answers evaluate() within 1s, the session is alive and
    // the timeouts were action-shaped (e.g. busy SPA blocks click
    // actionability). Clear the streak rather than falsely wedge the
    // caller. If the probe fails or times out, the session genuinely is
    // wedged — stamp the response as before.
    let aliveByProbe = false;
    try {
      const page = entry.session.page();
      await withDeadline(
        page.evaluate(() => 1),
        1_000,
        "wedge_probe",
      );
      aliveByProbe = true;
    } catch {
      aliveByProbe = false;
    }
    if (aliveByProbe) {
      entry.wedge.recordResponsive();
      return res;
    }
    const obj = { ...parsed.obj, sessionWedged: true, sessionWedgedHint: entry.wedge.hint() };
    return {
      content: res.content.map((item, i) =>
        i === parsed.idx ? { type: "text" as const, text: JSON.stringify(obj, null, 2) } : item,
      ),
    };
  };

  // Classify a dispatched tool result for the per-session metrics
  // counter. We piggyback on `firstJsonResult` (already defined above) so we
  // don't pay a second parse. A capability-denied result is the JSON shape the
  // `gateCheck` helper emits (carries `requiredCapability`); any other
  // `ok:false` result is an error; everything else is `ok`. The
  // `tokensEstimate` field is read straight off the envelope when present —
  // most tools surface it via the standard helper, but image-only / non-JSON
  // results legitimately don't and that's fine (treated as 0).
  const classifyOutcome = (
    res: ToolResponse,
  ): { outcome: DispatchOutcome; tokensEstimate?: number } => {
    const parsed = firstJsonResult(res);
    if (!parsed) return { outcome: "ok" };
    const obj = parsed.obj;
    const tokens = typeof obj.tokensEstimate === "number" ? obj.tokensEstimate : undefined;
    if (obj.ok === false) {
      // Capability-denied shape (see `gateCheck`): carries `requiredCapability`.
      // The denial path is a config-shape signal, not a tool-error signal —
      // bucket it separately.
      if (Object.prototype.hasOwnProperty.call(obj, "requiredCapability")) {
        return { outcome: "denied", tokensEstimate: tokens };
      }
      return { outcome: "error", tokensEstimate: tokens };
    }
    return { outcome: "ok", tokensEstimate: tokens };
  };

  /** Record one dispatch on the session's metrics counter — peek-only on the
   *  registry. Calls against a not-yet-open session (e.g. a capability denial
   *  fired before the lazy session creation) are silently skipped: there's no
   *  SessionEntry to accumulate against, and the denial is still visible at the
   *  capability layer. Same posture as `noteWedgeOutcome` above. */
  const noteMetrics = (
    toolName: string,
    args: unknown,
    res: ToolResponse,
    startedAt: number,
  ): void => {
    const sessionId = (args as { session?: string } | undefined)?.session ?? DEFAULT_SESSION_ID;
    const entry = registry.peek(sessionId);
    if (!entry) return;
    const { outcome, tokensEstimate } = classifyOutcome(res);
    entry.metrics.record(toolName, outcome, Date.now() - startedAt, tokensEstimate);
  };

  /** Record one dispatched call into the diagnostics JSONL store. No-op when
   *  the diagnostics capability is OFF — the caller short-circuits on
   *  `diagnostics.enabled` BEFORE allocating anything. The recorder runs
   *  DOWNSTREAM of the URL sanitiser + secrets-masking chokepoint:
   *  by the time `res` lands here, every egress sink has already rewritten
   *  registered secret values back to `<NAME>` aliases. Args are additionally
   *  walked through `applyMaskDeep` so a secret echoed in the call args
   *  never reaches the JSONL raw. */
  const noteDiagnostics = (
    toolName: string,
    args: unknown,
    res: ToolResponse,
    startedAt: number,
  ): void => {
    if (!diagnostics.enabled) return;
    const sessionId = (args as { session?: string } | undefined)?.session ?? DEFAULT_SESSION_ID;
    const entry = registry.peek(sessionId);
    // Apply the per-session secrets mask to args BEFORE structural redaction
    // so a registered secret value echoed in the call args never lands raw
    // in the JSONL store.
    const maskedArgsIn = entry?.secrets ? entry.secrets.applyMaskDeep(args) : args;
    const parsed = firstJsonResult(res);
    const sizeBytes = res.content.reduce((n, item) => {
      if (item.type === "text") return n + Buffer.byteLength(item.text, "utf8");
      if (item.type === "image") return n + (typeof item.data === "string" ? item.data.length : 0);
      return n;
    }, 0);
    const obj = parsed?.obj ?? null;
    const ok = obj ? obj.ok !== false : true;
    const warningsCount = obj && Array.isArray(obj.warnings) ? obj.warnings.length : 0;
    let failureKind: string | undefined;
    if (!ok && obj) {
      if (Object.prototype.hasOwnProperty.call(obj, "requiredCapability")) {
        failureKind = "capability-denied";
        diagnostics.noteDenial();
      } else {
        const err = typeof obj.error === "string" ? obj.error : "";
        if (/anti-wedge timeout/i.test(err)) failureKind = "timeout";
        else if (/not found|no element matches|ref not found|locator did not resolve/i.test(err))
          failureKind = "target-not-found";
        else if (/must |invalid |unknown |expected /i.test(err)) failureKind = "bad-arg";
        else failureKind = "internal";
      }
    }
    const record: DiagnosticsRecord = {
      kind: "call",
      ts: new Date(startedAt).toISOString(),
      tool: toolName,
      sessionId,
      argsRedacted: redactArgs(maskedArgsIn),
      resultMeta: {
        ok,
        sizeBytes,
        warningsCount,
        ...(failureKind ? { failureKind } : {}),
      },
      durationMs: Date.now() - startedAt,
      capabilityDenials: diagnostics.denialsCount(),
    };
    const evalCap = buildEvalJsCapture(toolName, maskedArgsIn, obj);
    if (evalCap) record.evalJs = evalCap;
    diagnostics.write(record);
  };

  const isWedgeTracked = (capability: string): boolean =>
    WEDGE_TRACKED_CAPABILITIES.has(capability);

  return { noteWedgeOutcome, noteMetrics, noteDiagnostics, isWedgeTracked };
}
