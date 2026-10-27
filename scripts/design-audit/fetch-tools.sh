#!/usr/bin/env bash
# Fetch the two pinned design-audit tools into a fresh directory. Fails closed on any hash, commit or integrity mismatch.
#   impeccable engine-v0.1.17 (release binary, sha256 pinned)
#   hallmark 7ec86822 (pinned commit, three script files sha256 pinned) + puppeteer-core 25.16.0 (--ignore-scripts)
# Usage: fetch-tools.sh <empty-dir>
# Writes <dir>/bin/impeccable, <dir>/hallmark/{sloplint.mjs,sloplint-render.mjs,photos.json}, <dir>/puppeteer/node_modules.
# Installs nothing globally and runs no code from either repository.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: fetch-tools.sh <empty-dir>}"
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then
  echo "fetch-tools: $OUT is not empty" >&2
  exit 2
fi
mkdir -p "$OUT/bin" "$OUT/hallmark" "$OUT/puppeteer" "$OUT/src"
OUT="$(cd "$OUT" && pwd)"

IMP_TAG=engine-v0.1.17
IMP_ASSET=impeccable-linux-x64
IMP_SHA=44c0d601e985980a9c39718fee15b48a8f7cbe67779f6ae05efe9124817ab629
HM_COMMIT=7ec868225c6caa040558c321ee0fefa0e73f83a8
PPT_VERSION=25.16.0
PPT_INTEGRITY='sha512-VA5Pf54N8shfopNkZZXCdiiwfnnY8ZJYAMqFQRhlH5mGUhfwf53Ar770GPtdpTDLUqvQeYpIBtC9/G2Jij2IJw=='

echo "==> impeccable $IMP_TAG"
curl --fail --silent --show-error --location --retry 3 --output "$OUT/bin/$IMP_ASSET.part" \
  "https://github.com/pbakaus/impeccable/releases/download/$IMP_TAG/$IMP_ASSET"
if ! echo "$IMP_SHA  $OUT/bin/$IMP_ASSET.part" | sha256sum --check --strict; then
  echo "fetch-tools: sha256 of $IMP_ASSET does not match the pinned value, refusing to run it" >&2
  exit 1
fi
mv "$OUT/bin/$IMP_ASSET.part" "$OUT/bin/impeccable"
chmod 755 "$OUT/bin/impeccable"

echo "==> hallmark $HM_COMMIT"
git -C "$OUT/src" init --quiet
git -C "$OUT/src" fetch --quiet --depth 1 https://github.com/Nutlope/hallmark.git "$HM_COMMIT"
git -C "$OUT/src" checkout --quiet --detach FETCH_HEAD
GOT="$(git -C "$OUT/src" rev-parse HEAD)"
if [ "$GOT" != "$HM_COMMIT" ]; then
  echo "fetch-tools: hallmark checked out $GOT, expected $HM_COMMIT" >&2
  exit 1
fi
SRC="$OUT/src/skills/hallmark/scripts"
# Only these three files are copied; the image, theme and installer scripts never leave the clone.
while read -r sha name; do
  if ! echo "$sha  $SRC/$name" | sha256sum --check --strict; then
    echo "fetch-tools: $name does not match its pinned sha256" >&2
    exit 1
  fi
  cp "$SRC/$name" "$OUT/hallmark/$name"
done <<'PINS'
f8ada364c68a9db4b3dd5784bd416a7c412125e887aeae87d627e072d3848289 sloplint.mjs
3af79afa100a9804f248ade24d5128cea4fde1ef6d1a279f1dd935bfe6dc41cd sloplint-render.mjs
1ee6836583e8048400876351c0605bc3f08515fecfe68aca3712b9e75498bc65 photos.json
PINS
rm -rf "$OUT/src"

echo "==> puppeteer-core $PPT_VERSION (--ignore-scripts, no browser download)"
npm install --prefix "$OUT/puppeteer" --ignore-scripts --no-audit --no-fund "puppeteer-core@$PPT_VERSION"
node "$HERE/check-puppeteer-lock.mjs" "$OUT/puppeteer/package-lock.json" "$PPT_VERSION" "$PPT_INTEGRITY"
echo "==> tools ready in $OUT"
