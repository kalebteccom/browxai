import { CATALOG } from "../missions/catalog.js";
import { mockCodexFramesForMission } from "./fixtures.js";
import type { RpcFrame } from "../runtime/codex-events.js";
import type { DogfoodMission } from "../missions/schema.js";

function write(frame: RpcFrame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function missionFromPrompt(prompt: string): DogfoodMission {
  const id = CATALOG.find((mission) => prompt.includes(`"missionId":"${mission.id}"`))?.id;
  const mission = CATALOG.find((entry) => entry.id === id) ?? CATALOG[0];
  if (!mission) throw new Error("mock app-server catalog is empty");
  return mission;
}

function sessionFromPrompt(prompt: string, mission: DogfoodMission): string {
  const match = /^browxai session id: (.+)$/m.exec(prompt);
  return match?.[1] ?? `mock-${mission.id}`;
}

export function runMockAppServer(): void {
  process.stdin.setEncoding("utf8");
  let buffer = "";
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const frame = JSON.parse(line) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (frame.method === "initialize" && frame.id !== undefined) {
        write({ id: frame.id, result: { protocolVersion: "mock" } });
      } else if (frame.method === "thread/start" && frame.id !== undefined) {
        write({
          id: frame.id,
          result: {
            thread: {
              id: "mock-thread",
              model: frame.params?.model,
              sandbox: frame.params?.sandbox,
              approvalPolicy: frame.params?.approvalPolicy,
            },
          },
        });
      } else if (frame.method === "turn/start") {
        const input = frame.params?.input;
        const firstInput: unknown = Array.isArray(input) ? input[0] : undefined;
        const firstInputRecord =
          firstInput !== null && typeof firstInput === "object"
            ? (firstInput as Record<string, unknown>)
            : undefined;
        const text = typeof firstInputRecord?.text === "string" ? firstInputRecord.text : "";
        const mission = missionFromPrompt(text);
        const sessionId = sessionFromPrompt(text, mission);
        for (const output of mockCodexFramesForMission({
          mission,
          sessionId,
          runIndex: 0,
        })) {
          write(output);
        }
      }
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMockAppServer();
}
