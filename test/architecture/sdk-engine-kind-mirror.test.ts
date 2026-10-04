// The SDK declares its own `EngineKind` literal union so the SDK surface stays
// free of server-internal imports. Nothing ties that copy to the server's
// `ENGINE_KINDS`, so a new engine added to the server compiles fine and an SDK
// caller then gets a type error on `open_session({ engine })` for a value the
// server accepts.
//
// This test parses the SDK declaration with the TypeScript AST (a regex cannot
// tell a union member from a comment) and asserts it lists exactly the server's
// engines. The SDK copy stays hand-written; this only fails when the two differ.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ts from "typescript";
import { ENGINE_KINDS } from "../../src/engine/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SDK_FILE = "src/sdk/tool-types-session.ts";

/** String-literal members of the exported `EngineKind` union in the SDK file. */
function sdkEngineKinds(): string[] {
  const source = ts.createSourceFile(
    SDK_FILE,
    readFileSync(join(ROOT, SDK_FILE), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const members: string[] = [];
  let found = false;
  source.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== "EngineKind") return;
    found = true;
    if (!ts.isUnionTypeNode(node.type)) {
      throw new Error(`${SDK_FILE}: EngineKind is no longer a literal union`);
    }
    for (const member of node.type.types) {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
        throw new Error(`${SDK_FILE}: EngineKind has a non-string-literal member`);
      }
      members.push(member.literal.text);
    }
  });
  if (!found) throw new Error(`${SDK_FILE}: no exported EngineKind type alias`);
  return members;
}

describe("SDK EngineKind mirror", () => {
  it("lists every engine the server lists, and nothing else", () => {
    const sdk = new Set(sdkEngineKinds());
    const server = new Set<string>(ENGINE_KINDS);
    const missingFromSdk = [...server].filter((e) => !sdk.has(e));
    const unknownToServer = [...sdk].filter((e) => !server.has(e));
    expect(missingFromSdk, "engines the server accepts but the SDK type omits").toEqual([]);
    expect(unknownToServer, "engines the SDK type allows but the server rejects").toEqual([]);
  });

  it("the parser reads a real union, so an empty parse cannot pass vacuously", () => {
    expect(sdkEngineKinds()).toContain("chromium");
  });
});
