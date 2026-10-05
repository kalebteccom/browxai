// The operator-channel descriptions of the two `ask-human` prompts that are an
// approve or deny: a page's permission request and a page's `new Notification`.
// Shared by the session wire-up and the extension rebuild, which both install
// the same handlers. The origin and the title come from the page, so the wire
// frame lists `summary` as untrusted.

import type { OperatorPrompt } from "./operator-channel.js";

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function permissionPrompt(permission: string, origin?: string): OperatorPrompt {
  return {
    kind: "approval",
    scope: "permission",
    tool: "permission_request",
    summary: `grant ${origin ? `${cap(origin, 200)} ` : "the page "}the ${cap(permission, 100)} permission`,
  };
}

export function notificationPrompt(n: { title: string; origin?: string }): OperatorPrompt {
  return {
    kind: "approval",
    scope: "notification",
    tool: "notification_construct",
    // Origin first, title capped: the title is the page's, and a long one must not
    // push the origin past the length cut on the wire.
    summary: `from ${cap(n.origin ?? "the page", 200)}, show a notification titled ${JSON.stringify(cap(n.title, 200))}`,
  };
}
