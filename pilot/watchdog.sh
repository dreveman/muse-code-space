#!/bin/bash
# Muse Code Space watchdog: keeps this project's pilot and relay serving.
# Cron-safe: silent unless recovery fails.
#
# Single-supervisor rule (see docs/PILOT.md): when the systemd
# unit is installed, manage the process ONLY through systemctl — never start
# a second copy directly, or systemd's Restart=always crash-loops fighting
# over the port. Direct start is the last resort for hosts without systemd.
set -u
PILOT_DIR="${MUSE_CODE_SPACE_PILOT_DIR:-${HOME}/workspace/muse-code-space-pilot}"
PILOT_PORT="${MUSE_CODE_SPACE_PILOT_PORT:-18791}"
RELAY_PORT="${MUSE_CODE_SPACE_RELAY_PORT:-18790}"
BROKER_PORT="${MUSE_CODE_SPACE_GITHUB_BROKER_PORT:-443}"
LOG="$PILOT_DIR/watchdog.log"

pilot_healthy() {
  # Healthy means ok:true AND an empty unrecovered list: relay-down, a
  # failed boot recovery, or a wedged turn (see /health `turns.stuck`)
  # is "unhealthy", not a footnote.
  local health
  health="$(curl -s -m 5 "http://127.0.0.1:$PILOT_PORT/health" 2>/dev/null)" || return 1
  echo "$health" | grep -q '"ok":true' || return 1
  echo "$health" | grep -q '"unrecovered":\[\]' || return 1
}
relay_healthy() {
  # Local liveness: never send watchdog probes to api.meta.ai.
  curl -fsS -m 5 "http://127.0.0.1:$RELAY_PORT/__code_space/health" 2>/dev/null | grep -q '"ok": *true'
}
broker_healthy() {
  # Local liveness only: -k is fine here (loopback health, no credential is
  # ever sent by a health probe); never probe github.com directly.
  curl -fsSk -m 5 "https://127.0.0.1:$BROKER_PORT/__code_space/health" 2>/dev/null | grep -q '"ok": *true'
}
has_systemd() {
  systemctl --version >/dev/null 2>&1 && [ -d /run/systemd/system ]
}
unit_installed() {
  systemctl cat "$1" >/dev/null 2>&1
}

wait_healthy() {
  # $1 = health check fn, $2 = timeout seconds. A recovering pilot needs
  # time: spawning `muse serve` and resuming sessions takes 10-30s, so the
  # old single check 4-5s after start reported RECOVERY FAILED for a
  # recovery that was still booting (observed 2026-10-01: pilot listening
  # ~6s after the FAILED stamp).
  local healthy_fn="$1" timeout_s="$2" waited=0
  while [ "$waited" -lt "$timeout_s" ]; do
    if "$healthy_fn"; then
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  "$healthy_fn"
}

recover_service() {
  # $1 = unit name, $2 = health check fn, $3 = pkill pattern, $4 = direct-start command
  local unit="$1" healthy_fn="$2" match="$3" direct_cmd="$4"
  if "$healthy_fn"; then
    return 0
  fi
  echo "$(date -u +%FT%TZ) $unit unhealthy, attempting recovery" >> "$LOG"
  if has_systemd && unit_installed "$unit"; then
    # Unit-managed host: systemctl only, never a direct second copy.
    if [ -f "$PILOT_DIR/$unit" ]; then
      cp "$PILOT_DIR/$unit" "/etc/systemd/system/$unit" 2>/dev/null
      systemctl daemon-reload 2>/dev/null
    fi
    systemctl enable --now "$unit" 2>/dev/null || systemctl restart "$unit" 2>/dev/null
    if wait_healthy "$healthy_fn" 60; then
      echo "$(date -u +%FT%TZ) $unit recovered via systemctl" >> "$LOG"
      return 0
    fi
  else
    # No systemd supervision: direct start is the only option. Kill stragglers
    # first so we never stack two copies on one port.
    pkill -f "$match" 2>/dev/null
    sleep 1
    # shellcheck disable=SC2086
    cd "$PILOT_DIR" && nohup env $direct_cmd >> "$PILOT_DIR/$unit.direct.log" 2>&1 &
    if wait_healthy "$healthy_fn" 60; then
      echo "$(date -u +%FT%TZ) $unit recovered via direct start" >> "$LOG"
      return 0
    fi
  fi
  echo "$(date -u +%FT%TZ) $unit RECOVERY FAILED" >> "$LOG"
  return 1
}

failed=0
recover_service "muse-code-space-relay.service" relay_healthy "$PILOT_DIR/muse_relay.py" "MUSE_CODE_SPACE_RELAY_PORT=$RELAY_PORT /usr/bin/python3 $PILOT_DIR/muse_relay.py" || failed=1
recover_service "muse-code-space-github-broker.service" broker_healthy "$PILOT_DIR/github_broker.py" "MUSE_CODE_SPACE_GITHUB_BROKER_PORT=$BROKER_PORT MUSE_CODE_SPACE_GITHUB_BROKER_RUNTIME=$PILOT_DIR /usr/bin/python3 $PILOT_DIR/github_broker.py" || failed=1
recover_service "muse-code-space-pilot.service" pilot_healthy "$PILOT_DIR/pilot.mjs" "MUSE_CODE_SPACE_PILOT_PORT=$PILOT_PORT MUSE_CODE_SPACE_RELAY_URL=http://127.0.0.1:$RELAY_PORT MUSE_CODE_SPACE_PILOT_STATE_DIR=$PILOT_DIR/state /usr/bin/node $PILOT_DIR/pilot.mjs" || failed=1
exit "$failed"
