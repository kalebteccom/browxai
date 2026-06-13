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

const browxaiLocal = {
  rules: {
    "no-tracker-ids-in-comments": noTrackerIdsInComments,
    "no-page-eval-stringified-arrow": noPageEvalStringifiedArrow,
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

      // Stage 2d: DEFERRED to a follow-up structural refactor. The right fix
      // is a typed wrapper layer for the MCP boundary — Zod-validate every
      // tools/call payload at intake (so the handler body sees a typed
      // object, not `unknown` JSON.parse output) AND a typed wrapper for
      // page.evaluate() returns (so DOM-side results don't pollute Node-side
      // typing with `any`). 1262 warnings in this codebase resolve when
      // those wrappers land — primarily concentrated in src/server.ts
      // (905, gated on the same src/server.ts frame-handling refactor
      // flagged in Stage 2c) and src/page/*.ts (357, gated on the
      // page.evaluate() wrapper). Re-enable as `error` once both wrappers
      // are in place.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",

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
    },
  },
  // src/server.ts — MCP tool-handler registration. The MCP SDK's
  // `s.tool(name, schema, handler)` signature requires the handler to
  // return `Promise<ToolResponse>`, so handlers must be declared `async`
  // even when the body is intrinsically synchronous (gate-check + sync
  // file read + JSON.stringify). The honest fixes are either (a) a
  // structural change to the handler-registration shape that accepts
  // sync handlers (same scope as the frame-handling refactor flagged in
  // Stage 2c), or (b) wrapping every literal return in `Promise.resolve(...)`
  // and dropping `async` (18 sites × ~3 returns each = ~54 mechanical
  // changes that add no value to the reader). Off here; every other file
  // in the tree gates `require-await` as error.
  {
    files: ["src/server.ts"],
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
