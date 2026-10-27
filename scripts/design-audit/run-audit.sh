#!/usr/bin/env bash
# Serve the built docs site on 127.0.0.1 and run impeccable (320, 390, 1440) and hallmark sloplint --render on the key pages.
# Usage: run-audit.sh <audit-dir>   (from the repo root; needs website/dist, <audit-dir>/tools from fetch-tools.sh,
#        <audit-dir>/bin/chrome-fenced and <audit-dir>/themes from the fence step)
# Chrome only ever starts through the fenced wrapper. The tools run in a minimal environment: no CI variable (impeccable adds --no-sandbox when it is set), throwaway HOME, telemetry off.
# Never runs hallmark redesign, install-hook, imagegen or audit, and never passes --cdp. Exit status comes from summarize.mjs.
set -uo pipefail

AUDIT="$(cd "${1:?usage: run-audit.sh <audit-dir>}" && pwd)"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(pwd)"
DIST="$ROOT/website/dist"
PORT=4321
BASE="http://127.0.0.1:$PORT"
WRAP="$AUDIT/bin/chrome-fenced"
IMP="$AUDIT/tools/bin/impeccable"
HM="$AUDIT/tools/hallmark/sloplint.mjs"
PPT="$AUDIT/tools/puppeteer"
OUT="$AUDIT/out"
HOME_DIR="$AUDIT/home"
PAGES="/ /404.html /guides/configuration/ /guides/troubleshooting/ /reference/tool-reference/ /security/threat-model/"
WIDTHS="320x700 390x844 1440x900"

for f in "$WRAP" "$IMP" "$HM" "$AUDIT/themes"; do
  [ -e "$f" ] || { echo "run-audit: missing $f" >&2; exit 2; }
done
# The themes file has one "<theme> <chrome flag>" line per theme the fence test could emulate.
THEMES="$(awk '{print $1}' "$AUDIT/themes")"
rm -rf "$OUT" "$HOME_DIR" "$AUDIT/cwd"
mkdir -p "$OUT" "$HOME_DIR" "$AUDIT/cwd" "$AUDIT/empty"

for p in $PAGES; do
  f="$DIST$p"
  case "$p" in */) f="${f}index.html" ;; esac
  [ -f "$f" ] || { echo "run-audit: $p has no file in website/dist ($f)" >&2; exit 2; }
done

node "$HERE/serve.mjs" "$DIST" "$PORT" > "$AUDIT/server.log" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do
  curl --silent --fail --output /dev/null "$BASE/" && break
  sleep 1
done
curl --silent --fail --output /dev/null "$BASE/" || { echo "run-audit: the site did not come up on $BASE" >&2; exit 2; }

slug() { case "$1" in /) echo home ;; *) echo "$1" | sed 's#^/##; s#/$##; s#[/.]#_#g' ;; esac; }
flags() { awk -v t="$1" '$1 == t {print $2}' "$AUDIT/themes"; }
# env -i drops CI and everything else the pipeline exports; only what the tools need goes in.
tool_env() {
  env -i PATH="$PATH" HOME="$HOME_DIR" TMPDIR="$AUDIT/tmp" DO_NOT_TRACK=1 IMPECCABLE_NO_TELEMETRY=1 "$@"
}
mkdir -p "$AUDIT/tmp"

for theme in $THEMES; do
  for page in $PAGES; do
    s="$(slug "$page")"
    for size in $WIDTHS; do
      w="${size%x*}"
      base="$OUT/imp-$theme-$w-$s"
      echo "impeccable $theme $w $page"
      tool_env IMPECCABLE_BROWSER="$WRAP" EXTRA_CHROME_FLAGS="$(flags "$theme")" \
        "$IMP" detect --json --no-config --no-design-system --no-inline-ignores \
        --viewport "$size" "$BASE$page" > "$base.json" 2> "$base.err"
      echo $? > "$base.rc"
    done
    base="$OUT/hm-$theme-$s"
    echo "hallmark $theme $page"
    mkdir -p "$AUDIT/cwd/$theme-$s"
    (
      cd "$AUDIT/cwd/$theme-$s" &&
        tool_env HALLMARK_PUPPETEER="$PPT" CHROME_PATH="$WRAP" EXTRA_CHROME_FLAGS="$(flags "$theme")" \
          node "$HM" "$AUDIT/empty" --render --url "$BASE$page" --json --tier floor
    ) > "$base.json" 2> "$base.err"
    echo $? > "$base.rc"
  done
done

# Element dump: which elements sit behind rule 58 and line-length. Light theme, 1440 only; loopback fence unchanged.
for page in $PAGES; do
  s="$(slug "$page")"
  tool_env CHROME_PATH="$WRAP" EXTRA_CHROME_FLAGS="$(flags light)" \
    node "$HERE/element-dump.mjs" "$PPT" "$WRAP" "$BASE$page" "$OUT/hm-light-$s.json" "$OUT/imp-light-1440-$s.json" \
    2>/dev/null | head -c 2000 > "$OUT/dump-$s.txt" || true
done

node "$HERE/summarize.mjs" "$OUT" "$AUDIT/themes"
