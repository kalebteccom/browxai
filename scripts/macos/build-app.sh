#!/usr/bin/env bash
# Assemble the unsigned Browxai.app: the compiled launcher, the official Node
# binary, the built browxai with its production dependencies, the two plists and
# the PATH wrappers. Runs on a Mac, by the owner. Signing, notarizing and the
# optional cloud helper belong to release-app.sh, which takes this app as its
# input. See docs/rfcs/0012-signed-macos-app.md.
#
#   scripts/macos/build-app.sh <out-dir>
#
# The app is written to <out-dir>/Browxai.app. <out-dir> must not exist yet or must
# be empty, and it must not be, contain or sit inside the source tree.
#
# Source. By default the checkout this script lives in, which has to be built
# already (`pnpm install --frozen-lockfile && pnpm build`, so dist/cli.js exists).
# Production dependencies come from `pnpm deploy --prod` into a temporary directory,
# which reads the lockfile and leaves the working tree untouched. Set
# BROWXAI_SOURCE_DIR to use another directory:
#   - a checkout (it holds pnpm-lock.yaml): handled as above.
#   - an installed package (no lockfile, but package.json, dist/ and node_modules/
#     with the production dependencies already inside), for example a directory
#     from `npm install browxai` or the package directory of a global install.
#
# Optional environment
#   BROWXAI_SOURCE_DIR    the source, as above. Default: this checkout.
#   BROWXAI_ARCHS         architectures to build, space separated: arm64, x86_64, or
#                         both (or the word universal). Default: arm64. The launcher
#                         and the node binary always get the same list, because
#                         release-app.sh requires it.
#   BROWXAI_NODE_KEYRING  a GnuPG keyring file with the Node.js release keys. When set,
#                         SHASUMS256.txt is also checked against its published
#                         signature with gpgv. Without it, only the SHA-256 check runs.
#   BROWXAI_KEEP_WORK     set to anything to keep the temporary work directory.
#
# Network. One thing only: the pinned Node release, plus its SHASUMS256.txt, from
# https://nodejs.org/dist. The version is the single line in macos/node-version.txt.
# Each tarball is checked against the SHA-256 in SHASUMS256.txt for that version
# before anything is extracted, and only bin/node and LICENSE are taken from it.
#
# This script reads no secret, signs nothing and needs no Apple account. The output
# is not signed (the launcher carries the linker's ad-hoc signature, node keeps
# Node's own), so it will not pass Gatekeeper and `login-item register` will not
# work on it. release-app.sh does the signing.
#
# Layout that release-app.sh and verify-app.sh rely on:
#   Contents/Info.plist, Contents/MacOS/browxai-launcher (a compiled launcher),
#   Contents/Resources/node/bin/node, Contents/Resources/bin/browxai-cloud (the
#   wrapper release-app.sh requires when it adds a helper), and no symlink that
#   leaves the bundle. Symlinks inside node_modules stay relative and inside.

set -euo pipefail

# Fixed identity. The bundle id is part of every permission grant and never changes.
# release-app.sh and verify-app.sh read it back from the Info.plist written here.
BUNDLE_ID="com.kalebtec.browxai"
APP_NAME="Browxai"
EXECUTABLE="browxai-launcher"
# Keep equal to NODE_REL in release-app.sh and verify-app.sh.
NODE_REL="Contents/Resources/node/bin/node"
# The launcher's deployment target. The app's own floor is LSMinimumSystemVersion in
# macos/Info.plist.in. The launcher goes lower so it can print the launchctl
# fallback instead of failing to load on a Mac that lacks SMAppService.
LAUNCHER_TARGET="12.0"

die() {
  printf 'build-app: %s\n' "$1" >&2
  exit 1
}
note() { printf 'build-app: %s\n' "$1" >&2; }
step() { printf '\n==> %s\n' "$1"; }

# Physical absolute path of an existing directory.
abs_dir() { (cd -P "$1" 2>/dev/null && pwd -P); }

# The architectures of one Mach-O file, sorted and space separated.
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

# One top-level string field of a JSON file. plutil reads JSON on macOS. The sed line is
# a fallback for a package.json that keeps one key per line.
json_field() {
  local v
  v="$(plutil -extract "$1" raw -o - "$2" 2>/dev/null)" || v=""
  if [ -z "$v" ]; then
    v="$(sed -n "s/^  \"$1\": \"\\([^\"]*\\)\",\\{0,1\\}$/\\1/p" "$2" | head -n 1)"
  fi
  printf '%s' "$v"
}

# --- preconditions -----------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "this runs on macOS only"
[ $# -eq 1 ] || die "usage: $0 <out-dir>"
OUT_REQ="$1"

for tool in swiftc lipo ditto shasum plutil file curl tar perl xattr sed awk find; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH. swiftc comes with Xcode or its command line tools."
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(abs_dir "$SCRIPT_DIR/../..")" || die "cannot resolve the repository root"
MACOS_DIR="$REPO_ROOT/macos"
for f in launcher/main.swift Info.plist.in launchagent.plist.in node-version.txt wrappers/browxai wrappers/browxai-cloud; do
  [ -f "$MACOS_DIR/$f" ] || die "missing $MACOS_DIR/$f"
done

# The pinned Node version, one line like 26.13.1.
NODE_VERSION="$(tr -d '[:space:]' <"$MACOS_DIR/node-version.txt")"
printf '%s' "$NODE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || die "macos/node-version.txt must hold one version like 26.13.1"

# Source tree.
SRC_REQ="${BROWXAI_SOURCE_DIR:-$REPO_ROOT}"
[ -d "$SRC_REQ" ] || die "the source directory does not exist: $SRC_REQ"
SRC="$(abs_dir "$SRC_REQ")" || die "cannot resolve the source directory $SRC_REQ"
[ -f "$SRC/package.json" ] || die "no package.json in $SRC"
[ -f "$SRC/dist/cli.js" ] || die "no dist/cli.js in $SRC. Build first: pnpm install --frozen-lockfile && pnpm build"
if [ -f "$SRC/pnpm-lock.yaml" ]; then
  SRC_KIND="checkout"
  command -v pnpm >/dev/null 2>&1 || die "pnpm not found on PATH (needed for pnpm deploy)"
else
  SRC_KIND="package"
  [ -d "$SRC/node_modules" ] || die "$SRC has no pnpm-lock.yaml and no node_modules, so there are no production dependencies to copy"
fi

PKG_NAME="$(json_field name "$SRC/package.json")"
VERSION="$(json_field version "$SRC/package.json")"
[ "$PKG_NAME" = "browxai" ] || die "$SRC/package.json is not the browxai package (name is '$PKG_NAME')"
printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || die "package.json version must look like 1.2.3"
BUNDLE_VERSION="${VERSION%%[-+]*}"

# Architectures.
ARCH_REQ="${BROWXAI_ARCHS:-arm64}"
[ "$ARCH_REQ" != "universal" ] || ARCH_REQ="arm64 x86_64"
ARCH_LIST=""
for a in $ARCH_REQ; do
  case "$a" in
    arm64 | x86_64) ;;
    *) die "BROWXAI_ARCHS holds '$a'. Use arm64, x86_64, or both." ;;
  esac
  case " $ARCH_LIST " in
    *" $a "*) die "BROWXAI_ARCHS lists $a twice" ;;
  esac
  ARCH_LIST="$ARCH_LIST $a"
done
ARCH_LIST="${ARCH_LIST# }"
[ -n "$ARCH_LIST" ] || die "BROWXAI_ARCHS is empty"
case "$ARCH_LIST" in
  *" "*) LIPO_NEEDED=1 ;;
  *) LIPO_NEEDED=0 ;;
esac

# --- output directory: new or empty, and apart from the source ---------------

case "$OUT_REQ" in
  *..*) die "the output directory must not contain '..'" ;;
esac
probe="$OUT_REQ"
rest=""
while [ ! -e "$probe" ]; do
  rest="/$(basename "$probe")$rest"
  probe="$(dirname "$probe")"
done
[ -d "$probe" ] || die "the output directory sits under something that is not a directory: $OUT_REQ"
base="$(abs_dir "$probe")" || die "cannot resolve the output directory $OUT_REQ"
OUT_DIR="${base%/}$rest"
[ "$OUT_DIR" != "/" ] || die "refusing to use / as the output directory"
case "$OUT_DIR/" in
  "$SRC"/*) die "the output directory is the source tree or inside it. The build never writes into the working tree." ;;
esac
case "$SRC/" in
  "$OUT_DIR"/*) die "the output directory contains the source tree. Use a separate directory." ;;
esac
if [ -e "$OUT_DIR" ]; then
  [ -d "$OUT_DIR" ] && [ ! -L "$OUT_DIR" ] || die "the output directory exists and is not a plain directory: $OUT_DIR"
  [ -z "$(ls -A "$OUT_DIR")" ] || die "the output directory is not empty: $OUT_DIR. Use a new or empty directory."
fi

# --- work directory, removed on exit -----------------------------------------

TMPROOT="${TMPDIR:-/tmp}"
TMPROOT="${TMPROOT%/}"
WORK="$(mktemp -d "$TMPROOT/browxai-macos-build.XXXXXX")"
case "$WORK" in
  "$TMPROOT"/browxai-macos-build.*) ;;
  *) die "unexpected work directory '$WORK'" ;;
esac
[ -d "$WORK" ] || die "could not create a work directory"
cleanup() {
  if [ -n "${BROWXAI_KEEP_WORK:-}" ]; then
    printf 'build-app: work directory kept: %s\n' "$WORK" >&2
  else
    rm -rf "${WORK:?}"
  fi
}
trap cleanup EXIT

APP="$WORK/stage/$APP_NAME.app"
CONTENTS="$APP/Contents"
RES="$CONTENTS/Resources"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Library/LaunchAgents" "$RES/bin" "$RES/node/bin" "$RES/app"

printf 'version:        %s\n' "$VERSION"
printf 'source:         %s (%s)\n' "$SRC" "$SRC_KIND"
printf 'node:           v%s\n' "$NODE_VERSION"
printf 'architectures:  %s\n' "$ARCH_LIST"

# --- the Node binary: download, verify, extract ------------------------------

node_arch_name() {
  case "$1" in
    arm64) printf 'arm64' ;;
    x86_64) printf 'x64' ;;
  esac
}

fetch() {
  # $1 url, $2 output file. HTTPS only, also across redirects.
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --max-time 900 --output "$2" "$1"
}

step "Downloading Node v$NODE_VERSION and checking it against SHASUMS256.txt"
DL="$WORK/download"
mkdir "$DL"
NODE_BASE_URL="https://nodejs.org/dist/v$NODE_VERSION"
fetch "$NODE_BASE_URL/SHASUMS256.txt" "$DL/SHASUMS256.txt" || die "could not download $NODE_BASE_URL/SHASUMS256.txt"

if [ -n "${BROWXAI_NODE_KEYRING:-}" ]; then
  command -v gpgv >/dev/null 2>&1 || die "BROWXAI_NODE_KEYRING is set and gpgv is not installed"
  [ -f "$BROWXAI_NODE_KEYRING" ] || die "BROWXAI_NODE_KEYRING is not a file: $BROWXAI_NODE_KEYRING"
  fetch "$NODE_BASE_URL/SHASUMS256.txt.sig" "$DL/SHASUMS256.txt.sig" || die "could not download SHASUMS256.txt.sig"
  gpgv --keyring "$BROWXAI_NODE_KEYRING" "$DL/SHASUMS256.txt.sig" "$DL/SHASUMS256.txt" 2>/dev/null || die "the signature on SHASUMS256.txt does not verify against BROWXAI_NODE_KEYRING"
  printf 'SHASUMS256.txt signature verifies\n'
else
  note "SHASUMS256.txt signature not checked (set BROWXAI_NODE_KEYRING to check it)"
fi

NODE_LICENSE=""
for arch in $ARCH_LIST; do
  narch="$(node_arch_name "$arch")"
  stem="node-v$NODE_VERSION-darwin-$narch"
  tarball="$stem.tar.gz"
  fetch "$NODE_BASE_URL/$tarball" "$DL/$tarball" || die "could not download $NODE_BASE_URL/$tarball"
  want="$(awk -v f="$tarball" '$2 == f { print $1 }' "$DL/SHASUMS256.txt")"
  [ "$(printf '%s\n' "$want" | grep -c .)" -eq 1 ] || die "SHASUMS256.txt has no single entry for $tarball"
  printf '%s' "$want" | grep -Eq '^[0-9a-f]{64}$' || die "the SHA-256 for $tarball in SHASUMS256.txt is malformed"
  have="$(shasum -a 256 "$DL/$tarball" | cut -d' ' -f1)"
  [ "$have" = "$want" ] || die "the SHA-256 of $tarball does not match SHASUMS256.txt. Nothing was extracted."
  printf '%s: SHA-256 matches\n' "$tarball"

  # Each archive goes into its own new directory, and only two members are taken.
  ex="$WORK/node-$arch"
  mkdir "$ex"
  tar -xzf "$DL/$tarball" -C "$ex" "$stem/bin/node" "$stem/LICENSE" || die "could not extract bin/node and LICENSE from $tarball"
  nb="$ex/$stem/bin/node"
  [ -f "$nb" ] && [ ! -L "$nb" ] || die "bin/node in $tarball is not a regular file"
  file -b "$nb" | grep -q 'Mach-O' || die "bin/node in $tarball is not a Mach-O file"
  got="$(archs_of "$nb")" || die "lipo cannot read bin/node from $tarball"
  [ "$got" = "$arch" ] || die "bin/node from $tarball has architectures '$got', expected '$arch'"
  [ -f "$ex/$stem/LICENSE" ] && [ ! -L "$ex/$stem/LICENSE" ] || die "LICENSE in $tarball is not a regular file"
  cp "$nb" "$WORK/node-bin-$arch"
  chmod 755 "$WORK/node-bin-$arch"
  [ -n "$NODE_LICENSE" ] || NODE_LICENSE="$ex/$stem/LICENSE"

  # The binary came from the official archive and matched its digest, so running it
  # is fine. Only the host architecture can run. A version mismatch means the pin
  # file and SHASUMS256.txt disagree about what they describe.
  if [ "$arch" = "$(uname -m)" ]; then
    out="$(run_with_timeout 10 "$WORK/node-bin-$arch" --version 2>/dev/null)" || die "the $arch node binary did not run"
    [ "$out" = "v$NODE_VERSION" ] || die "the $arch node binary reports '$out', expected v$NODE_VERSION"
    printf 'node %s runs on this Mac\n' "$out"
  fi
done

NODE_INPUTS=()
for a in $ARCH_LIST; do NODE_INPUTS+=("$WORK/node-bin-$a"); done
if [ "$LIPO_NEEDED" -eq 1 ]; then
  lipo -create "${NODE_INPUTS[@]}" -output "$RES/node/bin/node"
else
  cp "$WORK/node-bin-$ARCH_LIST" "$RES/node/bin/node"
fi
chmod 755 "$RES/node/bin/node"
cp "$NODE_LICENSE" "$RES/node-LICENSE"

# --- the launcher ------------------------------------------------------------

step "Building the launcher with swiftc"
LAUNCHER_INPUTS=()
for arch in $ARCH_LIST; do
  (cd "$WORK" && swiftc -O -target "$arch-apple-macos$LAUNCHER_TARGET" \
    -module-cache-path "$WORK/swift-module-cache" \
    -o "$WORK/launcher-$arch" "$MACOS_DIR/launcher/main.swift") || die "swiftc failed for $arch"
  LAUNCHER_INPUTS+=("$WORK/launcher-$arch")
done
if [ "$LIPO_NEEDED" -eq 1 ]; then
  lipo -create "${LAUNCHER_INPUTS[@]}" -output "$CONTENTS/MacOS/$EXECUTABLE"
else
  cp "$WORK/launcher-$ARCH_LIST" "$CONTENTS/MacOS/$EXECUTABLE"
fi
chmod 755 "$CONTENTS/MacOS/$EXECUTABLE"

# --- browxai itself: dist, package.json, production node_modules --------------

step "Copying dist and the production dependencies"
if [ "$SRC_KIND" = "checkout" ]; then
  DEPLOY="$WORK/deploy"
  # pnpm deploy reads the lockfile and writes only to $DEPLOY. Lifecycle scripts
  # stay off, as everywhere else in this repository.
  (cd "$SRC" && npm_config_ignore_scripts=true pnpm --filter "$PKG_NAME" deploy --prod "$DEPLOY") || die "pnpm deploy failed"
  NM_SRC="$DEPLOY/node_modules"
else
  NM_SRC="$SRC/node_modules"
fi
[ -d "$NM_SRC" ] || die "no node_modules at $NM_SRC"
ditto "$SRC/dist" "$RES/app/dist"
cp "$SRC/package.json" "$RES/app/package.json"
ditto "$NM_SRC" "$RES/app/node_modules"
[ -f "$RES/app/dist/cli.js" ] || die "dist/cli.js did not reach the bundle"

# Drop what is machine specific or unused at run time: the .bin shims (pnpm writes
# them with absolute paths) and the package manager's own bookkeeping files.
NM="$RES/app/node_modules"
[ -d "$NM" ] && [ "$NM" != "/" ] || die "unexpected node_modules path"
find "$NM" -type d -name .bin -prune -exec rm -rf {} +
rm -f "$NM/.modules.yaml" "$NM/.package-lock.json" "$NM/.pnpm/lock.yaml" "$NM"/.pnpm-workspace-state*.json

native_found="$(find "$NM" -type f \( -name '*.node' -o -name '*.dylib' -o -name '*.so' \) | sed -n '1,5p')"
if [ -n "$native_found" ]; then
  note "native code in node_modules, which RFC 0012 expects to be absent. release-app.sh will sign it with no entitlements, and loading it may need disable-library-validation:"
  printf '%s\n' "$native_found" | sed "s|^$RES/app/||" >&2
fi

# --- plists, wrappers, notices -----------------------------------------------

step "Writing the plists, the wrappers and the notices"

render() {
  # $1 template, $2 output. Values are checked above, so sed's | delimiter is safe.
  sed -e "s|@BUNDLE_ID@|$BUNDLE_ID|g" \
    -e "s|@APP_NAME@|$APP_NAME|g" \
    -e "s|@EXECUTABLE@|$EXECUTABLE|g" \
    -e "s|@VERSION@|$VERSION|g" \
    -e "s|@BUNDLE_VERSION@|$BUNDLE_VERSION|g" \
    "$1" >"$2"
  if grep -q '@[A-Z_]*@' "$2"; then die "unfilled placeholder in $2"; fi
  plutil -lint "$2" >/dev/null || die "$2 is not a valid plist"
}
AGENT_PLIST="$CONTENTS/Library/LaunchAgents/$BUNDLE_ID.agent.plist"
render "$MACOS_DIR/Info.plist.in" "$CONTENTS/Info.plist"
render "$MACOS_DIR/launchagent.plist.in" "$AGENT_PLIST"

# Shell wrappers, sealed as resources by the app signature. Copies, not symlinks:
# release-app.sh refuses symlinks that leave the bundle, and the wrappers find the
# app from their own real path.
cp "$MACOS_DIR/wrappers/browxai" "$RES/bin/browxai"
cp "$MACOS_DIR/wrappers/browxai-cloud" "$RES/bin/browxai-cloud"
chmod 755 "$RES/bin/browxai" "$RES/bin/browxai-cloud"

if [ -f "$SRC/THIRD_PARTY_NOTICES.md" ]; then
  cp "$SRC/THIRD_PARTY_NOTICES.md" "$RES/THIRD_PARTY_NOTICES.md"
else
  note "no THIRD_PARTY_NOTICES.md in the source. The app's notice file starts empty."
  : >"$RES/THIRD_PARTY_NOTICES.md"
fi
# The lockfile tools do not see the Node binary, so it is listed by hand.
cat >>"$RES/THIRD_PARTY_NOTICES.md" <<EOF

## Node.js runtime bundled in this app

- Node.js v$NODE_VERSION, the official darwin build from https://nodejs.org/dist/v$NODE_VERSION/, checked against the SHA-256 in the published SHASUMS256.txt. Release builds re-sign it with the app's identity and change nothing else.
- Architectures: $ARCH_LIST
- Licence: node-LICENSE, next to this file.
- The cloud helper, when this build embeds one, is listed in bundled-helpers.json.
EOF

if [ -f "$SRC/sbom.cdx.json" ]; then
  cp "$SRC/sbom.cdx.json" "$RES/sbom.cdx.json"
else
  note "no sbom.cdx.json in the source, so the app ships without one. Run 'pnpm sbom' in the checkout first to include it."
fi

# --- layout checks: what release-app.sh and verify-app.sh read ---------------

step "Checking the layout"
exec_name="$(plutil -extract CFBundleExecutable raw -o - "$CONTENTS/Info.plist")"
[ "$exec_name" = "$EXECUTABLE" ] || die "Info.plist names '$exec_name' as the executable, expected $EXECUTABLE"
ident="$(plutil -extract CFBundleIdentifier raw -o - "$CONTENTS/Info.plist")"
[ "$ident" = "$BUNDLE_ID" ] || die "Info.plist bundle id is '$ident'"
shown="$(plutil -extract CFBundleShortVersionString raw -o - "$CONTENTS/Info.plist")"
[ "$shown" = "$VERSION" ] || die "Info.plist version is '$shown', expected $VERSION"
label="$(plutil -extract Label raw -o - "$AGENT_PLIST")"
[ "$label" = "$BUNDLE_ID.agent" ] || die "the agent plist label is '$label'"
bundle_program="$(plutil -extract BundleProgram raw -o - "$AGENT_PLIST")"
[ -f "$APP/$bundle_program" ] && [ -x "$APP/$bundle_program" ] || die "the agent plist's BundleProgram '$bundle_program' is not an executable in the app"

main_archs="$(archs_of "$CONTENTS/MacOS/$EXECUTABLE")" || die "lipo cannot read the launcher"
node_archs="$(archs_of "$APP/$NODE_REL")" || die "lipo cannot read the bundled node"
want_archs="$(printf '%s\n' $ARCH_LIST | sort | tr '\n' ' ' | sed 's/ $//')"
[ "$main_archs" = "$want_archs" ] || die "the launcher has '$main_archs', expected '$want_archs'"
[ "$node_archs" = "$want_archs" ] || die "node has '$node_archs', expected '$want_archs'"
for f in "$APP/$NODE_REL" "$RES/app/dist/cli.js" "$RES/app/package.json" "$RES/bin/browxai" "$RES/bin/browxai-cloud" "$RES/node-LICENSE"; do
  [ -f "$f" ] || die "missing ${f#"$APP"/}"
done
[ -x "$RES/bin/browxai" ] && [ -x "$RES/bin/browxai-cloud" ] || die "a wrapper is not executable"
[ ! -e "$CONTENTS/Helpers" ] || die "unexpected Contents/Helpers: release-app.sh adds the helper"

# Every symlink must be relative and end inside the bundle (release-app.sh refuses
# the others, and an absolute link into the work directory would dangle).
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
APP_REAL="$(abs_dir "$APP")" || die "cannot resolve the staged app"
bad_links=0
while IFS= read -r link; do
  target="$(readlink "$link")"
  case "$target" in
    /*)
      printf 'build-app: absolute symlink: %s -> %s\n' "${link#"$APP"/}" "$target" >&2
      bad_links=$((bad_links + 1))
      continue
      ;;
  esac
  if resolved="$(resolve_link "$link")"; then
    case "$resolved" in
      "$APP_REAL"/*) ;;
      *)
        printf 'build-app: symlink leaves the bundle: %s -> %s\n' "${link#"$APP"/}" "$target" >&2
        bad_links=$((bad_links + 1))
        ;;
    esac
  else
    printf 'build-app: symlink is dangling or loops: %s -> %s\n' "${link#"$APP"/}" "$target" >&2
    bad_links=$((bad_links + 1))
  fi
done < <(find "$APP" -type l)
[ "$bad_links" -eq 0 ] || die "$bad_links bad symlink(s) in the bundle"
printf 'layout ok\n'

# --- smoke test, on the host architecture ------------------------------------

if printf ' %s ' "$ARCH_LIST" | grep -q " $(uname -m) "; then
  step "Smoke test"
  vout="$(run_with_timeout 10 "$CONTENTS/MacOS/$EXECUTABLE" version)" || die "the launcher's version command failed"
  printf '%s\n' "$vout"
  case "$vout" in
    "browxai $VERSION "*) ;;
    *) die "the launcher reports '$vout', expected a line that starts with 'browxai $VERSION '" ;;
  esac
fi

# --- finish ------------------------------------------------------------------

chmod -R u+rwX,go-w,go+rX "$APP"
xattr -cr "$APP"
FINAL="$OUT_DIR/$APP_NAME.app"
mkdir -p "$OUT_DIR"
ditto "$APP" "$FINAL"

step "Done"
printf 'app:           %s\n' "$FINAL"
printf 'version:       %s\n' "$VERSION"
printf 'architectures: %s\n' "$ARCH_LIST"
printf 'size:          %s\n' "$(du -sh "$FINAL" | cut -f1)"
printf '\nNext (the owner, on this Mac):\n'
printf '  BROWXAI_APPLE_TEAM_ID=<TEAM_ID> BROWXAI_NOTARY_KEYCHAIN_PROFILE=<KEYCHAIN_PROFILE> \\\n'
printf '    scripts/macos/release-app.sh "%s" %s\n' "$FINAL" "$VERSION"
