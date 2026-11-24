#!/usr/bin/env bash
# Print the Homebrew cask for a release zip of the browxai macOS app, with the
# zip's real SHA-256. Reads the template at packaging/homebrew/browxai.rb and
# writes the finished cask to standard output. No network, no Homebrew needed.
# See docs/rfcs/0012-signed-macos-app.md, section "Homebrew".
#
#   scripts/macos/make-cask.sh [--with-helper] <browxai-VERSION-macos-ARCH.zip> <VERSION> > browxai.rb
#
# The zip is the file release-app.sh wrote. Its name must be exactly
# browxai-VERSION-macos-ARCH.zip, where ARCH is arm64, x64 or universal, and VERSION
# must match the VERSION argument. When release-app.sh's <zip>.sha256 file sits next
# to the zip, the digest in it must equal the one computed here.
#
# --with-helper keeps the `browxai-cloud` binary stanza. Use it only when the app was
# built with the bundled cloud helper, because Homebrew fails on a link whose source
# is missing.
#
# Nothing is written to the repository. Redirect the output into your tap checkout.

set -euo pipefail

die() {
  printf 'make-cask: %s\n' "$1" >&2
  exit 1
}

usage() {
  printf 'usage: %s [--with-helper] <browxai-VERSION-macos-ARCH.zip> <VERSION>\n' "$0" >&2
  exit 2
}

WITH_HELPER=0
args=()
for a in "$@"; do
  case "$a" in
    --with-helper) WITH_HELPER=1 ;;
    -*) usage ;;
    *) args+=("$a") ;;
  esac
done
[ "${#args[@]}" -eq 2 ] || usage
ZIP="${args[0]}"
VERSION="${args[1]}"

# The version goes into a sed replacement and into a URL, so accept only a plain
# semver (with an optional pre-release part).
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "version must look like 1.2.3, got '$VERSION'" ;;
esac
case "$VERSION" in
  *[!0-9A-Za-z.-]*) die "version has a character outside 0-9, letters, '.' and '-': '$VERSION'" ;;
esac

[ -f "$ZIP" ] || die "no such file: $ZIP"
NAME="$(basename "$ZIP")"
case "$NAME" in
  "browxai-$VERSION-macos-arm64.zip") ARCH="arm64" ;;
  "browxai-$VERSION-macos-x64.zip") ARCH="x64" ;;
  "browxai-$VERSION-macos-universal.zip") ARCH="universal" ;;
  *) die "zip name must be browxai-$VERSION-macos-<arm64|x64|universal>.zip, got '$NAME'" ;;
esac

case "$ARCH" in
  arm64) ARCH_SYMBOL="arm64" ;;
  x64) ARCH_SYMBOL="x86_64" ;;
  universal) ARCH_SYMBOL="" ;;
esac

if command -v shasum >/dev/null 2>&1; then
  SHA256="$(shasum -a 256 "$ZIP" | cut -d' ' -f1)"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$ZIP" | cut -d' ' -f1)"
else
  die "neither shasum nor sha256sum is available"
fi
case "$SHA256" in
  *[!0-9a-f]* | "") die "could not compute a SHA-256 for $ZIP" ;;
esac
[ "${#SHA256}" -eq 64 ] || die "the SHA-256 for $ZIP is not 64 hex digits"

# release-app.sh writes "<hash>  <zip name>" next to the zip. Compare when it is there.
if [ -f "$ZIP.sha256" ]; then
  RECORDED="$(cut -d' ' -f1 "$ZIP.sha256")"
  [ "$RECORDED" = "$SHA256" ] || die "$ZIP.sha256 says $RECORDED but the zip hashes to $SHA256"
fi

TEMPLATE="$(cd "$(dirname "$0")/../../packaging/homebrew" && pwd -P)/browxai.rb"
[ -f "$TEMPLATE" ] || die "template not found: $TEMPLATE"

sed_args=(
  -e '/^# template:/d'
  -e "s|__VERSION__|$VERSION|g"
  -e "s|__SHA256__|$SHA256|g"
  -e "s|__ARCH__|$ARCH|g"
)
if [ -z "$ARCH_SYMBOL" ]; then
  # A universal app runs on both architectures, so no architecture requirement. The
  # template keeps the arch line ahead of the macos line, the order brew style wants.
  sed_args+=(-e '/^  depends_on arch:/d')
else
  sed_args+=(-e "s|__ARCH_SYMBOL__|$ARCH_SYMBOL|g")
fi
if [ "$WITH_HELPER" -eq 1 ]; then
  sed_args+=(-e 's| # helper-only$||')
else
  sed_args+=(-e '/ # helper-only$/d')
fi

CASK="$(sed "${sed_args[@]}" "$TEMPLATE")"

# A placeholder that survives means the template and this script disagree.
if printf '%s\n' "$CASK" | grep -q '__[A-Z0-9_]*__'; then
  die "the template still holds a placeholder after filling it"
fi

printf '%s\n' "$CASK"
printf 'make-cask: %s, version %s, sha256 %s\n' "$NAME" "$VERSION" "$SHA256" >&2
