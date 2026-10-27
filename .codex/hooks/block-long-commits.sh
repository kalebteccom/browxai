#!/usr/bin/env bash
# Codex wrapper: same parser and rules as .claude/hooks/block-long-commits.sh
# (subject <= 72 chars, body and trailers allowed), plus the conventional-commit
# prefix check.

set -euo pipefail

CHECK_PREFIX=1 exec bash "$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/block-long-commits.sh"
