#!/usr/bin/env bash
# COMPAT: copy of trackxai scripts/gate-slot.sh (plus restoring the caller's umask for the command); both repos draw from the /srv/trackxai-gate-locks pool.
set -euo pipefail

LOCK_DIR="${GATE_LOCK_DIR:-/srv/trackxai-gate-locks}"
DEFAULT_SLOTS=3

if [ "$#" -eq 0 ]; then
  echo "gate-slot: usage: gate-slot.sh <command> [args...]" >&2
  exit 2
fi
if [ ! -d "$LOCK_DIR" ]; then
  echo "gate-slot: lock directory $LOCK_DIR does not exist; create it with deploy/dev-vm/setup.sh" >&2
  exit 2
fi
if [ ! -w "$LOCK_DIR" ]; then
  echo "gate-slot: $(id -un) cannot write $LOCK_DIR; it must be ci:ci mode 1777, see deploy/dev-vm/setup.sh" >&2
  exit 2
fi

SLOTS="$DEFAULT_SLOTS"
if [ -r "$LOCK_DIR/slots" ]; then
  SLOTS="$(tr -dc '0-9' < "$LOCK_DIR/slots")"
fi
if ! [ "${SLOTS:-0}" -ge 1 ] 2>/dev/null; then
  echo "gate-slot: $LOCK_DIR/slots must hold a positive integer" >&2
  exit 2
fi

CALLER_UMASK="$(umask)"
umask 000

SLOT=""
WAITED=0
while [ -z "$SLOT" ]; do
  for i in $(seq 1 "$SLOTS"); do
    exec 9>>"$LOCK_DIR/slot-$i.lock"
    if flock -n 9; then
      SLOT="$i"
      break
    fi
    exec 9>&-
  done
  if [ -z "$SLOT" ]; then
    [ "$WAITED" -eq 1 ] || echo "==> gate-slot: all $SLOTS slots busy, waiting"
    WAITED=1
    sleep 2
  fi
done
echo "==> gate slot $SLOT of $SLOTS ($LOCK_DIR)"

export GATE_TIMING_LOCK="$LOCK_DIR/perf.lock"
# SECURITY: umask 000 is only for the shared lock files; the command gets the caller's umask so its files are not world-writable.
umask "$CALLER_UMASK"

# BUDGET: a command over GATE_STEP_BUDGET_SECS (default 1200, 20 min) is stopped and fails the step, so a cold cache or a loaded box shows up as a red step with its time instead of a silent 60 min run.
BUDGET="${GATE_STEP_BUDGET_SECS:-1200}"
START="$(date +%s)"
set +e
timeout --signal=TERM --kill-after=30 "$BUDGET" "$@" 9>&-
RC=$?
set -e
echo "==> gate-slot: command took $(( $(date +%s) - START ))s (budget ${BUDGET}s)"
if [ "$RC" -eq 124 ]; then
  echo "==> gate-slot: BUDGET EXCEEDED, stopped after ${BUDGET}s: $*" >&2
fi
exit "$RC"
