# Live testing Muse Code Space

How to test changes to this system the way we actually do it: directly
against the running services, then through the app. This doc is for the
agent doing the work (human or otherwise).

## The pieces

- **Pilot** — `~/workspace/muse-code-space-pilot/pilot.mjs`, a Node service on
  `127.0.0.1:18791`. Owns `muse serve` (the real agent runtime) over the
  official `@muse-code/sdk`. This is where sessions live and turns run.
- **App / Space** — this repo, built into the "Muse Code Space" sidebar
  artifact. Its worker actions (`server/src/actions.ts`) are the ONLY
  writers to the app DB. The app never talks to `muse` directly; it goes
  worker → pilot → `muse serve`.
- **Credential relay** — `~/workspace/muse-code-space-pilot/muse_relay.py`
  on the configured relay port (default `127.0.0.1:18790`). Source changes
  belong in this repo, not in the running copy.

Key invariant: the pilot is the agent runtime, the app DB is the mailbox.
Test the pilot directly first; test through the app second. Commands below
use default ports; substitute the configured project ports when overridden.

## Testing pilot changes

1. Edit `pilot/` in the repository and test it; never edit runtime files.
2. Deploy with `pilot/install.sh` as described in the install guide. Restart
   `muse-code-space-relay.service` before `muse-code-space-pilot.service` and
   verify the project's health endpoint. The pilot resumes registered
   sessions on restart.
3. Create a throwaway session (use a `manual-*` workspace name so it never
   collides with app sessions):
   ```bash
   SID=$(curl -s -X POST http://127.0.0.1:18791/sessions \
     -H 'content-type: application/json' \
     -d '{"title":"mytest","prompt":"reply with TEST-OK and nothing else","modelId":"muse-spark-1.3","reasoningEffort":"minimal","workspaceName":"manual-mytest-1"}' \
     | python3 -c "import sys,json;print(json.load(sys.stdin)['sessionId'])")
   echo $SID
   ```
4. Send a turn (this is the follow-up path — it should admit in milliseconds):
   ```bash
   curl -s -X POST http://127.0.0.1:18791/sessions/$SID/turns \
     -H 'content-type: application/json' \
     -d '{"text":"Run `echo hello` with the bash tool, then reply with ECHO-DONE","reasoningEffort":"minimal"}'
   # {"turnId":"...","admitMs":36,...}  <- admitMs is the handoff time
   ```
5. Watch it run:
   ```bash
   curl -s "http://127.0.0.1:18791/sessions/$SID/poll?since=0" | python3 -m json.tool | grep -E '"kind"|"status"|"text"|"type"'
   ```
   Healthy turn looks like: `toolCall inProgress` → `toolCall completed`
   → `agentMessage completed` → `turn_completed`.

What "normal" looks like, so you don't chase ghosts:

- `admitMs` in the tens of ms is the whole point of the architecture —
  the turn is accepted almost instantly; the model then streams.
- After the visible answer, the turn can stay open 10–60s while the CLI's
  `goal-reminder` plugin wraps up (you'll see `reminderChild` items). The
  UI spinner spins meanwhile. It always finishes — not stuck, just slow
  to settle. The pilot injects suppress flags to shorten it.
- `toolCall failed` right after `inProgress` with no output means the
  sandbox regressed — see "Do not break" below.

Raw event history lives on disk per session and survives restarts:
`~/workspace/muse-code-space-pilot/state/events-<sessionId>.jsonl`
(`at` = timestamp, `seq` = global order). The registry is
`~/workspace/muse-code-space-pilot/state/sessions.json`.

## Testing app (client/server) changes

App code in this repo goes live through the artifact builder
(`artifact.edit` → build → audit) — never by hand-building (`bun run
build` doesn't publish; don't touch `.space-build/`). After a build,
refresh the Space in the sidebar to see the change.

To verify end to end: open Muse Code Space, start a session, send a
message, and confirm the transcript streams and the status clears. To
inspect what the app recorded, use the `getsession` action on the session
id (the worker is the only DB writer, so this is the ground truth for
what the UI should show).

Keep this repo's working tree in sync with what was built — it is the git
source of truth. Commit it.

## The dogfood loop (changing the app from inside the app)

This is the point: develop Muse Code Space using Muse Code Space.

1. Open Muse Code Space, start a session, and prompt it with a small,
   concrete change, e.g.:
   > In `~/workspace/github/dreveman/muse-code-space/client/src`, find the
   > session-list empty state text and change it to "No sessions yet —
   > start one above." Show me the diff when done.
2. The agent edits the working tree with its bash/edit tools and reports
   the diff. Review it.
3. Publish via the artifact builder (`artifact.edit` with the same
   change), wait for the build, then refresh the Space and look at it.
4. `git commit` the working tree.

Good first changes: visible one-line UI text tweaks. They exercise the
whole loop (agent edit → build → refresh → verify) with almost no blast
radius. Save refactors for after the loop feels boring.

## When something looks wrong

- **Pilot not responding** — `curl -m 5 http://127.0.0.1:18791/health`.
  If down: inspect `muse-code-space-pilot.service` and its project watchdog.
  The UI's Debug menu also has wire and relay diagnostics.
- **Turn admitted but nothing streams** — check the session's
  `events-<id>.jsonl` tail. If events stop after `userMessage`, the
  `muse serve` child may have died; the pilot respawns it on next turn.
- **App shows stale status** — compare `getsession` output against the
  pilot's `poll`. If the pilot has `turn_completed` but the app says
  running, `syncpilotevents` hasn't run or failed — that's a worker issue,
  not a pilot issue. If a new agent says **Connecting…** and has no
  `pilot_session_id`, its original prompt is queued in the app DB. The UI
  runs `recoverPendingAgents` every 5 seconds; call that action manually
  to check recovery without the UI. If the pilot rejects it, the agent
  becomes Failed with the error and a Retry start button, never a permanent
  Starting spinner.
- **Model list looks wrong** — `curl http://127.0.0.1:18791/models`
  is the live catalog from `model/list`. The app's picker syncs from it.

## Do not break

- `muse serve` MUST be spawned with `--disable-sandbox`. The CLI's bwrap
  sandbox cannot mount /proc in this container; without the flag every
  bash tool call fails. (Sessions run `approvalMode: "allowAll"` under a
  standing --yolo authorization — this matches.)
- The pilot runs the latest Muse CLI (1.4.1, `~/.local/bin/muse-1.4.1`;
  override with `MUSE_CODE_SPACE_MUSE_BIN`). Keep `@muse-code/sdk` in
  `pilot/package.json` compatible with the CLI version when upgrading.
- Don't hand-write MSP JSON-RPC for production paths; go through the
  SDK's framed transport (`Connection.command`), like the pilot does for
  `session/setModel`.
- The artifact worker is the only app-DB writer. Nothing else writes to
  the app DB, ever.
