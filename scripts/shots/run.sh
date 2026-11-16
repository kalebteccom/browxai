#!/usr/bin/env bash
# Serve the built docs site on 127.0.0.1 and capture the home page and getting-started as images, printed to the step log.
# Usage: run.sh <audit-dir>   (from the repo root; needs website/dist, <audit-dir>/bin/chrome-fenced and <audit-dir>/fence.ok from the fence step)
# Chrome only ever starts through the fenced wrapper. Images are also written to <audit-dir>/shots/, with the whole log in shots.log.
# Exit status: 0 all images captured, 1 a capture failed, 2 a missing input or the site did not come up.
set -uo pipefail

AUDIT="$(cd "${1:?usage: run.sh <audit-dir>}" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(pwd)"
DIST="$ROOT/website/dist"
PORT=4323
BASE="http://127.0.0.1:$PORT"
WRAP="$AUDIT/bin/chrome-fenced"
OUT="$AUDIT/shots"

for f in "$WRAP" "$AUDIT/fence.ok" "$DIST/index.html" "$DIST/getting-started/index.html"; do
  [ -e "$f" ] || { echo "shots: missing $f" >&2; exit 2; }
done

rm -rf "$OUT"
mkdir -p "$OUT"

# The same static server design-audit uses, on its own port.
node "$ROOT/scripts/design-audit/serve.mjs" "$DIST" "$PORT" > "$AUDIT/shots-server.log" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl --silent --fail --output /dev/null "$BASE/" && break
  sleep 1
done
curl --silent --fail --output /dev/null "$BASE/" || { echo "shots: the site did not come up on $BASE" >&2; exit 2; }

echo "== shots: capture start =="
node "$HERE/capture.mjs" "$WRAP" "$BASE" "$OUT" 2>&1 | tee "$OUT/shots.log"
RC=$?
echo "== shots: capture end (exit $RC) =="
ls -l "$OUT"
exit "$RC"
