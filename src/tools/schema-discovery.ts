import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { ToolRegistration } from "./host.js";

export type JsonObject = Record<string, unknown>;

export interface DiscoverableTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

const EMPTY_OBJECT_JSON_SCHEMA: JsonObject = {
  type: "object",
  properties: {},
};

export function inputSchemaJson(registration: ToolRegistration): JsonObject {
  const shape = registration.inputSchema;
  if (!shape || Object.keys(shape).length === 0) {
    return { ...EMPTY_OBJECT_JSON_SCHEMA };
  }
  return zodToJsonSchema(z.object(shape), {
    strictUnions: true,
    pipeStrategy: "input",
  });
}

export function discoverableTools(
  registrations: ReadonlyMap<string, ToolRegistration>,
): DiscoverableTool[] {
  return [...registrations.entries()].map(([name, registration]) => ({
    name,
    description: registration.description,
    inputSchema: inputSchemaJson(registration),
  }));
}
