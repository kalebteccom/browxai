#!/usr/bin/env bash
# Install the one pinned Lighthouse into a fresh scratch directory inside the pipeline workspace. Fails closed on an integrity mismatch.
#   lighthouse 13.6.0 (Apache-2.0), npm integrity pinned below; --ignore-scripts, nothing global, no browser download.
# Vetting (order 37): 136 packages, none with an install script, puppeteer-core ^25.16.0 as a dependency (design-audit pins the same line).
#   Telemetry: none in the library. The CLI's Sentry error reporting is opt-in and never loaded here, because run.mjs uses the programmatic API.
# Only lighthouse itself is pinned by integrity; its dependencies resolve from the registry at install time, and the log prints the whole tree.
# Usage: fetch-tools.sh <empty-dir>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: fetch-tools.sh <empty-dir>}"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "fetch-tools: $OUT is not empty" >&2
  exit 2
fi
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

LH_VERSION=13.6.0
LH_INTEGRITY='sha512-2/HUPUpQyGm01VEgYCUjSlNZY7Zkhk1v3QI4c7UTbnaoRB7HF0qYMPzzaiidNf5iqw5wnmtm9LpGawKKqCfLmg=='

echo "==> lighthouse $LH_VERSION (--ignore-scripts, no browser download)"
npm install --prefix "$OUT" --ignore-scripts --no-audit --no-fund --save-exact "lighthouse@$LH_VERSION"
node "$HERE/check-lock.mjs" "$OUT/package-lock.json" "$LH_VERSION" "$LH_INTEGRITY"
echo "==> tools ready in $OUT"
