#!/usr/bin/env bash
# Hook: Code Space health, identity synchronization, messages and summaries.
# Read-only detection wakes the assistant; workers acknowledge successful work.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PILOT_URL="${MUSE_CODE_SPACE_PILOT_URL:-http://127.0.0.1:18791}"
PILOT_URL="${PILOT_URL%/}"
ARTIFACTS_DIR="${MUSE_CODE_SPACE_ARTIFACTS_DIR:-$HOME/workspace/ts-spaces}"

ISSUES="[]"

# ---- Check 1: pilot/relay systemd units and services ----
# Use systemctl (not raw file-path checks) — the poller may run in a mount
# namespace where /etc/systemd/system isn't visible.
for unit in muse-code-space-pilot.service muse-code-space-relay.service; do
  if ! systemctl cat "$unit" > /dev/null 2>&1; then
    ISSUES=$(echo "$ISSUES" | jq --arg u "$unit" '. + [{type:"missing_unit", unit:$u}]')
  elif ! systemctl is-active --quiet "$unit" 2>/dev/null; then
    ISSUES=$(echo "$ISSUES" | jq --arg u "$unit" '. + [{type:"inactive_service", unit:$u}]')
  fi
done

# Check pilot health endpoint (only if units exist)
if systemctl cat muse-code-space-pilot.service > /dev/null 2>&1; then
  if ! curl -fsS -m 5 "$PILOT_URL/health" 2>/dev/null | jq -e '.ok == true' > /dev/null 2>&1; then
    ISSUES=$(echo "$ISSUES" | jq '. + [{type:"pilot_unhealthy"}]')
  fi
fi

# Identity/inbox checks are independent of the artifact DB and summary work.
# This helper reads the pilot only; it never sets identity or sends messages.
CHECK_ARGS=(inspect --pilot-url "$PILOT_URL"
  --scope "${MUSE_CODE_SPACE_ARTIFACT_SLUG:-code-space}"
  --state-dir "${MUSE_CODE_SPACE_WATCHDOG_STATE_DIR:-$HOME/hooks/state/code-space-watchdog}")
if [ -n "${MUSE_CODE_SPACE_ASSISTANT_PROFILE:-}" ]; then
  # Optional override; otherwise the worker supplies its live name and avatar.
  CHECK_ARGS+=(--profile-file "$MUSE_CODE_SPACE_ASSISTANT_PROFILE")
fi
if [ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ]; then
  CHECK_ARGS+=(--dry-run)
fi
if POLL_ISSUES=$(python3 "$HOOK_DIR/code-space-watchdog-state.py" "${CHECK_ARGS[@]}") &&
    echo "$POLL_ISSUES" | jq -e 'type == "array"' > /dev/null 2>&1; then
  ISSUES=$(jq -cn --argjson existing "$ISSUES" --argjson added "$POLL_ISSUES" '$existing + $added')
else
  ISSUES=$(echo "$ISSUES" | jq '. + [{type:"code_space_watchdog_check_failed", reason:"Identity/inbox helper failed; check its installation and state."}]')
fi

# ---- Check 2: sessions needing a summary ----
# The assistant supplies only a session summary; agent artwork comes from the roster.
find_code_space_db() {
  for dir in "$ARTIFACTS_DIR"/*/; do
    [ -f "$dir/space.json" ] || continue
    [ -f "$dir/app.db" ] || continue
    if jq -e '.name == "Code Space"' "$dir/space.json" > /dev/null 2>&1; then
      echo "${dir}app.db"
      return 0
    fi
  done
  return 1
}

if DB=$(find_code_space_db); then
  # Sessions missing a summary
  NEED_WORK=$(sqlite3 "$DB" "SELECT id FROM sessions WHERE archived = 0 AND session_summary IS NULL;" 2>/dev/null || echo "")
  if [ -n "$NEED_WORK" ]; then
    # Track in-progress to avoid duplicate worker spawns; stale entries
    # (>10 min) are retried. State format: {id: timestamp_ms}
    NOW_MS=$(date +%s%3N)
    STALE_MS=$((10 * 60 * 1000))
    PROGRESS_FILE="$HOME/hooks/state/code-space-in-progress.json"
    if [ "${HATCH_HOOK_DRY_RUN:-0}" != "1" ]; then
      mkdir -p "$(dirname "$PROGRESS_FILE")"
    fi
    PROGRESS="{}"
    [ -f "$PROGRESS_FILE" ] && PROGRESS=$(cat "$PROGRESS_FILE")
    TO_PROCESS=""
    for id in $NEED_WORK; do
      STARTED=$(echo "$PROGRESS" | jq -r --arg id "$id" '.[$id] // 0')
      AGE=$((NOW_MS - STARTED))
      if [ "$STARTED" -eq 0 ] || [ "$AGE" -gt "$STALE_MS" ]; then
        TO_PROCESS="$TO_PROCESS $id"
        if [ "$HATCH_HOOK_DRY_RUN" != "1" ]; then
          PROGRESS=$(echo "$PROGRESS" | jq --arg id "$id" --argjson now "$NOW_MS" '.[$id] = $now')
        fi
      fi
    done
    if [ "$HATCH_HOOK_DRY_RUN" != "1" ]; then
      echo "$PROGRESS" | jq '.' > "$PROGRESS_FILE"
    fi
    TO_PROCESS=$(echo "$TO_PROCESS" | xargs)
    if [ -n "$TO_PROCESS" ]; then
      IDS_JSON=$(printf '%s\n' $TO_PROCESS | jq -R . | jq -s .)
      ISSUES=$(echo "$ISSUES" | jq --argjson ids "$IDS_JSON" '. + [{type:"sessions_needing_summary", session_ids:$ids}]')
    fi
    # Clean up: remove sessions that are now fully done from in-progress
    if [ "$HATCH_HOOK_DRY_RUN" != "1" ]; then
      DONE_IDS=$(sqlite3 "$DB" "SELECT id FROM sessions WHERE archived = 0 AND session_summary IS NOT NULL;" 2>/dev/null || echo "")
      for id in $DONE_IDS; do
        PROGRESS=$(echo "$PROGRESS" | jq --arg id "$id" 'del(.[$id])')
      done
      echo "$PROGRESS" | jq '.' > "$PROGRESS_FILE"
    fi
  fi
fi

# ---- Check 3: artifact icon matches repo's icon.webp ----
# The runtime overwrites icon.webp on every build. If the snapshot's icon
# differs from the repo's, copy the repo's over directly.
find_code_space_dir() {
  for dir in "$ARTIFACTS_DIR"/*/; do
    [ -f "$dir/space.json" ] || continue
    if jq -e '.name == "Code Space"' "$dir/space.json" > /dev/null 2>&1; then
      echo "$dir"
      return 0
    fi
  done
  return 1
}

REPO_ICON="$HOME/workspace/github/dreveman/muse-code-space/icon.webp"
if SNAPSHOT_DIR=$(find_code_space_dir); then
  SNAPSHOT_ICON="${SNAPSHOT_DIR}icon.webp"
  if [ -f "$REPO_ICON" ] && [ -f "$SNAPSHOT_ICON" ]; then
    if ! cmp -s "$REPO_ICON" "$SNAPSHOT_ICON"; then
      if [ "$HATCH_HOOK_DRY_RUN" != "1" ]; then
        cp "$REPO_ICON" "$SNAPSHOT_ICON"
        log "icon-fixed" '{"reason":"snapshot icon differed from repo, replaced"}'
      else
        log "icon-would-fix" '{"reason":"snapshot icon differs from repo (dry run, not copied)"}'
      fi
    fi
  fi
fi

# ---- Decide ----
COUNT=$(echo "$ISSUES" | jq 'length')
if [ "$COUNT" -eq 0 ]; then
  silent "code-space-healthy" '{"reason":"No service, identity, inbox, or session-summary work is due."}'
else
  wake "code-space-needs-attention" "{\"issues\": $ISSUES}"
fi
