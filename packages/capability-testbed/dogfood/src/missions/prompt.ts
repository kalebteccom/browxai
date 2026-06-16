import type { DogfoodMission } from "./schema.js";

export function buildMissionPrompt(input: {
  readonly mission: DogfoodMission;
  readonly baseUrl: string;
  readonly sessionId: string;
  readonly maxToolCalls: number;
  readonly maxTurns: number;
}): string {
  const marker = `DOGFOOD_MISSION_DONE {"missionId":"${input.mission.id}","status":"done|blocked","reflection":"..."}`;
  return [
    "You are running a browxai dogfood mission.",
    "",
    `Test app base URL: ${input.baseUrl}`,
    `browxai session id: ${input.sessionId}`,
    "",
    "Use the browxai MCP server for browser work. Do not use shell commands, local browsers, or direct HTTP shortcuts to complete the mission.",
    "The target page is already loaded for this session. Do not repeatedly navigate or re-snapshot just to re-orient; use the current page state and only refresh your view when it changes.",
    "",
    `Mission: ${input.mission.goal}`,
    `Success criteria: the browser-visible state demonstrates this goal is complete, and any changed value or effect has been verified from the page.`,
    `Budget: finish within ${String(input.maxToolCalls)} browxai tool calls and ${String(input.maxTurns)} Codex turns.`,
    "",
    "The moment the success criteria are met, stop using tools and emit the DONE marker. If blocked, emit the same marker with status \"blocked\" and explain the blocker in reflection.",
    "When finished, reply with a concise human summary and then a final marker on its own line.",
    `Final marker format: ${marker}`,
  ].join("\n");
}
