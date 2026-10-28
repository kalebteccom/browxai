#!/usr/bin/env bash
# Serve the built docs site on 127.0.0.1 and run Lighthouse (mobile and desktop, 3 runs each) on the key pages, then print the block.
# Usage: run-audit.sh <audit-dir>   (from the repo root; needs website/dist, <audit-dir>/tools from fetch-tools.sh and <audit-dir>/bin/chrome-fenced from design-audit/fence.sh)
# Chrome only ever starts through the fenced wrapper. Node runs in a minimal environment: CI=1, update notices and telemetry off, throwaway HOME.
# Exit status: 0 every median at or above the thresholds (performance 0.9, accessibility 1, best-practices 1, seo 1; see block.mjs), 1 below one of them, 2 a tool error.
set -uo pipefail

AUDIT="$(cd "${1:?usage: run-audit.sh <audit-dir>}" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(pwd)"
DIST="$ROOT/website/dist"
PORT=4322
BASE="http://127.0.0.1:$PORT"
WRAP="$AUDIT/bin/chrome-fenced"
TOOLS="$AUDIT/tools"
RESULTS="$AUDIT/lighthouse-results.json"
# Canonical URLs only, as built: directory pages with their trailing slash, the 404 page as its file.
PAGES="/ /404.html /guides/configuration/ /guides/troubleshooting/ /reference/tool-reference/ /security/threat-model/"

for f in "$WRAP" "$TOOLS/node_modules/lighthouse/package.json"; do
  [ -e "$f" ] || { echo "run-audit: missing $f" >&2; exit 2; }
done
for p in $PAGES; do
  f="$DIST$p"
  case "$p" in */) f="${f}index.html" ;; esac
  [ -f "$f" ] || { echo "run-audit: $p has no file in website/dist ($f)" >&2; exit 2; }
done
rm -rf "$AUDIT/home" "$AUDIT/tmp" "$RESULTS"
mkdir -p "$AUDIT/home" "$AUDIT/tmp"

node "$ROOT/scripts/design-audit/serve.mjs" "$DIST" "$PORT" > "$AUDIT/server.log" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl --silent --fail --output /dev/null "$BASE/" && break
  sleep 1
done
curl --silent --fail --output /dev/null "$BASE/" || { echo "run-audit: the site did not come up on $BASE" >&2; exit 2; }

# env -i drops everything the pipeline exports; only what Lighthouse and Chrome need goes in.
# shellcheck disable=SC2086
env -i PATH="$PATH" HOME="$AUDIT/home" TMPDIR="$AUDIT/tmp" CI=1 NO_UPDATE_NOTIFIER=1 DO_NOT_TRACK=1 \
  node "$HERE/run.mjs" "$TOOLS" "$WRAP" "$BASE" "$RESULTS" $PAGES
RC=$?
if [ "$RC" -ne 0 ] || [ ! -s "$RESULTS" ]; then
  echo "FAILED: run.mjs (exit $RC), no results to report"
  exit 2
fi

echo "== lighthouse: report start =="
node "$HERE/report.mjs" "$RESULTS"
REPORT_RC=$?
echo "== lighthouse: report end (exit $REPORT_RC) =="
exit "$REPORT_RC"
