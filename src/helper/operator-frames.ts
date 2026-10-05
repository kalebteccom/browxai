// Request frames for the operator channel: what each prompt becomes on the wire,
// how it is cut to fit, and how a page prompt is told apart from a repeat of it.
// Pure, so the cuts are unit-testable without a socket.

import { sanitizeUrlsInText } from "../util/url-sanitizer.js";
import type { ConfirmHook } from "../util/capabilities.js";
import {
  OPERATOR_PROTOCOL_VERSION,
  type AnswerRules,
  type HumanKind,
} from "./operator-protocol.js";

/** What a request asks. Strings here are agent- or page-sourced and are listed
 *  as `untrusted` on the wire. */
export type OperatorPrompt =
  | {
      kind: "approval";
      /** The confirm scope or policy name (`navigate_off_allowlist`, `permission`, ...). */
      scope: string;
      tool: string;
      summary: string;
      /** Set when an approve may carry a grant: the confirm scope it would extend. */
      grantable?: ConfirmHook;
    }
  | { kind: "human"; humanKind: HumanKind; prompt: string; choices?: string[] };

export interface OperatorAsk {
  session: string;
  /** How long the request may stay unanswered before it is denied. */
  timeoutMs: number;
  /** The session's secret masker, applied to every string that leaves. */
  mask: <T>(value: T) => T;
  prompt: OperatorPrompt;
}

/** Who a request is for. A page can raise `page` prompts as fast as it likes, an
 *  agent can raise `human` ones, and a confirm hook is `hook`. Each class has its
 *  own share of the pending cap, so one cannot starve another. */
export type PromptClass = "hook" | "human" | "page";

/** Pending requests: 32 in all, split so the three classes cannot crowd each
 *  other out (12 + 12 + 8), and bounded per session within a class. */
export const MAX_PENDING = 32;
export const CLASS_LIMIT: Record<PromptClass, number> = { hook: 12, human: 12, page: 8 };
export const SESSION_LIMIT: Record<PromptClass, number> = { hook: 8, human: 8, page: 4 };

/** Field caps, in characters. With 32 choices and the worst JSON escaping
 *  (six bytes a character) the biggest frame stays near 40 KiB, under the
 *  64 KiB the receiver accepts. A frame over the limit is refused as well. */
const MAX_SUMMARY_CHARS = 1_000;
const MAX_PROMPT_CHARS = 2_000;
const MAX_CHOICES = 32;
const MAX_CHOICE_CHARS = 100;
const MAX_NAME_CHARS = 128;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function requestFrame(
  id: string,
  ask: OperatorAsk,
  createdAt: number,
): { frame: Record<string, unknown>; rules: AnswerRules } {
  // Anything cut or dropped is reported, so the card can say the text is partial.
  let truncated = false;
  let omittedChoices = 0;
  const shorten = (v: string, max: number): string => {
    if (v.length > max) truncated = true;
    return cut(v, max);
  };
  // URL strip and secret mask first, then the length cap on what is left.
  const clean = (v: string, max: number): string => shorten(ask.mask(sanitizeUrlsInText(v)), max);
  const base = {
    v: OPERATOR_PROTOCOL_VERSION,
    type: "request",
    id,
    session: shorten(ask.session, MAX_NAME_CHARS),
    createdAt,
    expiresAt: createdAt + ask.timeoutMs,
  };
  const p = ask.prompt;
  const flags = (): Record<string, unknown> => ({
    ...(truncated ? { truncated: true } : {}),
    ...(omittedChoices > 0 ? { omittedChoices } : {}),
  });
  if (p.kind === "approval") {
    const answers = ["approve", "deny"] as const;
    const frame = {
      ...base,
      kind: "approval",
      scope: shorten(p.scope, MAX_NAME_CHARS),
      tool: shorten(p.tool, MAX_NAME_CHARS),
      summary: clean(p.summary, MAX_SUMMARY_CHARS),
      untrusted: ["summary", "session"],
      answers,
      ...(p.grantable ? { grantScopes: ["session", "workspace"] } : {}),
    };
    return {
      frame: { ...frame, ...flags() },
      rules: { answers, ...(p.grantable ? { grantable: p.grantable } : {}) },
    };
  }
  const answers = ["done", "abort"] as const;
  omittedChoices = Math.max(0, (p.choices?.length ?? 0) - MAX_CHOICES);
  const choices = p.choices?.slice(0, MAX_CHOICES).map((c) => clean(c, MAX_CHOICE_CHARS));
  const frame = {
    ...base,
    kind: "human",
    humanKind: p.humanKind,
    prompt: clean(p.prompt, MAX_PROMPT_CHARS),
    ...(choices ? { choices } : {}),
    untrusted: choices ? ["prompt", "choices", "session"] : ["prompt", "session"],
    answers,
  };
  return {
    frame: { ...frame, ...flags() },
    rules: { answers, humanKind: p.humanKind, choiceCount: choices?.length ?? 0 },
  };
}

export const classOf = (p: OperatorPrompt): PromptClass =>
  p.kind === "human" ? "human" : p.grantable ? "hook" : "page";

/** What a page prompt is, for collapsing repeats. Hooks and human prompts are
 *  never collapsed: each is a distinct decision. */
export function dedupeKey(cls: PromptClass, frame: Record<string, unknown>): string | null {
  if (cls !== "page") return null;
  return JSON.stringify([frame.session, frame.scope, frame.tool, frame.summary]);
}
