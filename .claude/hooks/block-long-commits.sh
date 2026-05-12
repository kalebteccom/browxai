#!/bin/bash
# Block git commits with subject lines that are too long or messages that
# contain a body section. Keeps commit messages short and single-purpose.

MAX_SUBJECT_LENGTH=72

COMMAND=$(cat | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Only inspect git commit commands
if ! echo "$COMMAND" | grep -qi 'git commit'; then
  exit 0
fi

# Extract the commit message using bash parameter expansion (multiline-safe).
# Step 1: strip everything up to -m "
AFTER_M="${COMMAND#*-m \"}"
if [ "$AFTER_M" = "$COMMAND" ]; then
  AFTER_M="${COMMAND#*-m \'}"
fi
# Step 2: strip trailing quote and anything after it
MSG="${AFTER_M%\"*}"
if [ "$MSG" = "$AFTER_M" ]; then
  MSG="${AFTER_M%\'*}"
fi

# Step 3: strip heredoc markers if present (cat <<'EOF' ... EOF)
MSG=$(echo "$MSG" | grep -v '^\$(cat <<' | grep -v '^EOF$' | grep -v '^)[[:space:]]*$')

if [ -z "$MSG" ]; then
  exit 0
fi

# Get the first line (subject) and count non-empty lines
SUBJECT=$(echo "$MSG" | head -1)
SUBJECT_LEN=${#SUBJECT}
LINE_COUNT=$(echo "$MSG" | grep -c '.')

ERRORS=""

if [ "$SUBJECT_LEN" -gt "$MAX_SUBJECT_LENGTH" ]; then
  ERRORS="Subject line is ${SUBJECT_LEN} chars (max ${MAX_SUBJECT_LENGTH})."
fi

if [ "$LINE_COUNT" -gt 1 ]; then
  if [ -n "$ERRORS" ]; then
    ERRORS="${ERRORS} "
  fi
  ERRORS="${ERRORS}Message has ${LINE_COUNT} lines — keep it to a single subject line."
fi

if [ -n "$ERRORS" ]; then
  REASON="BLOCKED: ${ERRORS} Write a concise, single-line commit message (max ${MAX_SUBJECT_LENGTH} chars). No body, no bullet points."
  jq -n --arg reason "$REASON" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
else
  exit 0
fi
