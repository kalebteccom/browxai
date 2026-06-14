// ESLint flat-config for browxai.
//
// Style + lint baseline. Load-bearing rules ship as `error` from day one;
// noisier rules ship as `warn` and get promoted in a follow-up phase that
// converges to zero warns. Two custom rules are wired here:
//
//   - tracker-id ban — comments must not contain project-management IDs
//     ("W-" + letter + digit, Round-N, ask-#-N, JIRA-style, LINEAR-style,
//     GEN-N, T-N, "R" + digits + "-#" + digits). These are PM artifacts,
//     not code context — they rot, mean nothing to a future reader, and
//     belong in the commit/PR body. Comments should state the actual
//     reason.
//
//   - page-eval-stringified-arrow — flags page.evaluate() / evaluateHandle()
//     / evaluateAll() called with a TemplateLiteral or string Literal.
//     Caught the dom_export + element_export root-cause class: stringified
//     arrows lose the closure, capture nothing, and silently mis-evaluate.
//     Use a function-expression argument instead.
//
// Both ship as `error`; both have zero violations in the current tree.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import-x";
import globals from "globals";

const TRACKER_ID_PATTERN =
  "\\b(W-[A-Z]\\d+|Round-?\\d+|ask\\s*#\\d+|TICKET-\\d+|JIRA-\\d+|LINEAR-\\d+|GEN-\\d+|T-\\d+|R\\d+-#\\d+)\\b";

// Custom rule: ban tracker-style IDs in comments.
const noTrackerIdsInComments = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow project-management tracker IDs in comments (Webwright / Round / ask / JIRA / LINEAR / GEN / T / Rnd-# style).",
    },
    schema: [],
    messages: {
      trackerId:
        'Tracker IDs (W-/Round-/ask #/JIRA-/LINEAR-/GEN-/T-/R-style) do not belong in code comments — they are project-management artifacts that rot and mean nothing to a future reader. State the actual reason instead. (Matched: "{{ match }}")',
    },
  },
  create(context) {
    const re = new RegExp(TRACKER_ID_PATTERN);
    return {
      Program() {
        const sourceCode = context.sourceCode ?? context.getSourceCode();
        for (const comment of sourceCode.getAllComments()) {
          const m = comment.value.match(re);
          if (m) {
            context.report({
              loc: comment.loc,
              messageId: "trackerId",
              data: { match: m[0] },
            });
          }
        }
      },
    };
  },
};

// Custom rule: flag page.evaluate(`...`) / page.evaluate("...") — stringified
// arrows / strings as the first arg are the foot-gun we keep hitting.
const noPageEvalStringifiedArrow = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow string / template-literal first arg to page.evaluate / evaluateHandle / evaluateAll — pass a function instead.",
    },
    schema: [],
    messages: {
      stringified:
        "page.{{ name }}() called with a {{ kind }} first argument. Stringified arrows lose their closure and execute as opaque source — pass a function expression instead and forward captured values via the second argument.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || !callee.property) return;
        const name = callee.property.name;
        if (name !== "evaluate" && name !== "evaluateHandle" && name !== "evaluateAll") {
          return;
        }
        const first = node.arguments[0];
        if (!first) return;
        if (first.type === "TemplateLiteral") {
          context.report({
            node: first,
            messageId: "stringified",
            data: { name, kind: "template literal" },
          });
        } else if (first.type === "Literal" && typeof first.value === "string") {
          context.report({
            node: first,
            messageId: "stringified",
            data: { name, kind: "string literal" },
          });
        }
      },
    };
  },
};

// RFC 0004 L1 (the closed core). Custom rule: ban branching on an EngineKind
// string literal — `engine === "safari"`, `session.engine !== "chromium"`,
// `case "webkit":` — outside the engine-select layer. Engine dispatch belongs in
// the EngineRegistry (post-D1) and the capability-driven substrate selectors, not
// scattered through handlers; a sixth engine must be a new adapter behind the
// port, never an edit to 5-8 existing files. Mirrors the existing custom-rule
// idiom (meta.type "problem", schema [], create(context) visitor).
const ENGINE_KINDS = ["chromium", "firefox", "webkit", "android", "safari"];

// Files whose single responsibility IS engine selection — engine literals are the
// point there, not a leak. select.ts / capabilities.ts / registry.ts (post-D1)
// are FILES (anchored with `\.ts$`); adapters/ is a DIRECTORY (prefix). The two
// substrate selectors already key on `session.engine === "safari"` by design.
const ENGINE_SELECT_ALLOWLIST = [
  /src\/engine\/(registry|select|capabilities)\.ts$/,
  /src\/engine\/adapters\//,
  /src\/page\/snapshot-substrate-select\.ts$/,
  /src\/page\/network-substrate-select\.ts$/,
];

const noEngineLiteralBranches = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow branching on an EngineKind string literal outside the engine-select layer. " +
        "Engine dispatch belongs in the EngineRegistry / substrate selectors, not in handlers.",
    },
    schema: [],
    messages: {
      engineLiteral:
        'Engine dispatch on the literal "{{ engine }}" does not belong here. A handler must be ' +
        "engine-agnostic: route through the capability substrates (actionsFor / captureFor / " +
        "snapshotSubstrateFor / networkSubstrateFor) or the EngineRegistry, never an " +
        '`engine === "{{ engine }}"` branch. See architecture-principles.md §4 and RFC 0004 L1.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (ENGINE_SELECT_ALLOWLIST.some((re) => re.test(filename))) return {};

    const flagIfEngineLiteral = (node, literalNode) => {
      if (
        literalNode &&
        literalNode.type === "Literal" &&
        typeof literalNode.value === "string" &&
        ENGINE_KINDS.includes(literalNode.value)
      ) {
        context.report({
          node,
          messageId: "engineLiteral",
          data: { engine: literalNode.value },
        });
      }
    };

    return {
      // `x === "safari"`, `x !== "firefox"`
      BinaryExpression(node) {
        if (node.operator !== "===" && node.operator !== "!==") return;
        flagIfEngineLiteral(node, node.right);
        flagIfEngineLiteral(node, node.left);
      },
      // `case "webkit":`
      SwitchCase(node) {
        flagIfEngineLiteral(node, node.test);
      },
    };
  },
};

// RFC 0004 L3 (one reason to change) at the gate. Custom rule: ban inlined
// capability-gate logic — `caps.enabled.has(...)`, `capabilities.includes(...)`,
// and direct reads of the TOOL_CAPABILITY map — outside the gate's home files.
// The security decision is centralized in ToolHost.gateCheck / engineGate; a
// handler that scatters its own gate logic breaks SRP and the audit surface. The
// rule keys on the member-chain ROOT being `caps`/`capabilities` (so `host.caps…`,
// rooted at `host`, is untouched) and on the `TOOL_CAPABILITY` identifier.
const GATE_OWNER_ALLOWLIST = [
  /src\/tools\/host(-build)?\.ts$/,
  /src\/util\/capabilities\.ts$/,
  /src\/engine\/tool-gate\.ts$/,
];

const noInlinedCapabilityChecks = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow inlined capability-gate logic in handlers. Route through " +
        "ToolHost.gateCheck (capability dimension) / ToolHost.engineGate (engine dimension).",
    },
    schema: [],
    messages: {
      inlined:
        "Inlined capability check ('{{ snippet }}'). The gate is centralized: call " +
        "`const g = gateCheck(toolName); if (g) return g;` (or `engineGate` for the engine " +
        "dimension) at the top of the handler. Scattered gate logic breaks SRP and the audit " +
        "surface. See code-quality.md SOLID §, RFC 0004 L3.",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (GATE_OWNER_ALLOWLIST.some((re) => re.test(filename))) return {};

    const CAP_OBJECTS = new Set(["caps", "capabilities"]);
    const CAP_METHODS = new Set(["has", "includes"]);

    return {
      // caps.enabled.has(...) / capabilities.includes(...)
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (!callee.property || !CAP_METHODS.has(callee.property.name)) return;
        // Walk the member chain to its root.
        let root = callee.object;
        while (root.type === "MemberExpression") root = root.object;
        if (root.type === "Identifier" && CAP_OBJECTS.has(root.name)) {
          context.report({
            node,
            messageId: "inlined",
            data: { snippet: context.sourceCode.getText(node).slice(0, 48) },
          });
        }
      },
      // direct read of the TOOL_CAPABILITY map outside the gate owners
      Identifier(node) {
        if (node.name === "TOOL_CAPABILITY") {
          context.report({ node, messageId: "inlined", data: { snippet: "TOOL_CAPABILITY" } });
        }
      },
    };
  },
};

const browxaiLocal = {
  rules: {
    "no-tracker-ids-in-comments": noTrackerIdsInComments,
    "no-page-eval-stringified-arrow": noPageEvalStringifiedArrow,
    "no-engine-literal-branches": noEngineLiteralBranches, // L1
    "no-inlined-capability-checks": noInlinedCapabilityChecks, // L3 (gate centralization)
  },
};

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "packages/*/dist/**",
      "packages/plugins/*/dist/**",
      "node_modules/**",
      "coverage/**",
      "artifacts/**",
      "website/**",
      "**/*.generated.*",
      ".claude/**",
      // Reproducible probe artifacts — standalone Node scripts (console output,
      // exploratory locals); they are reference material, not source.
      "docs/rfcs/references/safari-probe/**",
    ],
  },
  js.configs.recommended,
  // Base JS/non-TS rules — no type-aware rules here so .js/.mjs/.cjs lint.
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: {
      "import-x": importPlugin,
      "browxai-local": browxaiLocal,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-console": ["warn", { allow: ["error", "warn"] }],
      "import-x/no-duplicates": "error",
      "browxai-local/no-tracker-ids-in-comments": "error",
      "browxai-local/no-page-eval-stringified-arrow": "error",
      // RFC 0004 architecture guardrails. P0 lands them at `error` but
      // scoped to NEW violations only — the known-debt files P1/P2 clean up
      // are turned OFF in a dedicated override block below. A new literal /
      // inlined gate in any other file errors immediately.
      "browxai-local/no-engine-literal-branches": "error", // -> whole-tree clean in P1
      "browxai-local/no-inlined-capability-checks": "error", // -> whole-tree clean in P2
    },
  },
  // Type-aware TS rules — scoped to .ts/.tsx, with projectService so
  // typescript-eslint picks the right tsconfig per file (root + plugin
  // packages) without us listing every one.
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({
    ...c,
    files: ["**/*.{ts,tsx}"],
  })),
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "import-x": importPlugin,
      "browxai-local": browxaiLocal,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node },
      parserOptions: {
        // tsconfig.eslint.json explicitly widens include to cover the
        // top-level vitest configs, the test/ tree, and plugin
        // in-package *.test.ts + schema.d.ts files that the per-package
        // tsconfigs intentionally exclude. Used for lint only — never
        // emits.
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Load-bearing async-safety — error from day one.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // Unused-var hygiene — `^_` escape for the intentional case.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Stage 2d: promoted to error after triage + per-site fix.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-assertions": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/restrict-template-expressions": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-empty-object-type": "error",
      "@typescript-eslint/prefer-promise-reject-errors": "error",
      "@typescript-eslint/only-throw-error": "error",
      "@typescript-eslint/unbound-method": "error",

      // Full no-unsafe enforcement. The MCP tools/call boundary is typed (each
      // handler's args are inferred from its own zod `inputSchema`, the exact
      // shape the SDK parses the wire payload into) and the page-evaluate
      // returns are typed at their call sites, so untyped external data no
      // longer flows as `any` through production code.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",

      // Stage 2c: re-enabled after per-call audit. Catches load-bearing `as T`
      // and `!` assertions; necessary ones get a per-line disable + WHY.
      // Note: no-unnecessary-non-null-assertion does not exist in
      // @typescript-eslint v8 — the unnecessary-`!` case is covered by
      // no-unnecessary-type-assertion.
      "@typescript-eslint/no-unnecessary-type-assertion": "error",

      // Ban undocumented ts-ignore / ts-expect-error.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": "allow-with-description",
          "ts-nocheck": "allow-with-description",
          "ts-check": false,
          minimumDescriptionLength: 5,
        },
      ],

      "no-console": ["warn", { allow: ["error", "warn"] }],

      "import-x/no-duplicates": "error",

      // browxai-specific custom rules — error from day one.
      "browxai-local/no-tracker-ids-in-comments": "error",
      "browxai-local/no-page-eval-stringified-arrow": "error",
      // RFC 0004 architecture guardrails (L1 / L3). `error` everywhere, with the
      // known-debt files (which P1/P2 clean up) turned OFF in the dedicated
      // override block below — so a NEW engine literal or inlined gate errors
      // anywhere outside that allowlist, while existing debt does not block the
      // gate. Promote to whole-tree (drop the override) in P1 / P2.
      "browxai-local/no-engine-literal-branches": "error",
      "browxai-local/no-inlined-capability-checks": "error",
    },
  },
  // RFC 0004 D11 — the size / complexity budgets (L3). Sized from the CURRENT
  // HEALTHY modules (input-tools.ts 212, canvas-tools.ts 444, tool-gate.ts 145),
  // not the god-modules — so they are a ratchet that holds AFTER the D3 split,
  // not an aspiration. They ship `warn` in P0 (visible, non-blocking; the
  // `pnpm lint` script is bare `eslint .`, so warns never fail the gate) and
  // promote to `error` in P3 once the split brings the offenders under budget.
  {
    files: ["src/tools/*-tools.ts", "src/page/**/*.ts"],
    rules: {
      "max-lines": ["warn", { max: 450, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["warn", { max: 70, skipBlankLines: true, skipComments: true }],
      complexity: ["warn", { max: 15 }],
      "max-params": ["warn", { max: 5 }],
    },
  },
  // The composition root gets the hardest, and only `error`, budget in P0: it is
  // already at 382 LOC and the architecture treats it as composition-only, so the
  // 400-line ceiling trips immediately on any business-logic creep. (RFC 0004 §4.)
  {
    files: ["src/server.ts"],
    rules: {
      "max-lines": ["error", { max: 400, skipBlankLines: true, skipComments: true }],
    },
  },
  // RFC 0004 P0 — the two new architecture guardrails are scoped to NEW
  // violations only: they are turned OFF on exactly the known-debt files P1
  // (no-engine-literal-branches) and P2 (no-inlined-capability-checks) remove.
  // This is the §7 meta-rule's only sanctioned escape valve — a reviewable config
  // allowlist, never an inline `eslint-disable` at the violation site. Each entry
  // shrinks as its phase lands; the rule promotes to whole-tree when the list is
  // empty. A NEW literal / inlined gate in ANY file not listed here still errors.
  {
    files: [
      // engine-literal debt (P1 EngineRegistry relocates these):
      "src/tools/session-registry.ts",
      "src/session/managed.ts",
      "src/session/incognito.ts",
      "src/session/byob.ts",
      "src/server.ts",
      "src/cli/doctor.ts",
      // inlined capability-check debt (P2 colocates the gate at host.register):
      "src/tools/read-observe-tools.ts",
      "src/tools/emulation-config-tools.ts",
      "src/tools/extensions-batch-tools.ts",
      "src/tools/forms-recording-tools.ts",
      "src/tools/plugin-runtime.ts",
      "src/sdk/client.ts",
      "src/sdk/registry.ts",
    ],
    rules: {
      "browxai-local/no-engine-literal-branches": "off",
      "browxai-local/no-inlined-capability-checks": "off",
    },
  },
  // Page-side code (runs inside the browser via page.evaluate(fn, args)).
  {
    files: ["src/page/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  // Test files — relax async-safety + console hygiene.
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "test/**/*.ts", "src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
      // Tests routinely coerce `unknown` payloads (e.g. captured warn-call
      // args from a vitest spy) into strings for regex-matchers — `String(x
      // ?? "")` is the pattern of record. Off here; production code still
      // gates as error.
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      // The RFC 0004 architecture guardrails target the HANDLER / production
      // layer — tests legitimately read TOOL_CAPABILITY, drive `caps.has(...)`,
      // and parametrize over EngineKind literals (the fitness suite itself does
      // exactly this to FREEZE those surfaces). Off in tests; production gates as
      // error.
      "browxai-local/no-engine-literal-branches": "off",
      "browxai-local/no-inlined-capability-checks": "off",
    },
  },
  // src/server.ts + src/tools/* — MCP tool-handler registration. The MCP SDK's
  // `s.tool(name, schema, handler)` signature requires the handler to
  // return `Promise<ToolResponse>`, so handlers must be declared `async`
  // even when the body is intrinsically synchronous (gate-check + sync
  // file read + JSON.stringify). The honest fixes are either (a) a
  // structural change to the handler-registration shape that accepts
  // sync handlers, or (b) wrapping every literal return in `Promise.resolve(...)`
  // and dropping `async` (many sites × ~3 returns each = mechanical
  // changes that add no value to the reader). Off here; every other file
  // in the tree gates `require-await` as error. The per-family tool modules
  // own the same register() blocks the composition root used to, so the same
  // exemption applies.
  {
    files: ["src/server.ts", "src/tools/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },
  // Tooling scripts — console is the output channel.
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.js", "scripts/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  // Config files.
  {
    files: ["*.config.{ts,js,mjs}", "vitest.*.config.ts", "eslint.config.js"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
);
