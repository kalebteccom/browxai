#!/usr/bin/env bash
# Build, run and probe a WebDriverAgent for the ios-app engine. Runs on a Mac with
# Xcode, by the owner. The steps and the reasons are in the "Real-device lane plan"
# section of docs/rfcs/0008-native-app-control.md.
#
#   scripts/ios/wda-run.sh build    # xcodebuild build-for-testing
#   scripts/ios/wda-run.sh run      # xcodebuild test-without-building (blocks)
#   scripts/ios/wda-run.sh probe    # read the endpoints browxai calls, print shapes
#
# Environment (no value here is a secret, and none is printed except the paths)
#   WDA_DIR       a checkout of github.com/appium/WebDriverAgent at a pinned tag.
#   DERIVED_DATA  the derived data directory. build writes it, run reads it.
#   TARGET        `simulator` or `device`. Default: simulator.
#   UDID          the simulator or device UDID, for `id=<UDID>`.
#   TEAM_ID       device builds only: the 10-character Apple Developer Team ID.
#   ASC_KEY_PATH, ASC_KEY_ID, ASC_ISSUER_ID
#                 optional, device builds only. When all three are set, xcodebuild
#                 uses an App Store Connect API key to create and refresh
#                 provisioning profiles. The first is a path. This script never
#                 reads the file.
#   WDA_URL       probe only: where WebDriverAgent answers, for example
#                 http://127.0.0.1:8100 or http://<DEVICE_IP>:8100
#   APP_ID        probe only: the bundle id to open a session on.
#                 Default: com.apple.Preferences
#
# The probe prints HTTP status codes and the shape of each JSON reply (key names
# and value types). It does not print values, so a device address, a screen
# content or a name stays out of the output.

set -euo pipefail

die() {
  printf 'wda-run: %s\n' "$1" >&2
  exit 1
}

cmd="${1:-}"
TARGET="${TARGET:-simulator}"

need_xcode() {
  [ "$(uname -s)" = "Darwin" ] || die "this runs on macOS only"
  command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild not found. Install Xcode."
  [ -n "${WDA_DIR:-}" ] || die "WDA_DIR is not set"
  [ -d "$WDA_DIR/WebDriverAgent.xcodeproj" ] || die "no WebDriverAgent.xcodeproj in $WDA_DIR"
  [ -n "${DERIVED_DATA:-}" ] || die "DERIVED_DATA is not set"
  [ -n "${UDID:-}" ] || die "UDID is not set"
  case "$UDID" in
    *"<"* | *">"*) die "UDID still holds a placeholder" ;;
  esac
  case "$TARGET" in
    simulator) DEST="platform=iOS Simulator,id=$UDID" ;;
    device)
      DEST="id=$UDID"
      [ -n "${TEAM_ID:-}" ] || die "TEAM_ID is not set (a device build is signed)"
      printf '%s' "$TEAM_ID" | grep -Eq '^[A-Z0-9]{10}$' || die "TEAM_ID must be 10 uppercase letters and digits"
      ;;
    *) die "TARGET must be simulator or device" ;;
  esac
}

signing_args() {
  # Prints nothing for a simulator. For a device, the team and, when all three
  # variables are set, the API key options.
  if [ "$TARGET" = "device" ]; then
    printf '%s\n' "-allowProvisioningUpdates" "DEVELOPMENT_TEAM=$TEAM_ID"
    if [ -n "${ASC_KEY_PATH:-}" ] && [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ]; then
      printf '%s\n' "-authenticationKeyPath" "$ASC_KEY_PATH" \
        "-authenticationKeyID" "$ASC_KEY_ID" \
        "-authenticationKeyIssuerID" "$ASC_ISSUER_ID"
    fi
  else
    printf '%s\n' "CODE_SIGNING_ALLOWED=NO"
  fi
}

collect_signing() {
  SIGNING=()
  while IFS= read -r line; do
    SIGNING+=("$line")
  done < <(signing_args)
}

case "$cmd" in
  build)
    need_xcode
    collect_signing
    printf 'building WebDriverAgentRunner for %s (%s)\n' "$TARGET" "$WDA_DIR"
    xcodebuild build-for-testing \
      -project "$WDA_DIR/WebDriverAgent.xcodeproj" \
      -scheme WebDriverAgentRunner \
      -destination "$DEST" \
      -derivedDataPath "$DERIVED_DATA" \
      ${SIGNING[@]+"${SIGNING[@]}"}
    ;;
  run)
    need_xcode
    collect_signing
    printf 'starting WebDriverAgent on the %s. This blocks. Leave it running.\n' "$TARGET"
    printf 'Look for a line with ServerURLHere. Stop it with Ctrl-C.\n'
    xcodebuild test-without-building \
      -project "$WDA_DIR/WebDriverAgent.xcodeproj" \
      -scheme WebDriverAgentRunner \
      -destination "$DEST" \
      -derivedDataPath "$DERIVED_DATA" \
      ${SIGNING[@]+"${SIGNING[@]}"}
    ;;
  probe)
    [ -n "${WDA_URL:-}" ] || die "WDA_URL is not set"
    command -v curl >/dev/null 2>&1 || die "curl not found"
    command -v node >/dev/null 2>&1 || die "node not found (the probe uses it to print JSON shapes)"
    APP_ID="${APP_ID:-com.apple.Preferences}"
    TMP="$(mktemp -d "${TMPDIR:-/tmp}/wda-probe.XXXXXX")"
    trap 'rm -rf "$TMP"' EXIT

    # Print the shape of a JSON file: key names and value types, to a depth.
    shape() {
      node -e '
        const fs = require("fs");
        let j; try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { console.log("  (not JSON)"); process.exit(0); }
        const maxDepth = Number(process.argv[2]);
        const seen = new Set();
        const walk = (v, p, d) => {
          const t = v === null ? "null" : Array.isArray(v) ? "array(" + v.length + ")" : typeof v;
          if (t === "object" || t.startsWith("array")) {
            if (d >= maxDepth) { console.log("  " + p + ": " + t); return; }
            const items = Array.isArray(v) ? v.slice(0, 1).map((x) => ["[0]", x]) : Object.entries(v);
            if (!Array.isArray(v)) console.log("  " + p + ": object{" + Object.keys(v).join(",") + "}");
            else console.log("  " + p + ": " + t);
            for (const [k, x] of items) walk(x, p + (k === "[0]" ? "[0]" : "." + k), d + 1);
          } else if (!seen.has(p)) { seen.add(p); console.log("  " + p + ": " + t); }
        };
        walk(j, "$", 0);
      ' "$1" "${2:-3}"
    }

    call() {
      # call NAME METHOD PATH [BODY] [DEPTH] -> writes $TMP/NAME.json, prints status and shape
      local name="$1" method="$2" path="$3" body="${4:-}" depth="${5:-3}" code
      if [ -n "$body" ]; then
        code="$(curl -sS -m 60 -o "$TMP/$name.json" -w '%{http_code}' -X "$method" -H 'content-type: application/json' -d "$body" "$WDA_URL$path" || echo 000)"
      else
        code="$(curl -sS -m 60 -o "$TMP/$name.json" -w '%{http_code}' -X "$method" "$WDA_URL$path" || echo 000)"
      fi
      printf '\n%s  %s %s  ->  HTTP %s\n' "$name" "$method" "${path//$SESSION/<session>}" "$code"
      shape "$TMP/$name.json" "$depth"
    }

    SESSION=""
    call status GET /status "" 2
    call session POST /session "{\"capabilities\":{\"alwaysMatch\":{\"bundleId\":\"$APP_ID\"}}}" 2
    SESSION="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log((j.value&&j.value.sessionId)||j.sessionId||"")' "$TMP/session.json" 2>/dev/null || true)"
    [ -n "$SESSION" ] || die "no session id in the reply. WebDriverAgent refused to open a session on $APP_ID."
    printf 'session id found: %s\n' "yes"

    call source GET "/session/$SESSION/source?format=json" "" 4
    # The three fields the ios-app engine reads. Presence only.
    node -e '
      const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const root = j.value || {};
      const keys = new Set(); const types = new Set(); const vis = new Set();
      const walk = (n) => { Object.keys(n || {}).forEach((k) => keys.add(k)); if (n.type) types.add(n.type); if ("isVisible" in n) vis.add(typeof n.isVisible + ":" + String(n.isVisible)); (n.children || []).forEach(walk); };
      walk(root);
      console.log("  node keys seen: " + [...keys].sort().join(","));
      console.log("  rawIdentifier present on some node: " + keys.has("rawIdentifier"));
      console.log("  isVisible encodings seen: " + [...vis].sort().join(","));
      console.log("  root type: " + (root.type || "(none)") + ", distinct types: " + types.size);
    ' "$TMP/source.json" || true

    call screenshot GET "/session/$SESSION/screenshot" "" 2
    call activeAppInfo GET "/session/$SESSION/wda/activeAppInfo" "" 3
    call find_by_accessibility_id POST "/session/$SESSION/element" '{"using":"accessibility id","value":"browxai-probe-no-such-id"}' 3
    call find_application POST "/session/$SESSION/element" '{"using":"class name","value":"XCUIElementTypeApplication"}' 3

    # Route existence for the pinch call. An unknown route answers "unknown command"
    # and a known route answers about the element. The element id here is invalid
    # on purpose, so nothing is pinched.
    printf '\nroute check: which pinch path does this WebDriverAgent know?\n'
    call pinch_a POST "/session/$SESSION/element/00000000-0000-0000-0000-000000000000/pinch" '{"scale":1.0,"velocity":1.0}' 3
    call pinch_b POST "/session/$SESSION/wda/element/00000000-0000-0000-0000-000000000000/pinch" '{"scale":1.0,"velocity":1.0}' 3
    for n in pinch_a pinch_b; do
      printf '  %s error code: %s\n' "$n" "$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log((j.value&&j.value.error)||"(none)")}catch{console.log("(not JSON)")}' "$TMP/$n.json")"
    done

    call delete_session DELETE "/session/$SESSION" "" 2
    printf '\nDone. Compare each shape with src/engine/adapters/ios/wda-client.ts and xcui-driver.ts.\n'
    ;;
  *)
    die "usage: $0 build|run|probe (see the header of this file for the environment)"
    ;;
esac
