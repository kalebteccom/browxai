#!/usr/bin/env bash
# Sign, notarize and staple the browxai macOS app, then write the release zip and
# its SHA-256 file. Runs on the owner's Mac. Never in CI: signing and notarizing
# need a private key and a notary credential, and neither is stored in a CI system.
# See docs/rfcs/0012-signed-macos-app.md.
#
#   TEAM_ID=<TEAM_ID> KEYCHAIN_PROFILE=<KEYCHAIN_PROFILE> \
#     scripts/macos/release-app.sh <path/to/App.app> <version>
#
# Required environment
#   TEAM_ID            the 10-character Apple Developer Team ID.
#   KEYCHAIN_PROFILE   the name given to `xcrun notarytool store-credentials`.
#                      The credential lives in the login keychain. This script
#                      only passes the profile name to notarytool.
#
# Optional environment
#   SIGN_IDENTITY      the 40-character hash of the Developer ID Application
#                      certificate to use. Needed only when the keychain holds
#                      more than one for TEAM_ID.
#   ENTITLEMENTS       the entitlements file for the `node` executable. Default:
#                      entitlements.plist next to this script.
#   OUT_DIR            where the zip and checksum are written. Default: a new
#                      directory under $TMPDIR.
#   BROWXAI_CLOUD_HELPER, BROWXAI_CLOUD_HELPER_SHA256
#                      the optional bundled helper: a path to the helper binary
#                      the cloud release produced, and the SHA-256 of that file.
#                      Both or neither. With both, the script checks the digest,
#                      copies the binary to Contents/Helpers/browxai-cloud and signs
#                      it before anything else. With neither, the app is the plain
#                      browxai host app. One set without the other stops the run.
#
# The input app is copied first, and the copy is signed. The input is not changed.
# The script prints the team id, the bundle id, the notary submission id and the
# output paths. It prints no certificate name, no password and no key.
#
# Layout rules this script relies on (slice 2 of RFC 0012 builds the layout):
#   - with a helper, Contents/Resources/bin/browxai-cloud exists in the input app.
#     It is the shell wrapper that the Homebrew cask links onto PATH.
#   - every executable is a Mach-O file. A shell script in Contents/MacOS cannot
#     carry its own signature, so the main executable is a compiled launcher and
#     any script lives in Contents/Resources, where the bundle seal covers it.
#   - no symlink points outside the bundle.

set -euo pipefail

die() {
  printf 'release-app: %s\n' "$1" >&2
  exit 1
}
step() { printf '\n==> %s\n' "$1"; }

# --- preconditions -----------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "this runs on macOS only"

[ $# -eq 2 ] || die "usage: TEAM_ID=<TEAM_ID> KEYCHAIN_PROFILE=<KEYCHAIN_PROFILE> $0 <App.app> <version>"
APP_IN="$1"
VERSION="$2"

[ -n "${TEAM_ID:-}" ] || die "TEAM_ID is not set. Export your 10-character Team ID and run again."
[ -n "${KEYCHAIN_PROFILE:-}" ] || die "KEYCHAIN_PROFILE is not set. Export the notarytool profile name and run again."
case "$TEAM_ID" in
  *"<"* | *">"*) die "TEAM_ID still holds a placeholder" ;;
esac
case "$KEYCHAIN_PROFILE" in
  *"<"* | *">"*) die "KEYCHAIN_PROFILE still holds a placeholder" ;;
esac
printf '%s' "$TEAM_ID" | grep -Eq '^[A-Z0-9]{10}$' || die "TEAM_ID must be 10 uppercase letters and digits"
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || die "version must look like 1.2.3"

[ -d "$APP_IN" ] || die "$APP_IN is not a directory"
case "$APP_IN" in
  *.app | *.app/) ;;
  *) die "$APP_IN does not end in .app" ;;
esac
APP_IN="${APP_IN%/}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTITLEMENTS="${ENTITLEMENTS:-$SCRIPT_DIR/entitlements.plist}"
[ -f "$ENTITLEMENTS" ] || die "entitlements file not found: $ENTITLEMENTS"
plutil -lint "$ENTITLEMENTS" >/dev/null || die "entitlements file is not a valid plist: $ENTITLEMENTS"

for tool in codesign security ditto shasum plutil file lipo spctl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
done
xcrun --find notarytool >/dev/null 2>&1 || die "xcrun notarytool not found. Install Xcode or its command line tools."
xcrun --find stapler >/dev/null 2>&1 || die "xcrun stapler not found. Install Xcode or its command line tools."

INFO="$APP_IN/Contents/Info.plist"
[ -f "$INFO" ] || die "no Contents/Info.plist in $APP_IN"
BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$INFO" 2>/dev/null || true)"
APP_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$INFO" 2>/dev/null || true)"
EXEC_NAME="$(plutil -extract CFBundleExecutable raw -o - "$INFO" 2>/dev/null || true)"
[ -n "$BUNDLE_ID" ] || die "Info.plist has no CFBundleIdentifier"
[ -n "$EXEC_NAME" ] || die "Info.plist has no CFBundleExecutable"
case "$BUNDLE_ID" in
  *"<"* | *">"*) die "CFBundleIdentifier still holds a placeholder" ;;
esac
[ "$APP_VERSION" = "$VERSION" ] || die "Info.plist version is '$APP_VERSION' and the argument is '$VERSION'. They must match."
[ -f "$APP_IN/Contents/MacOS/$EXEC_NAME" ] || die "main executable Contents/MacOS/$EXEC_NAME is missing"

# --- optional bundled helper -------------------------------------------------

HELPER_SRC="${BROWXAI_CLOUD_HELPER:-}"
HELPER_SHA="${BROWXAI_CLOUD_HELPER_SHA256:-}"
HELPER_VERSION=""
if [ -n "$HELPER_SRC" ] || [ -n "$HELPER_SHA" ]; then
  [ -n "$HELPER_SRC" ] || die "BROWXAI_CLOUD_HELPER_SHA256 is set and BROWXAI_CLOUD_HELPER is not. Set both or neither."
  [ -n "$HELPER_SHA" ] || die "BROWXAI_CLOUD_HELPER is set and BROWXAI_CLOUD_HELPER_SHA256 is not. Set both or neither."
  printf '%s' "$HELPER_SHA" | grep -Eq '^[0-9a-fA-F]{64}$' || die "BROWXAI_CLOUD_HELPER_SHA256 must be 64 hex characters"
  [ -f "$HELPER_SRC" ] && [ ! -L "$HELPER_SRC" ] || die "BROWXAI_CLOUD_HELPER must be a regular file, not a link: $HELPER_SRC"
  actual_sha="$(shasum -a 256 "$HELPER_SRC" | cut -d' ' -f1)"
  expected_sha="$(printf '%s' "$HELPER_SHA" | tr 'A-F' 'a-f')"
  [ "$actual_sha" = "$expected_sha" ] || die "the helper's SHA-256 does not match BROWXAI_CLOUD_HELPER_SHA256. Nothing was signed."
  file -b "$HELPER_SRC" | grep -q 'Mach-O' || die "the helper is not a Mach-O file"
  [ -f "$APP_IN/Contents/Resources/bin/browxai-cloud" ] || die "the input app has no Contents/Resources/bin/browxai-cloud wrapper, which puts the helper on PATH"
  [ ! -e "$APP_IN/Contents/Helpers/browxai-cloud" ] || die "the input app already has Contents/Helpers/browxai-cloud. The script adds the helper itself."
fi

# A symlink that leaves the bundle breaks the seal and the notary check.
bad_links=0
while IFS= read -r link; do
  target="$(readlink "$link")"
  case "$target" in
    /*)
      printf 'release-app: absolute symlink: %s -> %s\n' "$link" "$target" >&2
      bad_links=$((bad_links + 1))
      ;;
  esac
done < <(find "$APP_IN" -type l)
[ "$bad_links" -eq 0 ] || die "$bad_links absolute symlink(s) in the bundle. Replace them with copies or relative links."

# --- signing identity --------------------------------------------------------

step "Finding the Developer ID Application certificate for $TEAM_ID"
matches="$(security find-identity -v -p codesigning | awk -v t="($TEAM_ID)" '/Developer ID Application:/ && index($0, t) { print $2 }')"
count="$(printf '%s\n' "$matches" | grep -c . || true)"
if [ -n "${SIGN_IDENTITY:-}" ]; then
  printf '%s' "$SIGN_IDENTITY" | grep -Eq '^[0-9A-F]{40}$' || die "SIGN_IDENTITY must be a 40-character uppercase hex hash"
  printf '%s\n' "$matches" | grep -qx "$SIGN_IDENTITY" || die "SIGN_IDENTITY is not a Developer ID Application certificate for $TEAM_ID in the keychain"
  IDENTITY="$SIGN_IDENTITY"
elif [ "$count" -eq 0 ]; then
  die "no valid Developer ID Application certificate for $TEAM_ID. Check with: security find-identity -v -p codesigning"
elif [ "$count" -gt 1 ]; then
  die "$count matching certificates. Set SIGN_IDENTITY to one of the hashes from: security find-identity -v -p codesigning"
else
  IDENTITY="$matches"
fi
printf 'certificate hash: %s\n' "$IDENTITY"

# --- work copy ---------------------------------------------------------------

OUT_DIR="${OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/browxai-macos-release.XXXXXX")}"
mkdir -p "$OUT_DIR"
WORK="$OUT_DIR/work"
rm -rf "$WORK"
mkdir -p "$WORK"
APP="$WORK/$(basename "$APP_IN")"
step "Copying the app to $WORK"
ditto "$APP_IN" "$APP"
rm -rf "$APP/Contents/_CodeSignature"

# --- bundled helper: copy in, check architecture, read the version ------------

HELPER=""
if [ -n "$HELPER_SRC" ]; then
  step "Adding the helper"
  main_archs="$(lipo -archs "$APP/Contents/MacOS/$EXEC_NAME" 2>/dev/null || true)"
  helper_archs="$(lipo -archs "$HELPER_SRC" 2>/dev/null || true)"
  for a in $main_archs; do
    case " $helper_archs " in
      *" $a "*) ;;
      *) die "the helper has architectures '$helper_archs' and the app needs '$a'" ;;
    esac
  done
  mkdir -p "$APP/Contents/Helpers"
  HELPER="$APP/Contents/Helpers/browxai-cloud"
  cp "$HELPER_SRC" "$HELPER"
  chmod 755 "$HELPER"
  # The helper contract (RFC 0012): `--version` prints one line and exits 0.
  HELPER_VERSION="$("$HELPER" --version 2>/dev/null | head -n 1 || true)"
  [ -n "$HELPER_VERSION" ] || die "the helper printed no version for --version"
  printf '%s' "$HELPER_VERSION" | grep -Eq '^[0-9A-Za-z][0-9A-Za-z .+_-]{0,63}$' || die "the helper's version line has characters this script will not record"
  printf 'helper version: %s\n' "$HELPER_VERSION"
  # Recorded inside the bundle, so verify-app.sh and the support path can read it.
  # sourceSha256 is the digest of the file as the cloud release produced it. The
  # signed file differs, because signing rewrites the binary.
  printf '{\n  "helpers": [\n    {\n      "name": "browxai-cloud",\n      "path": "Contents/Helpers/browxai-cloud",\n      "identifier": "%s.cloud",\n      "version": "%s",\n      "sourceSha256": "%s"\n    }\n  ]\n}\n' \
    "$BUNDLE_ID" "$HELPER_VERSION" "$expected_sha" >"$APP/Contents/Resources/bundled-helpers.json"
fi

# --- sign, inside out --------------------------------------------------------

sign_file() {
  # $1 path. The node binary gets the entitlements and a stable identifier. Every
  # other Mach-O file gets the hardened runtime and nothing else.
  local f="$1" base
  base="$(basename "$f")"
  if [ "$base" = "node" ]; then
    codesign --force --sign "$IDENTITY" --options runtime --timestamp \
      --identifier "$BUNDLE_ID.node" --entitlements "$ENTITLEMENTS" "$f"
  else
    codesign --force --sign "$IDENTITY" --options runtime --timestamp "$f"
  fi
}

if [ -n "$HELPER" ]; then
  step "Signing the helper first, with a fixed identifier and no entitlements"
  codesign --force --sign "$IDENTITY" --options runtime --timestamp \
    --identifier "$BUNDLE_ID.cloud" "$HELPER"
  codesign --verify --strict --verbose=2 "$HELPER"
fi

step "Signing nested Mach-O files, deepest first"
main_exec="$APP/Contents/MacOS/$EXEC_NAME"
signed=0
while IFS= read -r f; do
  [ "$f" = "$main_exec" ] && continue
  [ -n "$HELPER" ] && [ "$f" = "$HELPER" ] && continue
  if file -b "$f" | grep -q 'Mach-O'; then
    sign_file "$f"
    signed=$((signed + 1))
  fi
done < <(find "$APP" -type f | awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-)
printf 'signed %d nested file(s)\n' "$signed"

step "Signing nested bundles, deepest first"
nested_bundles=0
while IFS= read -r b; do
  [ "$b" = "$APP" ] && continue
  codesign --force --sign "$IDENTITY" --options runtime --timestamp "$b"
  nested_bundles=$((nested_bundles + 1))
done < <(find "$APP" -type d \( -name '*.app' -o -name '*.framework' -o -name '*.xpc' \) | awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-)
printf 'signed %d nested bundle(s)\n' "$nested_bundles"

step "Signing the app"
codesign --force --sign "$IDENTITY" --options runtime --timestamp "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# --- notarize ----------------------------------------------------------------

step "Submitting to the notary service (this waits)"
SUBMIT_ZIP="$WORK/submit.zip"
ditto -c -k --keepParent "$APP" "$SUBMIT_ZIP"
RESULT="$WORK/notary-result.json"
# --wait blocks until Apple answers. The exit code is not trusted for the verdict,
# so the status is read from the JSON.
xcrun notarytool submit "$SUBMIT_ZIP" --keychain-profile "$KEYCHAIN_PROFILE" --wait --output-format json >"$RESULT" ||
  printf 'release-app: notarytool exited non-zero, reading its result\n' >&2
SUB_ID="$(plutil -extract id raw -o - "$RESULT" 2>/dev/null || true)"
STATUS="$(plutil -extract status raw -o - "$RESULT" 2>/dev/null || true)"
printf 'submission id: %s\nstatus: %s\n' "${SUB_ID:-unknown}" "${STATUS:-unknown}"
if [ "$STATUS" != "Accepted" ]; then
  if [ -n "$SUB_ID" ]; then
    xcrun notarytool log "$SUB_ID" --keychain-profile "$KEYCHAIN_PROFILE" "$WORK/notary-log.json" >/dev/null 2>&1 || true
    [ -f "$WORK/notary-log.json" ] && printf 'notary log written to %s\n' "$WORK/notary-log.json" >&2
  fi
  die "notarization was not accepted"
fi

step "Stapling"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

step "Gatekeeper assessment"
ASSESS="$(spctl --assess --type execute --verbose=4 "$APP" 2>&1)" || {
  printf '%s\n' "$ASSESS" >&2
  die "spctl rejected the app"
}
printf '%s\n' "$ASSESS"
printf '%s\n' "$ASSESS" | grep -q 'Notarized Developer ID' || die "spctl accepted the app but not as Notarized Developer ID"

# --- package -----------------------------------------------------------------

archs="$(lipo -archs "$main_exec" 2>/dev/null || true)"
case "$archs" in
  "arm64") ARCH="arm64" ;;
  "x86_64") ARCH="x64" ;;
  *"arm64"*"x86_64"* | *"x86_64"*"arm64"*) ARCH="universal" ;;
  *) die "cannot read the architecture of the main executable (lipo said: '$archs')" ;;
esac
ZIP_NAME="browxai-$VERSION-macos-$ARCH.zip"

step "Writing $ZIP_NAME"
ditto -c -k --keepParent "$APP" "$OUT_DIR/$ZIP_NAME"
(cd "$OUT_DIR" && shasum -a 256 "$ZIP_NAME" >"$ZIP_NAME.sha256")

# Keep the stapled app next to the zip so verify-app.sh can run on it.
rm -rf "$OUT_DIR/$(basename "$APP")"
ditto "$APP" "$OUT_DIR/$(basename "$APP")"

step "Done"
printf 'team id:       %s\n' "$TEAM_ID"
printf 'bundle id:     %s\n' "$BUNDLE_ID"
printf 'helper:        %s\n' "${HELPER_VERSION:-none}"
printf 'submission id: %s\n' "$SUB_ID"
printf 'app:           %s\n' "$OUT_DIR/$(basename "$APP")"
printf 'zip:           %s\n' "$OUT_DIR/$ZIP_NAME"
printf 'sha256:        %s\n' "$(cut -d' ' -f1 "$OUT_DIR/$ZIP_NAME.sha256")"
printf '\nNext: scripts/macos/verify-app.sh "%s"\n' "$OUT_DIR/$(basename "$APP")"
