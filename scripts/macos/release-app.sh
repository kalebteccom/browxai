#!/usr/bin/env bash
# Sign, notarize and staple the browxai macOS app, then write the release zip and
# its SHA-256 file. Runs on the owner's Mac. Never in CI: signing and notarizing
# need a private key and a notary credential, and neither is stored in a CI system.
# See docs/rfcs/0012-signed-macos-app.md.
#
#   BROWXAI_APPLE_TEAM_ID=<TEAM_ID> BROWXAI_NOTARY_KEYCHAIN_PROFILE=<KEYCHAIN_PROFILE> \
#     scripts/macos/release-app.sh <path/to/App.app> <version>
#
# Required environment
#   BROWXAI_APPLE_TEAM_ID
#       the 10-character Apple Developer Team ID.
#   BROWXAI_NOTARY_KEYCHAIN_PROFILE
#       the name given to `xcrun notarytool store-credentials`. The credential
#       lives in the login keychain. This script only passes the profile name to
#       notarytool.
#
# Optional environment
#   BROWXAI_APPLE_SIGNING_IDENTITY
#       the Developer ID Application certificate to use, as its 40-character hash
#       or its full name. Needed only when the keychain holds more than one for the
#       team. It is never printed.
#   BROWXAI_ENTITLEMENTS
#       the entitlements file for the bundled node binary. Default:
#       entitlements.plist next to this script.
#   BROWXAI_OUT_DIR
#       where the app, zip and checksum are written. It must not exist yet or must
#       be empty, and it must not contain the input app or sit inside it. Default:
#       a directory named for the version under $TMPDIR.
#   BROWXAI_KEEP_WORK
#       set to anything to keep the work directory (a copy of the app and the notary
#       result) for debugging. By default it is removed on exit.
#   BROWXAI_CLOUD_HELPER, BROWXAI_CLOUD_HELPER_SHA256
#       the optional bundled helper: a path to the helper binary the cloud release
#       produced, and the SHA-256 of that file. Both or neither. With both, the
#       script copies the file into the work directory, hashes the copy, and uses
#       only the copy from then on. It then runs the copy's `--version`, adds it to
#       Contents/Helpers/browxai-cloud and signs it before anything else. With
#       neither, the app is the plain browxai host app. One set without the other
#       stops the run.
#   BROWXAI_CLOUD_HELPER_IDENTIFIER
#       the code signing identifier for the helper. Default: com.kalebtec.browxai-cloud,
#       the identifier the cloud release signs with. verify-app.sh reads the same variable.
#
# The input app is copied first, and the copy is signed. The input is never changed
# or deleted: the script removes nothing but its own temporary work directory.
# The script prints the team id, the bundle id, the notary submission id and the
# output paths. It prints no certificate name (the Gatekeeper output is masked), no
# password and no key.
#
# Layout rules this script relies on (slice 2 of RFC 0012 builds the layout):
#   - with a helper, Contents/Resources/bin/browxai-cloud exists in the input app.
#     It is the shell wrapper that the Homebrew cask links onto PATH.
#   - the main executable is a compiled launcher, not a script. A script as the main
#     executable runs as its interpreter, so the process takes the interpreter's
#     code identity and not the app's.
#   - the bundled node binary, when there is one, is at NODE_REL below. That file
#     alone gets the entitlements.
#   - no symlink points outside the bundle.

set -euo pipefail

# The one path that holds the bundled node binary. The signing step and the
# entitlements check use this variable and no file-name match.
NODE_REL="Contents/Resources/node/bin/node"

# The helper's signing identifier. It is the one the cloud release signs with, so it is
# not derived from the bundle id. Override only to match a different helper release.
HELPER_ID="${BROWXAI_CLOUD_HELPER_IDENTIFIER:-com.kalebtec.browxai-cloud}"

die() {
  printf 'release-app: %s\n' "$1" >&2
  exit 1
}
step() { printf '\n==> %s\n' "$1"; }

# Hide the organization name that sits in a certificate name: Gatekeeper's
# `origin=` line and codesign's `Authority=` line both carry it.
mask() {
  sed -E 's/(Developer ID (Application|Installer): ).*( \([A-Z0-9]{10}\))/\1<ORG_NAME>\3/'
}

# Physical absolute path of an existing directory.
abs_dir() { (cd -P "$1" 2>/dev/null && pwd -P); }

# The architectures of one Mach-O file, sorted and space separated. Fails when lipo
# cannot read it or reports none.
archs_of() {
  local out
  out="$(lipo -archs "$1" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  printf '%s\n' "$out" | tr ' ' '\n' | sort | tr '\n' ' ' | sed 's/ $//'
}

# Run a command with a time limit, with no GNU timeout. perl's alarm survives exec.
run_with_timeout() {
  local secs="$1"
  shift
  perl -e 'alarm shift; exec @ARGV or exit 127' "$secs" "$@"
}

# --- preconditions -----------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "this runs on macOS only"

[ $# -eq 2 ] || die "usage: BROWXAI_APPLE_TEAM_ID=<TEAM_ID> BROWXAI_NOTARY_KEYCHAIN_PROFILE=<KEYCHAIN_PROFILE> $0 <App.app> <version>"
APP_ARG="$1"
VERSION="$2"

TEAM_ID="${BROWXAI_APPLE_TEAM_ID:-}"
KEYCHAIN_PROFILE="${BROWXAI_NOTARY_KEYCHAIN_PROFILE:-}"
[ -n "$TEAM_ID" ] || die "BROWXAI_APPLE_TEAM_ID is not set. Export your 10-character Team ID and run again."
[ -n "$KEYCHAIN_PROFILE" ] || die "BROWXAI_NOTARY_KEYCHAIN_PROFILE is not set. Export the notarytool profile name and run again."
case "$TEAM_ID" in
  *"<"* | *">"*) die "BROWXAI_APPLE_TEAM_ID still holds a placeholder" ;;
esac
case "$KEYCHAIN_PROFILE" in
  *"<"* | *">"*) die "BROWXAI_NOTARY_KEYCHAIN_PROFILE still holds a placeholder" ;;
esac
printf '%s' "$TEAM_ID" | grep -Eq '^[A-Z0-9]{10}$' || die "BROWXAI_APPLE_TEAM_ID must be 10 uppercase letters and digits"
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || die "version must look like 1.2.3"

case "$APP_ARG" in
  *.app | *.app/) ;;
  *) die "$APP_ARG does not end in .app" ;;
esac
[ -d "$APP_ARG" ] || die "$APP_ARG is not a directory"
APP_IN="$(abs_dir "${APP_ARG%/}")" || die "cannot resolve $APP_ARG"
[ -n "$APP_IN" ] && [ "$APP_IN" != "/" ] || die "refusing to use '$APP_IN' as the app"
APP_NAME="$(basename "$APP_IN")"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENTITLEMENTS="${BROWXAI_ENTITLEMENTS:-$SCRIPT_DIR/entitlements.plist}"
[ -f "$ENTITLEMENTS" ] || die "entitlements file not found: $ENTITLEMENTS"
plutil -lint "$ENTITLEMENTS" >/dev/null || die "entitlements file is not a valid plist: $ENTITLEMENTS"

for tool in codesign security ditto shasum plutil file lipo spctl perl xattr; do
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

# --- output directory: new or empty, and apart from the input ----------------

OUT_REQ="${BROWXAI_OUT_DIR:-${TMPDIR:-/tmp}/browxai-macos-release-$VERSION}"
case "$OUT_REQ" in
  *..*) die "BROWXAI_OUT_DIR must not contain '..'" ;;
esac
# Work out the absolute path first, from the nearest directory that exists, and
# decide about the input app before anything is created.
probe="$OUT_REQ"
rest=""
while [ ! -e "$probe" ]; do
  rest="/$(basename "$probe")$rest"
  probe="$(dirname "$probe")"
done
[ -d "$probe" ] || die "BROWXAI_OUT_DIR sits under something that is not a directory: $OUT_REQ"
base="$(abs_dir "$probe")" || die "cannot resolve the output directory $OUT_REQ"
OUT_DIR="${base%/}$rest"
[ "$OUT_DIR" != "/" ] || die "refusing to use / as the output directory"
case "$OUT_DIR/" in
  "$APP_IN"/*) die "the output directory is the input app or inside it" ;;
esac
case "$APP_IN/" in
  "$OUT_DIR"/*) die "the output directory contains the input app. Use a separate directory." ;;
esac
if [ -e "$OUT_DIR" ]; then
  [ -d "$OUT_DIR" ] && [ ! -L "$OUT_DIR" ] || die "BROWXAI_OUT_DIR exists and is not a plain directory: $OUT_DIR"
  [ -z "$(ls -A "$OUT_DIR")" ] || die "BROWXAI_OUT_DIR is not empty: $OUT_DIR. Use a new or empty directory."
else
  mkdir -p "$OUT_DIR"
fi

# --- the symlinks in the input must stay inside the bundle -------------------

# Final target of a symlink as a physical absolute path. Fails on a loop or a
# dangling link.
resolve_link() {
  local p="$1" t d n i=0
  while [ -L "$p" ]; do
    [ "$i" -lt 40 ] || return 1
    t="$(readlink "$p")"
    case "$t" in
      /*) p="$t" ;;
      *) p="$(dirname "$p")/$t" ;;
    esac
    i=$((i + 1))
  done
  [ -e "$p" ] || return 1
  d="$(abs_dir "$(dirname "$p")")" || return 1
  n="$(basename "$p")"
  printf '%s/%s\n' "$d" "$n"
}

bad_links=0
while IFS= read -r link; do
  if resolved="$(resolve_link "$link")"; then
    case "$resolved" in
      "$APP_IN"/* | "$APP_IN") ;;
      *)
        printf 'release-app: symlink leaves the bundle: %s -> %s\n' "${link#"$APP_IN"/}" "$(readlink "$link")" >&2
        bad_links=$((bad_links + 1))
        ;;
    esac
  else
    printf 'release-app: symlink is dangling or loops: %s\n' "${link#"$APP_IN"/}" >&2
    bad_links=$((bad_links + 1))
  fi
done < <(find "$APP_IN" -type l)
[ "$bad_links" -eq 0 ] || die "$bad_links bad symlink(s) in the bundle. Replace them with copies or links that stay inside it."

# --- optional bundled helper: check the variables ----------------------------

HELPER_SRC="${BROWXAI_CLOUD_HELPER:-}"
HELPER_SHA="${BROWXAI_CLOUD_HELPER_SHA256:-}"
HELPER_VERSION=""
expected_sha=""
if [ -n "$HELPER_SRC" ] || [ -n "$HELPER_SHA" ]; then
  [ -n "$HELPER_SRC" ] || die "BROWXAI_CLOUD_HELPER_SHA256 is set and BROWXAI_CLOUD_HELPER is not. Set both or neither."
  [ -n "$HELPER_SHA" ] || die "BROWXAI_CLOUD_HELPER is set and BROWXAI_CLOUD_HELPER_SHA256 is not. Set both or neither."
  printf '%s' "$HELPER_SHA" | grep -Eq '^[0-9a-fA-F]{64}$' || die "BROWXAI_CLOUD_HELPER_SHA256 must be 64 hex characters"
  [ -f "$HELPER_SRC" ] && [ ! -L "$HELPER_SRC" ] || die "BROWXAI_CLOUD_HELPER must be a regular file, not a link: $HELPER_SRC"
  expected_sha="$(printf '%s' "$HELPER_SHA" | tr 'A-F' 'a-f')"
  [ -f "$APP_IN/Contents/Resources/bin/browxai-cloud" ] || die "the input app has no Contents/Resources/bin/browxai-cloud wrapper, which puts the helper on PATH"
  [ ! -e "$APP_IN/Contents/Helpers/browxai-cloud" ] || die "the input app already has Contents/Helpers/browxai-cloud. The script adds the helper itself."
fi

# --- work directory, removed on exit -----------------------------------------

WORK="$(mktemp -d "${TMPDIR:-/tmp}/browxai-macos-work.XXXXXX")"
[ -n "$WORK" ] && [ -d "$WORK" ] || die "could not create a work directory"
cleanup() {
  if [ -n "${BROWXAI_KEEP_WORK:-}" ]; then
    printf 'release-app: work directory kept: %s\n' "$WORK" >&2
  else
    rm -rf "${WORK:?}"
  fi
}
trap cleanup EXIT

# --- helper: copy first, hash the copy, then use only the copy ---------------

HELPER_COPY=""
helper_archs=""
if [ -n "$HELPER_SRC" ]; then
  step "Checking the helper"
  HELPER_COPY="$WORK/browxai-cloud.copy"
  cp "$HELPER_SRC" "$HELPER_COPY"
  chmod 755 "$HELPER_COPY"
  # A download carries the quarantine attribute. Running a quarantined binary
  # would raise a Gatekeeper dialog. Ignore the failure when it is absent.
  xattr -d com.apple.quarantine "$HELPER_COPY" 2>/dev/null || true
  actual_sha="$(shasum -a 256 "$HELPER_COPY" | cut -d' ' -f1)"
  [ "$actual_sha" = "$expected_sha" ] || die "the helper's SHA-256 does not match BROWXAI_CLOUD_HELPER_SHA256. Nothing was signed."
  printf 'helper digest matches\n'
  file -b "$HELPER_COPY" | grep -q 'Mach-O' || die "the helper is not a Mach-O file"
  helper_archs="$(archs_of "$HELPER_COPY")" || die "lipo cannot read the helper's architectures"
  # The helper contract (RFC 0012): `--version` prints one line and exits 0. It
  # runs here only after the digest matched, with a time limit.
  rc=0
  version_out="$(run_with_timeout 10 "$HELPER_COPY" --version 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ] || die "the helper's --version exited with status $rc (142 means it timed out after 10 seconds)"
  [ "$(printf '%s\n' "$version_out" | grep -c .)" -eq 1 ] || die "the helper's --version must print exactly one line"
  HELPER_VERSION="$(printf '%s\n' "$version_out" | grep .)"
  printf '%s' "$HELPER_VERSION" | grep -Eq '^[0-9A-Za-z][0-9A-Za-z .+_-]{0,63}$' || die "the helper's version line has characters this script will not record"
  printf 'helper version: %s\n' "$HELPER_VERSION"
fi

# --- signing identity --------------------------------------------------------

step "Finding the Developer ID Application certificate for $TEAM_ID"
ID_LIST="$(security find-identity -v -p codesigning)"
matches="$(printf '%s\n' "$ID_LIST" | awk -v t="($TEAM_ID)" '/Developer ID Application:/ && index($0, t) { print $2 }')"
count="$(printf '%s\n' "$matches" | grep -c . || true)"
if [ -n "${BROWXAI_APPLE_SIGNING_IDENTITY:-}" ]; then
  want="$BROWXAI_APPLE_SIGNING_IDENTITY"
  if printf '%s' "$want" | grep -Eq '^[0-9A-Fa-f]{40}$'; then
    IDENTITY="$(printf '%s' "$want" | tr 'a-f' 'A-F')"
    printf '%s\n' "$matches" | grep -qx "$IDENTITY" || die "BROWXAI_APPLE_SIGNING_IDENTITY is not a Developer ID Application certificate for $TEAM_ID in the keychain"
  else
    IDENTITY="$(printf '%s\n' "$ID_LIST" | awk -v n="\"$want\"" -v t="($TEAM_ID)" 'index($0, n) && index($0, t) { print $2 }')"
    [ "$(printf '%s\n' "$IDENTITY" | grep -c .)" -eq 1 ] || die "BROWXAI_APPLE_SIGNING_IDENTITY names no certificate, or several, for $TEAM_ID"
  fi
elif [ "$count" -eq 0 ]; then
  die "no valid Developer ID Application certificate for $TEAM_ID. Check with: security find-identity -v -p codesigning"
elif [ "$count" -gt 1 ]; then
  die "$count matching certificates. Set BROWXAI_APPLE_SIGNING_IDENTITY to one of the hashes from: security find-identity -v -p codesigning"
else
  IDENTITY="$matches"
fi
printf 'certificate hash: %s\n' "$IDENTITY"

# --- work copy of the app ----------------------------------------------------

APP="$WORK/$APP_NAME"
step "Copying the app to the work directory"
ditto "$APP_IN" "$APP"
rm -rf "${APP:?}/Contents/_CodeSignature"
main_exec="$APP/Contents/MacOS/$EXEC_NAME"
NODE_BIN="$APP/$NODE_REL"

# --- architectures -----------------------------------------------------------

main_archs="$(archs_of "$main_exec")" || die "lipo cannot read the launcher's architectures"
APP_ARCHS="$main_archs"
if [ -f "$NODE_BIN" ]; then
  node_archs="$(archs_of "$NODE_BIN")" || die "lipo cannot read the bundled node binary's architectures"
  [ "$node_archs" = "$main_archs" ] || die "the launcher has '$main_archs' and the node binary has '$node_archs'. They must match."
fi
if [ -n "$helper_archs" ]; then
  for a in $APP_ARCHS; do
    case " $helper_archs " in
      *" $a "*) ;;
      *) die "the helper has architectures '$helper_archs' and the app needs '$a'" ;;
    esac
  done
fi
case "$APP_ARCHS" in
  "arm64") ARCH="arm64" ;;
  "x86_64") ARCH="x64" ;;
  "arm64 x86_64") ARCH="universal" ;;
  *) die "unsupported architecture set: '$APP_ARCHS'" ;;
esac
printf 'architectures: %s (zip label %s)\n' "$APP_ARCHS" "$ARCH"

# --- bundled helper: add it, record it ---------------------------------------

HELPER=""
if [ -n "$HELPER_COPY" ]; then
  step "Adding the helper"
  mkdir -p "$APP/Contents/Helpers"
  HELPER="$APP/Contents/Helpers/browxai-cloud"
  cp "$HELPER_COPY" "$HELPER"
  chmod 755 "$HELPER"
  # Recorded inside the bundle, so verify-app.sh and the support path can read it.
  # sourceSha256 is the digest of the file as the cloud release produced it. The
  # signed file differs, because signing rewrites the binary.
  printf '{\n  "helpers": [\n    {\n      "name": "browxai-cloud",\n      "path": "Contents/Helpers/browxai-cloud",\n      "identifier": "%s",\n      "version": "%s",\n      "sourceSha256": "%s"\n    }\n  ]\n}\n' \
    "$HELPER_ID" "$HELPER_VERSION" "$expected_sha" >"$APP/Contents/Resources/bundled-helpers.json"
fi

# --- sign, inside out --------------------------------------------------------

sign_file() {
  # $1 path. Only the file at NODE_BIN gets the entitlements and a stable
  # identifier. Every other Mach-O file gets the hardened runtime and nothing else.
  local f="$1"
  if [ "$f" = "$NODE_BIN" ]; then
    codesign --force --sign "$IDENTITY" --options runtime --timestamp \
      --identifier "$BUNDLE_ID.node" --entitlements "$ENTITLEMENTS" "$f"
  else
    codesign --force --sign "$IDENTITY" --options runtime --timestamp "$f"
  fi
}

if [ -n "$HELPER" ]; then
  step "Signing the helper first, with a fixed identifier and no entitlements"
  codesign --force --sign "$IDENTITY" --options runtime --timestamp \
    --identifier "$HELPER_ID" "$HELPER"
  codesign --verify --strict --verbose=2 "$HELPER"
fi

step "Signing nested Mach-O files, deepest first"
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
    # The log goes to the output directory, because the work directory is removed.
    xcrun notarytool log "$SUB_ID" --keychain-profile "$KEYCHAIN_PROFILE" "$OUT_DIR/notary-log.json" >/dev/null 2>&1 || true
    [ -f "$OUT_DIR/notary-log.json" ] && printf 'notary log written to %s\n' "$OUT_DIR/notary-log.json" >&2
  fi
  die "notarization was not accepted"
fi

step "Stapling"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"

step "Gatekeeper assessment"
ASSESS="$(spctl --assess --type execute --verbose=4 "$APP" 2>&1)" || {
  printf '%s\n' "$ASSESS" | mask >&2
  die "spctl rejected the app"
}
printf '%s\n' "$ASSESS" | mask
printf '%s\n' "$ASSESS" | grep -q 'Notarized Developer ID' || die "spctl accepted the app but not as Notarized Developer ID"

# --- package -----------------------------------------------------------------

ZIP_NAME="browxai-$VERSION-macos-$ARCH.zip"
FINAL_APP="$OUT_DIR/$APP_NAME"

step "Writing $ZIP_NAME"
ditto -c -k --keepParent "$APP" "$OUT_DIR/$ZIP_NAME"
(cd "$OUT_DIR" && shasum -a 256 "$ZIP_NAME" >"$ZIP_NAME.sha256")

# Keep the stapled app next to the zip so verify-app.sh can run on it. The output
# directory was empty at the start, so nothing is removed here.
ditto "$APP" "$FINAL_APP"

step "Done"
printf 'team id:       %s\n' "$TEAM_ID"
printf 'bundle id:     %s\n' "$BUNDLE_ID"
printf 'helper:        %s\n' "${HELPER_VERSION:-none}"
printf 'submission id: %s\n' "$SUB_ID"
printf 'app:           %s\n' "$FINAL_APP"
printf 'zip:           %s\n' "$OUT_DIR/$ZIP_NAME"
printf 'sha256:        %s\n' "$(cut -d' ' -f1 "$OUT_DIR/$ZIP_NAME.sha256")"
printf '\nNext: scripts/macos/verify-app.sh "%s"\n' "$FINAL_APP"
