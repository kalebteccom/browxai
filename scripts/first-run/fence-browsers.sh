#!/usr/bin/env bash
# Put the loopback fence in front of every Chrome binary Playwright downloaded, so browxai (which launches Playwright's
# bundled Chromium when no Google Chrome is installed) can only reach loopback, whichever way it starts the browser.
# Usage: fence-browsers.sh <browsers-dir> <work-dir>   (the same wrapper scripts/design-audit/fence.sh writes for the other manual workflows)
# Each binary `chrome` or `chrome-headless-shell` is renamed to `<name>.real` and replaced by the wrapper, which execs the renamed file from the same directory (Chrome finds its resources next to itself).
# Exit status: 0 done, 2 no binary found or a wrapper could not be written.
set -euo pipefail

BROWSERS="$(cd "${1:?usage: fence-browsers.sh <browsers-dir> <work-dir>}" && pwd)"
WORK="${2:?usage: fence-browsers.sh <browsers-dir> <work-dir>}"
mkdir -p "$WORK"
WORK="$(cd "$WORK" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
FENCE="$HERE/../design-audit/fence.sh"
[ -f "$FENCE" ] || { echo "fence-browsers: missing $FENCE" >&2; exit 2; }

mapfile -t EXES < <(find "$BROWSERS" -maxdepth 4 -type f \( -name chrome -o -name chrome-headless-shell \) | sort)
[ "${#EXES[@]}" -gt 0 ] || { echo "fence-browsers: no chrome binary under $BROWSERS" >&2; exit 2; }

n=0
for exe in "${EXES[@]}"; do
  n=$((n + 1))
  [ -e "$exe.real" ] && continue
  mv "$exe" "$exe.real"
  wrapper="$(REAL_CHROME="$exe.real" bash "$FENCE" "$WORK/fence-$n")" || { echo "fence-browsers: fence.sh failed for $exe" >&2; exit 2; }
  cp "$wrapper" "$exe"
  chmod 755 "$exe"
  echo "fenced $exe"
done
