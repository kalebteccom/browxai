#!/usr/bin/env bash
# First-run measurement of the published package: a clean install from the npm registry, the getting-started page followed step
# by step, a first snapshot, the tools/list sizes, and the documented paths the first flow does not reach (serve --socket with two
# clients, stdio-child, plugin CLI, capability refusal, doctor attach, help flags). Prints four blocks, each between FIRST-RUN BEGIN
# and FIRST-RUN END.
# Usage: run.sh <audit-dir>   (from the repo root; node and npm on PATH; needs the npm registry, the Playwright browser CDN and, for
#        the page's --with-deps command, the distro package mirrors. Nothing is read from the repo except the docs and these scripts.)
# Work happens in a fresh temp directory with a throwaway HOME and npm cache; full command logs go to <audit-dir>/first-run/.
# Chrome only starts through the loopback fence (install.mjs wraps Playwright's binaries with scripts/design-audit/fence.sh's wrapper
# and proves it; snapshot.mjs and paths.mjs refuse to start a browser without the proof, sizes.mjs starts none).
# Exit status: 0 the commands ran as documented, 1 a documented command failed or differs, 2 a tool error (the worst of the four sections).
set -uo pipefail

AUDIT="$(mkdir -p "${1:?usage: run.sh <audit-dir>}" && cd "$1" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(pwd)"
WORK="$(mktemp -d -t browxai-first-run.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
export FR_ROOT="$ROOT" FR_WORK="$WORK" FR_OUT="$AUDIT"
export NO_UPDATE_NOTIFIER=1 DO_NOT_TRACK=1
mkdir -p "$AUDIT/first-run"

echo "== first-run: $(node --version), npm $(npm --version), $(uname -srm), uptime $(uptime | sed 's/^.*load/load/') =="

node "$HERE/install.mjs"
R1=$?
if [ ! -x "$WORK/project/node_modules/.bin/browxai" ]; then
  echo "== first-run: nothing installed (install exit $R1), so the snapshot, size and paths sections were skipped =="
  echo "FIRST-RUN RESULT install=$R1 snapshot=skipped sizes=skipped paths=skipped exit=2"
  exit 2
fi

# The snapshot section starts a browser, so it needs the fence proof. The size section starts none.
if [ -f "$WORK/fence.ok" ]; then
  node "$HERE/snapshot.mjs"
  R2=$?
else
  echo "== first-run: no fence proof, so the snapshot section was skipped =="
  R2=2
fi
node "$HERE/sizes.mjs"
R3=$?
# The paths section runs its browser-free parts without the fence proof and skips (exit 2) the parts that start Chrome.
node "$HERE/paths.mjs"
R4=$?

RC=0
for r in "$R1" "$R2" "$R3" "$R4"; do
  [ "$r" -eq 1 ] && [ "$RC" -eq 0 ] && RC=1
  [ "$r" -ge 2 ] && RC=2
done
echo "FIRST-RUN RESULT install=$R1 snapshot=$R2 sizes=$R3 paths=$R4 exit=$RC"
exit "$RC"
