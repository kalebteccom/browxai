#!/usr/bin/env bash
# Serve the built docs site on 127.0.0.1. impeccable (320, 390, 1440) runs on every page of the built site, light and dark; hallmark sloplint --render
# stays on the fixed set (FIXED_PAGES), because its runs are the slow ones. The page list comes from list-pages.mjs (dist sitemap, plus /404.html) at run time.
# Usage: run-audit.sh <audit-dir>   (from the repo root; needs website/dist, <audit-dir>/tools from fetch-tools.sh,
#        <audit-dir>/bin/chrome-fenced and <audit-dir>/themes from the fence step)
# Chrome only ever starts through the fenced wrapper. The tools run in a minimal environment: no CI variable (impeccable adds --no-sandbox when it is set), throwaway HOME, telemetry off.
# Never runs hallmark redesign, install-hook, imagegen or audit, and never passes --cdp. Exit status: 1 when there are findings that are not kept, 2 on a tool error or a crash in the summary (summarize.mjs sets it).
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
# The fixed set: hallmark, the element dump and the log's first lines use these. They are audited first.
FIXED_PAGES="/ /404.html /guides/configuration/ /guides/troubleshooting/ /reference/tool-reference/ /security/threat-model/"
WIDTHS="320x700 390x844 1440x900"
# Soft deadline for the page loop, below GATE_STEP_BUDGET_SECS (3000 in design-audit.yml). Past it no new page starts, the pages left are listed
# in out/skipped.txt, and the run still prints its findings block (a step killed by the budget prints nothing).
SOFT_SECS="${AUDIT_SOFT_SECS:-2400}"

for f in "$WRAP" "$IMP" "$HM" "$AUDIT/themes"; do
  [ -e "$f" ] || { echo "run-audit: missing $f" >&2; exit 2; }
done
# The themes file has one "<theme> <chrome flag>" line per theme the fence test could emulate.
THEMES="$(awk '{print $1}' "$AUDIT/themes")"
rm -rf "$OUT" "$HOME_DIR" "$AUDIT/cwd"
mkdir -p "$OUT" "$HOME_DIR" "$AUDIT/cwd" "$AUDIT/empty"

ALL_PAGES="$(node "$HERE/list-pages.mjs" "$DIST")" || { echo "run-audit: could not list the pages of website/dist" >&2; exit 2; }
for p in $FIXED_PAGES; do
  case " $(echo $ALL_PAGES) " in *" $p "*) ;; *) echo "run-audit: fixed page $p is not in the built site" >&2; exit 2 ;; esac
done
# Fixed pages first, then the rest in sitemap order.
PAGES="$FIXED_PAGES"
for p in $ALL_PAGES; do
  case " $FIXED_PAGES " in *" $p "*) ;; *) PAGES="$PAGES $p" ;; esac
done
echo "run-audit: $(echo $PAGES | wc -w) pages ($(echo $FIXED_PAGES | wc -w) fixed), $(echo $THEMES | wc -w) themes, impeccable at $(echo $WIDTHS | wc -w) widths on every page"

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

START_TS="$(date +%s)"
: > "$OUT/skipped.txt"
: > "$OUT/pages.txt"
for page in $PAGES; do
  s="$(slug "$page")"
  case " $FIXED_PAGES " in *" $page "*) fixed=1 ;; *) fixed=0 ;; esac
  echo "$s $page $fixed" >> "$OUT/pages.txt"
  if [ "$fixed" -eq 0 ] && [ $(($(date +%s) - START_TS)) -ge "$SOFT_SECS" ]; then
    echo "$page" >> "$OUT/skipped.txt"
    echo "skipped $page (soft deadline of $SOFT_SECS s passed)"
    continue
  fi
  for theme in $THEMES; do
    for size in $WIDTHS; do
      w="${size%x*}"
      base="$OUT/imp-$theme-$w-$s"
      echo "impeccable $theme $w $page"
      tool_env IMPECCABLE_BROWSER="$WRAP" EXTRA_CHROME_FLAGS="$(flags "$theme")" \
        "$IMP" detect --json --no-config --no-design-system --no-inline-ignores \
        --viewport "$size" "$BASE$page" > "$base.json" 2> "$base.err"
      echo $? > "$base.rc"
    done
    [ "$fixed" -eq 1 ] || continue
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
# Fixed pages only (they are the ones with a hallmark result). Each page runs on its own: a failure prints its stderr and the run goes on. element-dump.mjs has its own 100 s deadline.
echo "== audit: element dump start =="
for page in $FIXED_PAGES; do
  s="$(slug "$page")"
  tool_env CHROME_PATH="$WRAP" EXTRA_CHROME_FLAGS="$(flags light)" \
    node "$HERE/element-dump.mjs" "$PPT" "$WRAP" "$BASE$page" "$OUT/hm-light-$s.json" "$OUT/imp-light-1440-$s.json" \
    > "$OUT/dump-$s.txt" 2> "$OUT/dump-$s.err"
  rc=$?
  [ "$rc" -eq 0 ] || echo "FAILED: element-dump $page (exit $rc)"
  [ -s "$OUT/dump-$s.err" ] && { echo "element-dump $page stderr:"; head -c 1500 "$OUT/dump-$s.err"; echo; }
done
echo "== audit: element dump end =="

echo "== audit: summary start =="
SUMMARY_RC=0
if node "$HERE/summarize.mjs" "$OUT" "$AUDIT/themes" > "$AUDIT/findings.txt" 2> "$AUDIT/summarize.err"; then
  SUMMARY_RC=0
else
  SUMMARY_RC=$?
fi
if [ ! -s "$AUDIT/findings.txt" ] || [ "$SUMMARY_RC" -gt 2 ]; then
  echo "FAILED: summarize.mjs (exit $SUMMARY_RC)"
  head -c 3000 "$AUDIT/summarize.err"
  echo "raw per-tool counts (exit codes, then findings per file):"
  for t in imp hm; do
    echo "$t exit codes: $(cat "$OUT"/$t-*.rc 2>/dev/null | sort | uniq -c | tr '\n' ' ')"
  done
  for f in "$OUT"/*.json; do echo "$(basename "$f") $(grep -o '"id"\|"gate"' "$f" 2>/dev/null | wc -l)"; done
  SUMMARY_RC=2
else
  cat "$AUDIT/findings.txt"
  # The same text again in 1.5 KB chunks, so a log service that drops a long line still leaves it readable.
  split -b 1500 -d -a 3 "$AUDIT/findings.txt" "$AUDIT/findings.chunk."
  n=0
  for c in "$AUDIT"/findings.chunk.*; do
    n=$((n + 1))
    sed "s/^/FINDINGS|$n|/" "$c"
  done
  rm -f "$AUDIT"/findings.chunk.*
fi
echo "== audit: summary end (exit $SUMMARY_RC) =="
exit "$SUMMARY_RC"
