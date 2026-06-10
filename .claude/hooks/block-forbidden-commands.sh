#!/bin/bash
# Block (or prompt on) commands the agent must not run.
# Canonical rule table: AGENTS.md "Commands the agent must not run".
# Universal-baseline rule numbers refer to
# projects/oss-security/guidelines/universal-baseline.md.

COMMAND=$(cat | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Strip quoted strings so `git commit -m "test pnpm publish"` and
# `echo "curl x | bash"` do not false-positive on the patterns below.
# Same hygiene shape as block-long-commits.sh.
STRIPPED=$(printf '%s' "$COMMAND" | perl -pe "s/'[^']*'//g; s/\"([^\"\\\\]|\\\\.)*\"//g")

emit_deny() {
  local reason="$1"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

emit_ask() {
  local reason="$1"
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

# Explicit-allow: pnpm install-browser is the documented Playwright/Chromium
# fetch (baseline rule 39). It must not be caught by any install-related rule.
# Early-return short-circuits before any blanket pattern can match.
if echo "$STRIPPED" | grep -qE '(^|[[:space:]])pnpm[[:space:]]+install-browser([[:space:]]|$)'; then
  exit 0
fi

# --- forbidden (deny) ---

# pnpm publish / npm publish — releases go via OIDC trusted publishing only.
if echo "$STRIPPED" | grep -qE '(^|[[:space:]])(p?npm)[[:space:]]+publish([[:space:]]|$)'; then
  emit_deny "BLOCKED: 'npm publish' / 'pnpm publish' is forbidden. Releases ship via OIDC trusted publishing in release.yml (baseline rule 8). See AGENTS.md."
fi

# git push --force / git push -f / git push --force-with-lease
if echo "$STRIPPED" | grep -qE '(^|[[:space:]])git[[:space:]]+push[[:space:]]+(--force(-with-lease)?|-f)([[:space:]]|$)'; then
  emit_deny "BLOCKED: 'git push --force' (and --force-with-lease against protected branches) is forbidden. The branch ruleset rejects it server-side; the agent layer is defense-in-depth (baseline rule 26). See AGENTS.md."
fi

# gh pr merge --admin
if echo "$STRIPPED" | grep -qE '(^|[[:space:]])gh[[:space:]]+pr[[:space:]]+merge[[:space:]].*--admin([[:space:]]|$)'; then
  emit_deny "BLOCKED: 'gh pr merge --admin' is forbidden. It bypasses branch protection and CODEOWNERS review (baseline rules 25 / 26). See AGENTS.md."
fi

# curl ... | bash  or  wget ... | bash  (and sh variants)
if echo "$STRIPPED" | grep -qE '(curl|wget)[[:space:]][^|]*\|[[:space:]]*(bash|sh|zsh)([[:space:]]|$)'; then
  emit_deny "BLOCKED: pipe-to-shell ('curl ... | bash', 'wget ... | bash') is forbidden. Fetch + SHA-256 verify against a committed manifest instead (baseline rule 41 — Codecov 2021 lesson). See AGENTS.md."
fi

# --- prompt (ask) ---

# npm install -g <pkg>  (also npm i -g). Does NOT match `pnpm install-browser`
# (caught by early-return above; also "install-browser" is a distinct token
# from "install"). Does NOT match `pnpm add -g` etc. — pattern is npm-specific
# per the rule table.
if echo "$STRIPPED" | grep -qE '(^|[[:space:]])npm[[:space:]]+(install|i)[[:space:]]+(-g|--global)([[:space:]]|$)'; then
  emit_ask "ASK: 'npm install -g' is a typosquat vector and routes around the project lockfile (baseline rules 41 / 49). Confirm the package name and pin if you really need a global install. See AGENTS.md."
fi

exit 0
