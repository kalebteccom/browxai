#!/usr/bin/env bash
# Block generated git commit commands with non-semantic, long, or multiline messages.

set -euo pipefail

max_subject_length=72
conventional_subject_pattern='^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9][a-z0-9._/-]*\))?!?: .+'
payload="$(cat)"
command="$(
  printf '%s' "$payload" \
    | jq -r '.tool_input.command // .command // empty' 2>/dev/null \
    || true
)"
command_without_quoted_text="$(
  printf '%s' "$command" \
    | sed -E "s/'[^']*'//g; s/\"([^\"\\]|\\.)*\"//g"
)"

if [[ -z "$command" || ! "$command_without_quoted_text" =~ (^[[:space:]]*|[;&|][[:space:]]*)git[[:space:]]+commit([[:space:]]|$) ]]; then
  exit 0
fi

message=""
message_arg_count="$(
  printf '%s' "$command" \
    | { grep -Eo '(^|[[:space:]])(-m|--message=)' || true; } \
    | wc -l \
    | tr -d ' '
)"

if [[ "$command" =~ --message= ]]; then
  message="${command#*--message=}"
elif [[ "$command" =~ [[:space:]]-m[[:space:]] ]]; then
  message="${command#* -m }"
fi

errors=()
if [[ -z "$message" ]]; then
  if [[ "$command" =~ --no-edit ]]; then
    exit 0
  fi
  errors+=("commit message is not visible to the hook; use -m/--message")
fi

quote="${message:0:1}"
if [[ -n "$message" && ( "$quote" == "\"" || "$quote" == "'" ) ]]; then
  message="${message:1}"
  message="${message%%$quote*}"
elif [[ -n "$message" ]]; then
  message="${message%% *}"
fi

subject="$(printf '%s' "$message" | sed -n '1p')"
line_count="$(printf '%s' "$message" | grep -c '[^[:space:]]' || true)"
subject_length="${#subject}"

if (( subject_length > max_subject_length )); then
  errors+=("subject is ${subject_length} characters; max is ${max_subject_length}")
fi
if [[ -n "$subject" && ! "$subject" =~ $conventional_subject_pattern ]]; then
  errors+=("subject must use Conventional Commits, e.g. fix(api): handle token refresh")
fi
if (( line_count > 1 )); then
  errors+=("message has ${line_count} non-empty lines; use a single subject line")
fi
if (( message_arg_count > 1 )); then
  errors+=("message uses multiple -m/--message arguments; use only one subject")
fi

if (( ${#errors[@]} > 0 )); then
  reason="BLOCKED: $(IFS='; '; echo "${errors[*]}")."
  jq -n --arg reason "$reason" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
fi
