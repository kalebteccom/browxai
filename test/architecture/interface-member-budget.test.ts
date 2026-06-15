// L4 (ISP) — the segregated `ToolHost` sub-ports must stay small so no god-object
// interface re-forms. RFC 0004 D3 split the 35-member `ToolHost` into role
// sub-ports (RegisterHost/GateHost/SessionHost/…); a handler depends on the narrow
// slice it calls, not the fat record (0004-03 §3, 0004-05 §4). This fitness test
// freezes that win: every sub-port stays under the member ceiling, and `ToolHost`
// itself declares ZERO own members — it is the pure intersection of the sub-ports
// (so a new member must land on a role sub-port, never grow a god-interface).
//
// Counted from the real `src/tools/host.ts` AST (the TypeScript parser), so the
// budget tracks the live interface declarations, not a hand-copied list.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";

const HOST_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../src/tools/host.ts");

/** The role sub-ports `ToolHost` is the intersection of. A handler types its
 *  `host` parameter to the subset of these it actually calls (the ISP win). */
const SUB_PORTS = [
  "RegisterHost",
  "GateHost",
  "SessionHost",
  "ActionHost",
  "CaptureHost",
  "StorageHost",
  "ScriptHost",
  "EmulationHost",
  "EgressHost",
  "EnvelopeHost",
  "ConfigHost",
  "ServerServicesHost",
] as const;

/** The per-sub-port member ceiling. The largest sub-port today is
 *  `ServerServicesHost` at 8; 12 leaves headroom while making a 13-member
 *  god-interface impossible without a new role split (the 0004-05 §4 "≤ ~12 per
 *  sub-port" target). */
const SUB_PORT_MEMBER_CEILING = 12;

interface InterfaceShape {
  readonly members: number;
  readonly extendsCount: number;
}

/** Parse `host.ts` and return each interface's own-member count + how many
 *  interfaces it `extends`. */
function interfaceShapes(path: string): Map<string, InterfaceShape> {
  const source = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const shapes = new Map<string, InterfaceShape>();
  sf.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node)) return;
    const extendsCount = (node.heritageClauses ?? [])
      .filter((h) => h.token === ts.SyntaxKind.ExtendsKeyword)
      .reduce((sum, h) => sum + h.types.length, 0);
    shapes.set(node.name.text, { members: node.members.length, extendsCount });
  });
  return shapes;
}

describe("L4 — ToolHost sub-port segregation stays ISP-clean", () => {
  const shapes = interfaceShapes(HOST_PATH);

  it("every ToolHost sub-port stays under the member ceiling (no god-interface re-forms)", () => {
    for (const port of SUB_PORTS) {
      const shape = shapes.get(port);
      expect(shape, `${port} must exist in src/tools/host.ts`).toBeTruthy();
      expect(
        shape!.members,
        `${port} declares ${shape!.members} members — over the ${SUB_PORT_MEMBER_CEILING}-member ceiling. ` +
          `Add the new member to a new role sub-port (and extend ToolHost with it) rather than growing this one.`,
      ).toBeLessThanOrEqual(SUB_PORT_MEMBER_CEILING);
    }
  });

  it("ToolHost is the pure INTERSECTION of the sub-ports (declares no own members)", () => {
    const toolHost = shapes.get("ToolHost");
    expect(toolHost, "ToolHost must exist in src/tools/host.ts").toBeTruthy();
    expect(
      toolHost!.members,
      "ToolHost must declare ZERO own members — it is the intersection the composition root assembles. " +
        "A new capability is a new (or existing) role sub-port, never a member tacked onto ToolHost.",
    ).toBe(0);
    expect(
      toolHost!.extendsCount,
      `ToolHost must extend all ${SUB_PORTS.length} role sub-ports (it is their intersection).`,
    ).toBe(SUB_PORTS.length);
  });
});
