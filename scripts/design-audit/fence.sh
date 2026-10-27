#!/usr/bin/env bash
# Write a Chrome wrapper that can only reach loopback, and print its path.
# Usage: fence.sh <audit-dir>   (needs playwright-core in the workspace and its chromium in PLAYWRIGHT_BROWSERS_PATH)
# The wrapper sends every non-loopback request to a dead proxy and maps every non-loopback host name to NOTFOUND.
# Extra flags (for example the colour scheme) come from EXTRA_CHROME_FLAGS at launch time.
# Chrome's own sandbox needs user namespaces, which a root container lacks; the wrapper adds --no-sandbox only for root, where the fence stands in and the page is our own build.
set -euo pipefail

AUDIT="${1:?usage: fence.sh <audit-dir>}"
mkdir -p "$AUDIT/bin"
REAL_CHROME="$(node -e "process.stdout.write(require('playwright-core').chromium.executablePath())")"
if [ ! -x "$REAL_CHROME" ]; then
  echo "fence: no chromium at $REAL_CHROME (run playwright-core install chromium first)" >&2
  exit 1
fi
WRAP="$AUDIT/bin/chrome-fenced"
{
  echo '#!/bin/sh'
  echo 'SANDBOX=""'
  echo '[ "$(id -u)" = 0 ] && SANDBOX="--no-sandbox"'
  echo "exec '$REAL_CHROME' \\"
  echo "  --proxy-server=http://127.0.0.1:1 --proxy-bypass-list='127.0.0.1;localhost' \\"
  echo "  --host-resolver-rules='MAP * ~NOTFOUND , EXCLUDE 127.0.0.1' \\"
  echo '  $SANDBOX ${EXTRA_CHROME_FLAGS:-} "$@"'
} > "$WRAP"
chmod 755 "$WRAP"
echo "$WRAP"
