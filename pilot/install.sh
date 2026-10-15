#!/bin/bash
# Install the Muse Code pilot from this repo onto a Muse VM.
# The repo's pilot/ directory is the source of truth; this script deploys it
# to the runtime dir (default ~/workspace/muse-code-space-pilot; state/,
# logs, and node_modules OUT of the repo), installs systemd units, and
# verifies health. Safe to re-run: it never touches state/*.jsonl,
# sessions.json, or aliases.json.
#
# Usage: pilot/install.sh [--runtime DIR] [--no-enable] [--no-cron]
set -u
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="${HOME}/workspace/muse-code-space-pilot"
ENABLE=1
CRON=1
for arg in "$@"; do
  case "$arg" in
    --runtime=*) RUNTIME="${arg#--runtime=}" ;;
    --runtime) echo "--runtime needs DIR, use --runtime=DIR" >&2; exit 2 ;;
    --no-enable) ENABLE=0 ;;
    --no-cron) CRON=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done
PILOT_USER="$(id -un)"
log() { echo "[install] $*"; }
fail() { echo "[install] ERROR: $*" >&2; exit 1; }

# ---- prerequisites (agent must fix these first; see docs/PILOT.md) ----
command -v node >/dev/null || fail "node not found"
command -v python3 >/dev/null || fail "python3 not found"
command -v curl >/dev/null || fail "curl not found"
MUSE_BIN="${MUSE_CODE_SPACE_MUSE_BIN:-}"
if [ -z "$MUSE_BIN" ]; then
  # No explicit binary: install the launcher if missing, download the latest
  # CLI through it, then pin a copy the launcher won't auto-update or prune.
  LAUNCHER="${HOME}/.local/bin/muse"
  if [ ! -x "$LAUNCHER" ]; then
    log "Installing muse launcher from https://api.meta.ai/muse-launcher.sh"
    mkdir -p "${HOME}/.local/bin"
    curl -fsSL https://api.meta.ai/muse-launcher.sh -o "$LAUNCHER" \
      || fail "launcher download failed"
    chmod +x "$LAUNCHER"
  fi
  "$LAUNCHER" --version >/dev/null 2>&1 || fail "launcher failed to provide a muse binary"
  LATEST_BIN="$(ls -t "${HOME}/.local/bin"/muse-bin-* 2>/dev/null | head -1)"
  [ -n "$LATEST_BIN" ] || fail "no muse binary found after launcher run"
  MUSE_BIN="${HOME}/.local/bin/muse-pilot"
  cp -f "$LATEST_BIN" "$MUSE_BIN" || fail "failed to pin muse binary"
  chmod +x "$MUSE_BIN"
  log "Pinned muse binary: $MUSE_BIN (from $LATEST_BIN)"
fi
PILOT_PORT="${MUSE_CODE_SPACE_PILOT_PORT:-18791}"
RELAY_PORT="${MUSE_CODE_SPACE_RELAY_PORT:-18790}"
BROKER_PORT="${MUSE_CODE_SPACE_GITHUB_BROKER_PORT:-18792}"
for port in "$PILOT_PORT" "$RELAY_PORT" "$BROKER_PORT"; do
  case "$port" in ''|*[!0-9]*) fail "invalid port: $port" ;; esac
  [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || fail "port out of range: $port"
done
[ "$PILOT_PORT" != "$RELAY_PORT" ] && [ "$PILOT_PORT" != "$BROKER_PORT" ] && [ "$RELAY_PORT" != "$BROKER_PORT" ] || fail "pilot, relay, and broker ports must differ"
# Ports are host-global. Reinstalls may use this project's active units, but
# never adopt another service (including the old generic Muse pilot/relay).
check_port_owner() {
  local port="$1" unit="$2"
  if node - "$port" <<'JS' >/dev/null 2>&1
const net = require('node:net');
const server = net.createServer();
server.once('error', () => process.exit(1));
server.listen(Number(process.argv[2]), '127.0.0.1', () => server.close(() => process.exit(0)));
JS
  then return 0; fi
  if command -v systemctl >/dev/null && systemctl is-active --quiet "$unit" 2>/dev/null &&
      systemctl show "$unit" -p ExecStart --value 2>/dev/null | grep -Fq "$RUNTIME/"; then
    log "port $port belongs to this project's $unit"
    return 0
  fi
  fail "127.0.0.1:$port is already in use; stop the old service or choose another project port"
}
check_port_owner "$RELAY_PORT" muse-code-space-relay.service
check_port_owner "$PILOT_PORT" muse-code-space-pilot.service
check_port_owner "$BROKER_PORT" muse-code-space-github-broker.service
[ -x "$MUSE_BIN" ] || fail "muse binary missing: $MUSE_BIN (see docs/PILOT.md)"
log "Muse binary: $MUSE_BIN (must grant sessionMcp for built-in messaging)"
# Write sentinel auth.json: the CLI's startup check needs the file to exist,
# but real API auth happens in the relay via the custom.meta-model-api
# surrogate. No real credential is needed here.
if [ ! -f "${HOME}/.config/muse-code-space-pilot/muse/auth.json" ]; then
  mkdir -p "${HOME}/.config/muse-code-space-pilot/muse"
  printf '%s\n' '{"schema_version": 1, "providers": {"meta": {"api_key": "relay-provided-sentinel"}}}' \
    > "${HOME}/.config/muse-code-space-pilot/muse/auth.json"
  chmod 600 "${HOME}/.config/muse-code-space-pilot/muse/auth.json"
  log "wrote sentinel auth.json (relay provides real credential via surrogate)"
fi

# ---- deploy files (code only; state/ and logs stay untouched) ----
mkdir -p "$RUNTIME/state"
for f in pilot.mjs terminals.mjs files.mjs mcp.mjs pty_bridge.py package.json package-lock.json muse_relay.py github_broker.py setup_github_broker.py watchdog.sh recovery.test.mjs files.test.mjs; do
  cp "$REPO_DIR/$f" "$RUNTIME/$f" || fail "copy $f"
done
cp "$REPO_DIR/../server/src/assistantAvatar.mjs" "$RUNTIME/assistant-avatar.mjs" || fail "copy shared avatar validator"
# Remove the old bash fallback; agent messaging now requires per-session MCP.
rm -f "$RUNTIME/bin/code-agents"
rmdir "$RUNTIME/bin" 2>/dev/null || true
chmod +x "$RUNTIME/watchdog.sh"
log "deployed code to $RUNTIME"

# ---- proxy env for the relay (install-time capture) ----
# systemd units don't inherit this shell's proxy variables, but the relay's
# urllib needs them to reach api.meta.ai (direct egress fails on this VM).
# Written as an EnvironmentFile the unit loads; '-' in the unit keeps it
# optional so installs without proxies still start.
: > "$RUNTIME/proxy.env"
chmod 600 "$RUNTIME/proxy.env" # proxy URLs may carry credentials
for v in http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY no_proxy NO_PROXY; do
  val="${!v:-}"
  case "$val" in
    ""|*$'\n'*) continue ;;
  esac
  printf '%s=%s\n' "$v" "$val" >> "$RUNTIME/proxy.env"
done
log "wrote $RUNTIME/proxy.env"

# ---- GitHub broker session wiring (sentinel only; never a real credential) ----
# The broker's loopback TLS cert: gh forces https for its api_host override,
# so sessions trust this cert via the generated CA bundle (system roots +
# broker cert). Cert is public material; the key stays 600 in the runtime.
# Generated once and kept stable across reinstalls so trust doesn't churn.
if [ ! -f "$RUNTIME/github-broker-cert.pem" ] || [ ! -f "$RUNTIME/github-broker-key.pem" ]; then
  command -v openssl >/dev/null || fail "openssl not found (needed for the broker loopback cert)"
  openssl req -x509 -newkey rsa:2048 -keyout "$RUNTIME/github-broker-key.pem" \
    -out "$RUNTIME/github-broker-cert.pem" -days 3650 -nodes -subj "/CN=localhost" \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1 \
    || fail "failed to generate the broker loopback cert"
  chmod 600 "$RUNTIME/github-broker-key.pem"
  log "generated broker loopback cert"
fi
SYSTEM_CA=""
for candidate in "${SSL_CERT_FILE:-}" /etc/ssl/certs/ca-certificates.crt /run/hatch/egress-tls/ca-bundle.pem; do
  if [ -n "$candidate" ] && [ -f "$candidate" ]; then SYSTEM_CA="$candidate"; break; fi
done
{ [ -n "$SYSTEM_CA" ] && cat "$SYSTEM_CA"; cat "$RUNTIME/github-broker-cert.pem"; } > "$RUNTIME/github-broker-ca.pem"
chmod 644 "$RUNTIME/github-broker-ca.pem"
# Session gitconfig (pilot sets GIT_CONFIG_GLOBAL to this for sessions only;
# ~/.gitconfig is never read or written here).
cat > "$RUNTIME/gitconfig" <<EOF
[url "https://127.0.0.1:$BROKER_PORT/"]
	insteadOf = https://github.com/
[http "https://127.0.0.1:$BROKER_PORT"]
	sslCAInfo = $RUNTIME/github-broker-cert.pem
[credential "https://127.0.0.1:$BROKER_PORT"]
	username = x-access-token
	helper = "!f() { test \\"\$1\\" = get && printf 'username=x-access-token\\npassword=broker-provided-sentinel\\n'; }; f"
EOF
chmod 644 "$RUNTIME/gitconfig"
# Session gh config (pilot sets GH_CONFIG_DIR to this for sessions only).
mkdir -p "$RUNTIME/gh-config"
cat > "$RUNTIME/gh-config/hosts.yml" <<EOF
github.com:
    user: x-access-token
    oauth_token: broker-provided-sentinel
    git_protocol: https
    api_host: 127.0.0.1:$BROKER_PORT
EOF
printf 'git_protocol: https\n' > "$RUNTIME/gh-config/config.yml"
chmod 644 "$RUNTIME/gh-config/hosts.yml" "$RUNTIME/gh-config/config.yml"
# Interactive App provisioning entry point (prompts, validates, restarts).
printf '#!/bin/sh\nexec python3 "%s/setup_github_broker.py" "$@"\n' "$RUNTIME" > "$RUNTIME/setup-github-broker"
chmod +x "$RUNTIME/setup-github-broker"
# Login terminals re-export the egress CA from /etc/profile.d *after* the
# pilot spawns them, clobbering the session CA pins — so git in a terminal
# fails broker TLS verification even though agent shells work. The user's
# own ~/.profile runs after the system profile; keep a small managed block
# there that re-pins the combined CA bundle (system roots + broker cert)
# for interactive terminals. Marker-delimited and idempotent; removing the
# block restores stock behavior. Scoped to GitHub support: the block is
# only present while a broker credential is provisioned (the setup script
# adds it on successful setup; installs without a credential remove it).
PROFILE_FILE="${HOME}/.profile"
touch "$PROFILE_FILE"
if [ -f "${HOME}/.config/muse-code-space-pilot/github-broker.json" ]; then
  PROFILE_MODE=add
else
  PROFILE_MODE=remove
fi
python3 - "$PROFILE_FILE" "$RUNTIME/github-broker-ca.pem" "$PROFILE_MODE" <<'PY'
import pathlib, sys
profile = pathlib.Path(sys.argv[1])
ca, mode = sys.argv[2], sys.argv[3]
begin, end = "# >>> muse-code-space github broker >>>", "# <<< muse-code-space github broker <<<"
lines = profile.read_text().splitlines()
kept, skipping = [], False
for line in lines:
    if line.strip() == begin: skipping = True
    if not skipping: kept.append(line)
    if line.strip() == end: skipping = False
if mode == "add":
    block = [begin,
             f'export GIT_SSL_CAINFO="{ca}"',
             f'export SSL_CERT_FILE="{ca}"',
             end]
    kept = kept + ([""] if kept and kept[-1] else []) + block
profile.write_text("\n".join(kept) + "\n")
PY
if [ "$PROFILE_MODE" = "add" ]; then
  log "pinned broker CA for login terminals in $PROFILE_FILE"
else
  log "no GitHub credential provisioned; login-terminal CA block left absent in $PROFILE_FILE"
fi
log "wrote session gitconfig + gh config (sentinel only)"
# The real credential is host-local and provisioned separately via Secure
# Vault (see docs); install never creates or overwrites it.
if [ -f "${HOME}/.config/muse-code-space-pilot/github-broker.json" ]; then
  log "found host-local GitHub credential file (left untouched)"
else
  log "no GitHub credential file yet — sessions will fail with a clear broker credential error until one is provisioned (see docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md)"
fi

# Package files have just been copied into the runtime, so comparing them
# now always says "equal". Verify the installed SDK version itself instead:
# a stale node_modules after an upgrade/downgrade can break the pilot.
WANTED_SDK="$(node -p "require('$RUNTIME/package.json').dependencies['@muse-code/sdk']")"
INSTALLED_SDK="$(node -p "require('$RUNTIME/node_modules/@muse-code/sdk/package.json').version" 2>/dev/null || true)"
if [ "$INSTALLED_SDK" != "$WANTED_SDK" ]; then
  log "installing node deps (SDK $INSTALLED_SDK -> $WANTED_SDK)…"
  (cd "$RUNTIME" && npm ci --no-audit --no-fund) || fail "npm ci"
else
  log "node deps in sync, skipping npm ci"
fi

# ---- pilot config: relay endpoint for `muse serve` (create only, never clobber) ----
SETTINGS="${HOME}/.config/muse-code-space-pilot/muse/settings.json"
if [ ! -f "$SETTINGS" ]; then
  mkdir -p "$(dirname "$SETTINGS")"
  printf '{\n  "schema_version": 1,\n  "endpoint_transport": {\n    "base_url": "http://127.0.0.1:%s",\n    "auth": "bearer"\n  }\n}\n' "$RELAY_PORT" > "$SETTINGS"
  log "wrote $SETTINGS"
else
  python3 - "$SETTINGS" "$RELAY_PORT" <<'PY' >/dev/null 2>&1 || fail "Muse settings relay URL does not match port $RELAY_PORT; review $SETTINGS before reinstalling"
import json, sys
with open(sys.argv[1]) as stream:
    settings = json.load(stream)
assert settings.get('endpoint_transport', {}).get('base_url') == f'http://127.0.0.1:{sys.argv[2]}'
PY
fi

# ---- reminder duties off (headless pilot sessions never answer them) ----
# The bundled tbh-reminders plugin spawns a per-turn child agent for each
# duty; the skill-reminder child wedged turns open for hours with the
# backend idle (2026-10-01). Deny all six reminder capabilities. Merge,
# never clobber: every existing key (endpoint_transport, auth, …) survives.
# shellcheck disable=SC2086
REMINDER_DUTIES="plugin:tbh-reminders:reminder:memory plugin:tbh-reminders:reminder:skill-reminder plugin:tbh-reminders:reminder:todo-reminder plugin:tbh-reminders:reminder:goal-reminder plugin:tbh-reminders:reminder:verify-reminder plugin:tbh-reminders:reminder:scope-reminder"
ADDED="$(python3 - "$SETTINGS" $REMINDER_DUTIES <<'EOF' 2>/dev/null || true
import json, sys
path, duties = sys.argv[1], sys.argv[2:]
try:
    with open(path) as f:
        settings = json.load(f)
except (OSError, ValueError):
    settings = {"schema_version": 1}
if not isinstance(settings, dict):
    settings = {"schema_version": 1}
ext = settings.setdefault("extensions", {})
if not isinstance(ext, dict):
    ext = settings["extensions"] = {}
rc = ext.setdefault("runtime_capabilities", {})
if not isinstance(rc, dict):
    rc = ext["runtime_capabilities"] = {}
denied = rc.setdefault("denied_identities", [])
if not isinstance(denied, list):
    denied = rc["denied_identities"] = []
added = [d for d in duties if d not in denied]
denied.extend(added)
with open(path, "w") as f:
    json.dump(settings, f, indent=2)
    f.write("\n")
print(" ".join(added))
EOF
)"
if [ -n "$ADDED" ]; then
  log "disabled reminder duties: $ADDED"
else
  log "reminder duties already disabled (or settings merge skipped)"
fi

# ---- systemd units (rendered from repo templates) ----
render_unit() {
  sed -e "s|@PILOT_DIR@|${RUNTIME}|g" \
      -e "s|@PILOT_USER@|${PILOT_USER}|g" \
      -e "s|@PILOT_HOME@|${HOME}|g" \
      -e "s|@MUSE_BIN@|${MUSE_BIN}|g" \
      -e "s|@PILOT_PORT@|${PILOT_PORT}|g" \
      -e "s|@RELAY_PORT@|${RELAY_PORT}|g" \
      -e "s|@BROKER_PORT@|${BROKER_PORT}|g" \
      "$REPO_DIR/systemd/$1" > "$RUNTIME/$1"
}
render_unit muse-code-space-pilot.service
render_unit muse-code-space-relay.service
render_unit muse-code-space-github-broker.service

if [ "$ENABLE" = "1" ]; then
  command -v systemctl >/dev/null || fail "no systemctl; re-run with --no-enable and supervise via watchdog/cron"
  [ -d /run/systemd/system ] || fail "systemd not running; re-run with --no-enable"
  [ "$(id -u)" = "0" ] || fail "unit install needs root; re-run as root or with sudo"
  cp "$RUNTIME/muse-code-space-pilot.service" /etc/systemd/system/muse-code-space-pilot.service
  cp "$RUNTIME/muse-code-space-relay.service" /etc/systemd/system/muse-code-space-relay.service
  cp "$RUNTIME/muse-code-space-github-broker.service" /etc/systemd/system/muse-code-space-github-broker.service
  systemctl daemon-reload
  systemctl enable muse-code-space-relay.service muse-code-space-github-broker.service muse-code-space-pilot.service || fail "unit enable failed"
  # --now does not reload an already-running process after copying new code.
  systemctl restart muse-code-space-relay.service || fail "relay unit failed to restart"
  systemctl restart muse-code-space-github-broker.service || fail "broker unit failed to restart"
  systemctl restart muse-code-space-pilot.service || fail "pilot unit failed to restart"
  log "units enabled and restarted"
fi

# ---- watchdog cron (every 2m, silent unless recovery fails) ----
if [ "$CRON" = "1" ] && command -v crontab >/dev/null; then
  if crontab -l 2>/dev/null | grep -Fq "$RUNTIME/watchdog.sh"; then
    log "watchdog cron already present"
  else
    (crontab -l 2>/dev/null; echo "*/2 * * * * MUSE_CODE_SPACE_PILOT_DIR=$RUNTIME MUSE_CODE_SPACE_PILOT_PORT=$PILOT_PORT MUSE_CODE_SPACE_RELAY_PORT=$RELAY_PORT MUSE_CODE_SPACE_GITHUB_BROKER_PORT=$BROKER_PORT $RUNTIME/watchdog.sh") | crontab -
    log "watchdog cron installed"
  fi
fi

# ---- verify ----
# HTTP starts before session recovery (required MCP servers need it), but
# /health stays unhealthy until all registered sessions are reconciled.
# Wait for readiness instead of treating a still-booting service as failed.
RELAY_OK=0; PILOT_OK=0; BROKER_OK=0
ATTEMPTS=1
[ "$ENABLE" = "1" ] && ATTEMPTS=60
for ((i=1; i<=ATTEMPTS; i++)); do
  curl -fsS -m 5 "http://127.0.0.1:$RELAY_PORT/__code_space/health" | grep -q '"ok": *true' && RELAY_OK=1
  curl -fsS -m 5 --cacert "$RUNTIME/github-broker-cert.pem" "https://127.0.0.1:$BROKER_PORT/__code_space/health" | grep -q '"ok": *true' && BROKER_OK=1
  curl -s -m 5 "http://127.0.0.1:$PILOT_PORT/health" | grep -q '"ok":true' && PILOT_OK=1
  [ "$RELAY_OK" = "1" ] && [ "$PILOT_OK" = "1" ] && [ "$BROKER_OK" = "1" ] && break
  [ "$i" -lt "$ATTEMPTS" ] && sleep 1
done
[ "$RELAY_OK" = "1" ] && log "relay $RELAY_PORT: UP" || log "relay $RELAY_PORT: DOWN"
[ "$BROKER_OK" = "1" ] && log "github broker $BROKER_PORT: UP" || log "github broker $BROKER_PORT: DOWN"
[ "$PILOT_OK" = "1" ] && log "pilot $PILOT_PORT: UP" || log "pilot $PILOT_PORT: DOWN"
if [ "$ENABLE" = "1" ] && { [ "$RELAY_OK" != "1" ] || [ "$PILOT_OK" != "1" ] || [ "$BROKER_OK" != "1" ]; }; then
  fail "a service is down — check $RUNTIME/relay.log, $RUNTIME/github-broker.log and $RUNTIME/pilot.log (the Muse binary must grant sessionMcp)"
fi
log "done"
