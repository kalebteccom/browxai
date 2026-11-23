#!/usr/bin/env bash
# Check a signed browxai macOS app and print what a person needs to read: the
# signature chain, the hardened runtime flag, Gatekeeper's verdict, the stapled
# notary ticket, the designated requirement and the entitlements. Runs on a Mac,
# by the owner. See docs/rfcs/0012-signed-macos-app.md.
#
#   scripts/macos/verify-app.sh <path/to/App.app>
#
# Optional environment
#   BROWXAI_EXPECT_TEAM_ID     fail unless every signed file carries this Team ID.
#   BROWXAI_EXPECT_BUNDLE_ID   fail unless the app's identifier is this.
#   BROWXAI_DR_BASELINE        a file that holds the designated requirement of an
#                              earlier build. If the file exists, the new requirement
#                              must match it exactly. If it does not, it is created.
#                              This is the check that a TCC grant survives an upgrade.
#   BROWXAI_CLOUD_HELPER_SHA256
#                              when set, the bundled helper's recorded source digest
#                              must equal it.
#
# The certificate's organization name is masked in everything this script prints,
# including Gatekeeper's `origin=` line. Nothing here prints a key, a password or a
# notary credential, because none is read.
#
# The entitlement rules are enforced and reported (RFC 0012, D6): the bundled
# node binary may carry the allow-jit key and no other. Every other Mach-O file must
# carry none.
#
# Exit status: 0 when every check passed, 1 otherwise. Every check runs, so one run
# lists everything that is wrong.

set -uo pipefail

# The one path that holds the bundled node binary. Keep it equal to NODE_REL in
# release-app.sh.
NODE_REL="Contents/Resources/node/bin/node"
JIT_KEY="com.apple.security.cs.allow-jit"

failures=0
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  failures=$((failures + 1))
}
ok() { printf 'ok:   %s\n' "$1"; }
step() { printf '\n==> %s\n' "$1"; }

# Hide the organization name that sits in a certificate name: codesign's
# `Authority=` line and Gatekeeper's `origin=` line both carry it.
mask() {
  sed -E 's/(Developer ID (Application|Installer): ).*( \([A-Z0-9]{10}\))/\1<ORG_NAME>\3/'
}

run_with_timeout() {
  local secs="$1"
  shift
  perl -e 'alarm shift; exec @ARGV or exit 127' "$secs" "$@"
}

# The top-level entitlement keys of one file, one per line. Empty when it has none.
entitlement_keys() {
  codesign -d --entitlements - --xml "$1" 2>/dev/null | plutil -p - 2>/dev/null | sed -n 's/^  "\(.*\)" => .*/\1/p'
}

[ "$(uname -s)" = "Darwin" ] || {
  echo "verify-app: this runs on macOS only" >&2
  exit 1
}
[ $# -eq 1 ] || {
  echo "usage: $0 <App.app>" >&2
  exit 1
}
APP="${1%/}"
[ -d "$APP" ] || {
  echo "verify-app: $APP is not a directory" >&2
  exit 1
}
for tool in codesign spctl plutil file perl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "verify-app: $tool not found on PATH" >&2
    exit 1
  }
done

INFO="$APP/Contents/Info.plist"
BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$INFO" 2>/dev/null || true)"
EXEC_NAME="$(plutil -extract CFBundleExecutable raw -o - "$INFO" 2>/dev/null || true)"
VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$INFO" 2>/dev/null || true)"
MAIN="$APP/Contents/MacOS/$EXEC_NAME"
[ -n "$BUNDLE_ID" ] && [ -n "$EXEC_NAME" ] && [ -f "$MAIN" ] || {
  echo "verify-app: Info.plist or the main executable is missing" >&2
  exit 1
}
NODE_BIN="$APP/$NODE_REL"
printf 'bundle id: %s\nversion:   %s\n' "$BUNDLE_ID" "$VERSION"

step "Signature, deep and strict"
if out="$(codesign --verify --deep --strict --verbose=2 "$APP" 2>&1)"; then
  ok "codesign --verify --deep --strict"
else
  printf '%s\n' "$out" | mask >&2
  fail "codesign verification failed"
fi

step "Signature details"
details="$(codesign -dv --verbose=4 "$APP" 2>&1)"
printf '%s\n' "$details" | mask | grep -E '^(Identifier|Format|CodeDirectory|Authority|Timestamp|TeamIdentifier|Sealed Resources|Runtime Version)' || true
printf '%s\n' "$details" | grep -q 'flags=.*runtime' && ok "hardened runtime flag is set" || fail "hardened runtime flag is missing on the app"
printf '%s\n' "$details" | grep -q '^Timestamp=' && ok "secure timestamp present" || fail "no secure timestamp on the app"
printf '%s\n' "$details" | grep -q '^Authority=Developer ID Application:' && ok "signed by a Developer ID Application certificate" || fail "not signed by a Developer ID Application certificate"
team="$(printf '%s\n' "$details" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
ident="$(printf '%s\n' "$details" | sed -n 's/^Identifier=//p' | head -n 1)"
[ -n "$team" ] && [ "$team" != "not set" ] && ok "team id: $team" || fail "no team id (an ad-hoc signature has none)"
[ "$ident" = "$BUNDLE_ID" ] && ok "signing identifier equals the bundle id" || fail "signing identifier '$ident' differs from the bundle id '$BUNDLE_ID'"
[ -z "${BROWXAI_EXPECT_TEAM_ID:-}" ] || { [ "$team" = "$BROWXAI_EXPECT_TEAM_ID" ] && ok "team id equals BROWXAI_EXPECT_TEAM_ID" || fail "team id '$team' is not BROWXAI_EXPECT_TEAM_ID"; }
[ -z "${BROWXAI_EXPECT_BUNDLE_ID:-}" ] || { [ "$BUNDLE_ID" = "$BROWXAI_EXPECT_BUNDLE_ID" ] && ok "bundle id equals BROWXAI_EXPECT_BUNDLE_ID" || fail "bundle id '$BUNDLE_ID' is not BROWXAI_EXPECT_BUNDLE_ID"; }

step "Every Mach-O file: signed, hardened, same team"
checked=0
while IFS= read -r f; do
  file -b "$f" | grep -q 'Mach-O' || continue
  checked=$((checked + 1))
  rel="${f#"$APP"/}"
  d="$(codesign -dv --verbose=4 "$f" 2>&1)" || {
    fail "$rel: not signed"
    continue
  }
  printf '%s\n' "$d" | grep -q 'flags=.*runtime' || fail "$rel: hardened runtime flag missing"
  printf '%s\n' "$d" | grep -q '^Timestamp=' || fail "$rel: no secure timestamp"
  t="$(printf '%s\n' "$d" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
  [ "$t" = "$team" ] || fail "$rel: team '$t' differs from the app's '$team'"
  codesign --verify --strict "$f" >/dev/null 2>&1 || fail "$rel: strict verification failed"
done < <(find "$APP" -type f)
ok "$checked Mach-O file(s) checked"

step "Gatekeeper"
assess="$(spctl --assess --type execute --verbose=4 "$APP" 2>&1)"
printf '%s\n' "$assess" | mask
printf '%s\n' "$assess" | grep -q 'Notarized Developer ID' && ok "spctl: Notarized Developer ID" || fail "spctl did not report Notarized Developer ID"

step "Notary ticket"
if xcrun stapler validate "$APP" 2>&1; then
  ok "stapler validate"
else
  fail "no valid stapled ticket (a first launch offline would fail Gatekeeper)"
fi

step "Designated requirement"
dr="$(codesign -d -r- "$APP" 2>&1 | sed -n 's/^designated => //p')"
if [ -z "$dr" ]; then
  fail "could not read the designated requirement"
else
  printf '%s\n' "$dr"
  printf '%s\n' "$dr" | grep -q "identifier \"$BUNDLE_ID\"" && ok "requirement names the bundle id" || fail "requirement does not name the bundle id"
  printf '%s\n' "$dr" | grep -q 'certificate leaf\[subject.OU\] = ' && ok "requirement names a team" || fail "requirement does not name a team (an ad-hoc signature pins a code hash instead, and a TCC grant does not survive the next build)"
  printf '%s\n' "$dr" | grep -q 'cdhash' && fail "requirement pins a cdhash"
  if [ -n "${BROWXAI_DR_BASELINE:-}" ]; then
    if [ -f "$BROWXAI_DR_BASELINE" ]; then
      if [ "$(cat "$BROWXAI_DR_BASELINE")" = "$dr" ]; then
        ok "requirement equals the baseline in BROWXAI_DR_BASELINE"
      else
        fail "requirement differs from the baseline in BROWXAI_DR_BASELINE. A grant made to the old build will not apply."
      fi
    else
      printf '%s\n' "$dr" >"$BROWXAI_DR_BASELINE"
      ok "baseline written to BROWXAI_DR_BASELINE"
    fi
  fi
fi

step "Entitlements (enforced)"
ent_bad=0
while IFS= read -r f; do
  file -b "$f" | grep -q 'Mach-O' || continue
  rel="${f#"$APP"/}"
  keys="$(entitlement_keys "$f")"
  if [ "$f" = "$NODE_BIN" ]; then
    printf '%s carries: %s\n' "$rel" "$(printf '%s' "$keys" | tr '\n' ' ')"
    printf '%s\n' "$keys" | grep -qx "$JIT_KEY" || {
      fail "$rel: $JIT_KEY is missing, and a hardened node cannot run V8's JIT without it"
      ent_bad=1
    }
    extra="$(printf '%s\n' "$keys" | grep -v '^$' | grep -vx "$JIT_KEY" || true)"
    if [ -n "$extra" ]; then
      fail "$rel: carries entitlement(s) beyond allow-jit: $(printf '%s' "$extra" | tr '\n' ' '). RFC 0012 allows widening only with a recorded reason, and then this script changes with it."
      ent_bad=1
    fi
  elif [ -n "$keys" ]; then
    fail "$rel: carries entitlement(s) and only the node binary may: $(printf '%s' "$keys" | tr '\n' ' ')"
    ent_bad=1
  fi
done < <(find "$APP" -type f)
[ -e "$NODE_BIN" ] || echo "note: no node binary at $NODE_REL (a plain test app has none)"
[ "$ent_bad" -eq 0 ] && ok "entitlements match the rules"

HELPER="$APP/Contents/Helpers/browxai-cloud"
step "Bundled helper"
if [ ! -e "$HELPER" ]; then
  echo "none (this is the plain browxai host app)"
else
  helper_ok=1
  hd="$(codesign -dv --verbose=4 "$HELPER" 2>&1)" || hd=""
  hid="$(printf '%s\n' "$hd" | sed -n 's/^Identifier=//p' | head -n 1)"
  hteam="$(printf '%s\n' "$hd" | sed -n 's/^TeamIdentifier=//p' | head -n 1)"
  if [ "$hid" = "$BUNDLE_ID.cloud" ]; then ok "helper identifier is $hid"; else
    fail "helper identifier is '$hid', expected '$BUNDLE_ID.cloud'"
    helper_ok=0
  fi
  if [ -n "$hteam" ] && [ "$hteam" = "$team" ]; then ok "helper team equals the app's team"; else
    fail "helper team '$hteam' differs from the app's '$team'"
    helper_ok=0
  fi
  if codesign --verify --strict --verbose=2 "$HELPER" >/dev/null 2>&1; then ok "helper signature verifies"; else
    fail "helper signature does not verify"
    helper_ok=0
  fi
  [ -f "$APP/Contents/Resources/bin/browxai-cloud" ] && ok "PATH wrapper present" || fail "Contents/Resources/bin/browxai-cloud is missing, so the cask cannot link the helper onto PATH"
  manifest="$APP/Contents/Resources/bundled-helpers.json"
  helper_version=""
  if [ "$helper_ok" -eq 1 ]; then
    # Run the helper only after its signature, identifier and team all checked out.
    rc=0
    vout="$(run_with_timeout 10 "$HELPER" --version 2>/dev/null)" || rc=$?
    if [ "$rc" -ne 0 ]; then
      fail "the helper's --version exited with status $rc (142 means it timed out after 10 seconds)"
    else
      helper_version="$(printf '%s\n' "$vout" | head -n 1)"
      printf 'helper version: %s\n' "${helper_version:-unknown}"
      [ -n "$helper_version" ] || fail "the helper printed no version"
    fi
  else
    echo "helper not run: its signature checks failed"
  fi
  if [ -f "$manifest" ]; then
    printf 'manifest: %s\n' "$(tr -d '\n ' <"$manifest")"
    if [ -n "$helper_version" ]; then
      grep -q "\"version\": \"$helper_version\"" "$manifest" && ok "manifest version equals the helper's --version" || fail "manifest version differs from the helper's --version"
    fi
    if [ -n "${BROWXAI_CLOUD_HELPER_SHA256:-}" ]; then
      want="$(printf '%s' "$BROWXAI_CLOUD_HELPER_SHA256" | tr 'A-F' 'a-f')"
      grep -q "\"sourceSha256\": \"$want\"" "$manifest" && ok "manifest source digest equals BROWXAI_CLOUD_HELPER_SHA256" || fail "manifest source digest differs from BROWXAI_CLOUD_HELPER_SHA256"
    fi
  else
    fail "Contents/Resources/bundled-helpers.json is missing"
  fi
fi

step "Result"
if [ "$failures" -eq 0 ]; then
  echo "all checks passed"
  exit 0
fi
printf '%d check(s) failed\n' "$failures" >&2
exit 1
