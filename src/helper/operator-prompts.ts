// The operator-channel descriptions of the two `ask-human` prompts that are an
// approve or deny: a page's permission request and a page's `new Notification`.
// Shared by the session wire-up and the extension rebuild, which both install
// the same handlers. The origin and the title come from the page, so the wire
// frame lists `summary` as untrusted.

import type { OperatorPrompt } from "./operator-channel.js";

export function permissionPrompt(permission: string, origin?: string): OperatorPrompt {
  return {
    kind: "approval",
    scope: "permission",
    tool: "permission_request",
    summary: `grant ${origin ? `${origin} ` : "the page "}the ${permission} permission`,
  };
}

export function notificationPrompt(n: { title: string; origin?: string }): OperatorPrompt {
  return {
    kind: "approval",
    scope: "notification",
    tool: "notification_construct",
    summary: `show a notification titled ${JSON.stringify(n.title)} from ${n.origin ?? "the page"}`,
  };
}
