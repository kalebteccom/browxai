import type { DogfoodMission } from "../missions/schema.js";
import type { RpcFrame } from "../runtime/codex-events.js";

function resultForTool(tool: string): Record<string, unknown> {
  if (["solve_captcha", "get_totp", "get_credential"].includes(tool)) {
    return { ok: false, error: "no provider configured; structured unavailable result" };
  }
  if (tool === "canvas_query") {
    return { ok: false, error: "no canvas adapter registered; structured no adapter result" };
  }
  if (tool.startsWith("extensions_")) {
    return { ok: false, error: "extension API unavailable in this mock/headless environment" };
  }
  return { ok: true, tool };
}

export function mockCodexFramesForMission(input: {
  readonly mission: DogfoodMission;
  readonly sessionId: string;
  readonly runIndex: number;
}): RpcFrame[] {
  const threadId = `mock-thread-${input.mission.id}-${String(input.runIndex)}`;
  const turnId = `mock-turn-${input.mission.id}-${String(input.runIndex)}`;
  const frames: RpcFrame[] = [
    {
      method: "turn/started",
      params: { threadId, turn: { id: turnId } },
    },
    {
      method: "turn/plan/updated",
      params: {
        plan: [
          { step: "Open the assigned surface", status: "completed" },
          { step: "Use browxai MCP tools to complete the mission", status: "inProgress" },
        ],
      },
    },
    {
      method: "item/completed",
      params: {
        item: {
          id: `reason-${input.mission.id}-${String(input.runIndex)}`,
          type: "reasoning",
          summary: [{ text: "Identify the relevant browxai affordance and verify by readback." }],
        },
      },
    },
  ];

  input.mission.expectedTools.forEach((tool, index) => {
    const id = `tool-${input.mission.id}-${String(input.runIndex)}-${String(index)}`;
    const args = { session: input.sessionId, mock: true };
    frames.push({
      method: "item/started",
      params: {
        item: {
          id,
          type: "mcpToolCall",
          server: "browxai",
          tool,
          arguments: args,
        },
      },
    });
    frames.push({
      method: "item/completed",
      params: {
        item: {
          id,
          type: "mcpToolCall",
          server: "browxai",
          tool,
          arguments: args,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(resultForTool(tool)),
              },
            ],
          },
        },
      },
    });
  });

  frames.push({
    method: "item/completed",
    params: {
      item: {
        id: `assistant-${input.mission.id}-${String(input.runIndex)}`,
        type: "agentMessage",
        text:
          `Mock mission ${input.mission.id} completed.\n` +
          `DOGFOOD_MISSION_DONE {"missionId":"${input.mission.id}","status":"done","reflection":"mock trace exercised the mission tool set"}`,
      },
    },
  });
  frames.push({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId },
      usage: {
        inputTokens: 1000 + input.mission.expectedTools.length,
        cachedTokens: 10,
        outputTokens: 250,
        totalTokens: 1260 + input.mission.expectedTools.length,
        contextWindow: 200000,
      },
    },
  });
  return frames;
}

export function protocolDriftGoldenFrames(): readonly RpcFrame[] {
  return [
    {
      method: "item/started",
      params: {
        item: {
          id: "mcp-1",
          type: "mcpToolCall",
          server: "browxai",
          tool: "snapshot",
          arguments: { session: "golden" },
        },
      },
    },
    {
      method: "item/completed",
      params: {
        item: {
          id: "mcp-1",
          type: "mcpToolCall",
          server: "browxai",
          tool: "snapshot",
          arguments: { session: "golden" },
          result: { content: [{ type: "text", text: '{"ok":true}' }] },
        },
      },
    },
    {
      method: "item/completed",
      params: {
        item: {
          id: "reason-1",
          type: "reasoning",
          summary: [{ text: "Need a page snapshot before acting." }],
        },
      },
    },
    {
      method: "turn/plan/updated",
      params: { plan: [{ step: "Inspect page", status: "inProgress" }] },
    },
    {
      method: "turn/completed",
      params: {
        usage: {
          inputTokens: 10,
          cachedTokens: 2,
          outputTokens: 3,
          totalTokens: 15,
          contextWindow: 200000,
        },
      },
    },
    {
      id: 99,
      error: { code: -32600, message: "thread/start failed" },
    },
  ];
}
