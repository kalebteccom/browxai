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
# Step 2: cut at the FIRST closing quote. `%%` (longest match from the end) is
# what makes that the first quote rather than the last: with `%` a compound
# command whose later parts contain quotes — `git commit -m "x" && grep -E "y"`
# — captured everything up to the grep pattern, so a one-line message spanning
# a multi-line shell command was rejected as a multi-line message.
MSG="${AFTER_M%%\"*}"
if [ "$MSG" = "$AFTER_M" ]; then
  MSG="${AFTER_M%%\'*}"
fi

# Step 3: strip heredoc markers if present (cat <<'EOF' ... EOF)
MSG=$(echo "$MSG" | grep -v '^\$(cat <<' | grep -v '^EOF$' | grep -v '^)[[:space:]]*$')

if [ -z "$MSG" ]; then
  exit 0
fi

# Get the first line (subject) and count non-empty lines. Git trailers
# (`Key: value`, RFC-822 shape) do not count: AGENTS.md asks every agent commit
# to carry Co-Authored-By and Claude-Session, and a rule that forbids them makes
# the repo's own attribution requirement impossible to satisfy. What this hook
# exists to stop is a prose body, which a trailer is not.
SUBJECT=$(echo "$MSG" | head -1)
SUBJECT_LEN=${#SUBJECT}
BODY_LINES=$(echo "$MSG" | grep '.' | grep -cvE '^[A-Za-z][A-Za-z-]*: ')
LINE_COUNT=$BODY_LINES

ERRORS=""

if [ "$SUBJECT_LEN" -gt "$MAX_SUBJECT_LENGTH" ]; then
  ERRORS="Subject line is ${SUBJECT_LEN} chars (max ${MAX_SUBJECT_LENGTH})."
fi

if [ "$LINE_COUNT" -gt 1 ]; then
  if [ -n "$ERRORS" ]; then
    ERRORS="${ERRORS} "
  fi
  ERRORS="${ERRORS}Message has ${LINE_COUNT} body lines — keep it to a single subject line."
fi

if [ -n "$ERRORS" ]; then
  REASON="BLOCKED: ${ERRORS} Write a concise, single-line commit message (max ${MAX_SUBJECT_LENGTH} chars). No body, no bullet points. Git trailers (Co-Authored-By, Claude-Session) are allowed and do not count."
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
