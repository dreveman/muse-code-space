# Code Space assistant synchronization job

Run one pass for the existing Code Space artifact using `artifact.invoke_action`.
Use the artifact identifier configured on this job. Keep the existing schedule
and durable job state; do not create a second job or change other automations.
The API uses agent/session; the UI calls these companions/tasks/conversations.
Read `hooks/README.md` for configuration and the durable acknowledgement protocol.
The hook wake payload supplies `issues` with `state_file` and `lease`. Process
identity and message work under those leases. If this is an existing periodic
job without a wake payload, first run the installed `code-space-watchdog-state.py
inspect` with the hook's same pilot URL, optional profile override, scope, and
state directory to claim due work. Do not process another worker's fresh lease.

## Synchronize the Muse assistant's complete identity

Check identity on **every worker invocation**, including wakes for messages,
service health, or missing summaries that contain no identity issue. The
poller can detect changes to the saved Code Space identity; it cannot read this
worker's live name or avatar. A live source change alone does not wake a silent
hook. Keep the existing cadence and single worker; do not add an identity cron.
Any identity failure leaves sync unacknowledged and must not prevent independent
message or session-summary work from being handled, in either identity mode.

### Default: use this worker's live assistant identity

1. Read **your own current assistant name and avatar** from the identity/avatar
   source available to you at runtime. You are the Muse assistant being synced,
   not a Code Space companion. Never substitute a companion roster image and
   never ask the user to provide identity values or maintain a profile file.
   If the avatar source is unavailable, preserve the saved avatar, report sync
   as incomplete, and continue independent message/summary work. Unavailable
   does not mean that the live identity has no avatar.
2. Call `getAssistantIdentity({})` and check `ok/error`. Preserve the saved
   `color`: there is no live source for your theme color. Prepare a complete
   payload with your current name, that saved color, and your actual avatar.
   Use a static PNG, JPEG, or WebP data URL, at most 512 pixels per side and
   256 KiB. Reuse the artwork; extract a representative still if animated and
   resize/encode consistently rather than generating a replacement image.
   A live identity that explicitly has no avatar uses `avatar_data_url: null`.
   Omitting the field is not a complete sync and does not remove an old avatar.
3. Compare the complete prepared payload with the saved `name`, `color`, and
   `avatar_data_url`. If an `assistant_identity_needs_sync` / `worker_source`
   issue already supplies a lease, use it for this pass. When there is no
   identity issue and your live identity differs, claim a lease with:

   ```sh
   python3 <hook-directory>/code-space-watchdog-state.py inspect \
     --pilot-url '<hook-pilot-url>' --scope '<artifact-slug>' \
     --state-file '<hook-state-file>' --worker-identity
   ```

   Use the installed hook's same state file (from its issue metadata, or the
   same configured state directory and scope). The explicit worker flag always
   creates a fresh identity lease, including when the saved identity matches
   the last acknowledgement. Do not use it for routine polls or when the live
   and saved identities match. After claiming, re-read your live identity and
   the saved identity before using that lease. If they now match, do nothing
   and let the claim expire. Do not acknowledge that unused claim.
4. For a normal identity issue, even an already matching saved identity needs
   acknowledgement when no verified sync is recorded. If a write is needed,
   call `setAssistantIdentity` with all three fields and check `ok/error`.
   Read back with `getAssistantIdentity` to confirm the full name/color/avatar.
   Store the exact complete payload in a private temporary JSON file, then run:

   ```sh
   python3 <hook-directory>/code-space-watchdog-state.py ack-identity \
     --state-file '<issue.state_file>' --lease '<issue.lease>' \
     --identity-file '<private-upload-payload.json>'
   ```

   Check its `ok/error` result and remove the temporary file. A stale lease or
   a saved/uploaded mismatch remains unacknowledged. State contains only
   fingerprints, never image bytes. Do not print base64 images in messages,
   logs, or summaries. If a concurrent poll replaces a lease, inspect again and
   use a current normal issue to verify/acknowledge the completed identity.

### Optional compatibility override: configured profile file

If the installed hook explicitly supplies `MUSE_CODE_SPACE_ASSISTANT_PROFILE`,
keep the existing profile mode: its authoritative JSON provides name, color,
and avatar (including explicit null removal), and its changes trigger sync.
The file must remain readable and current. Use the same image preparation,
complete upload, readback, private-payload acknowledgement, and error handling
as above. The helper re-reads that file during acknowledgement and rejects a
changed source. A missing/unreadable configured file is an error, not permission
to fall back to worker mode or clear the avatar. Do not create or request this
file for a normal installation. Never combine `--worker-identity` with
`--profile-file`.

## Read messages addressed to Muse

1. For `muse_messages_pending`, call `readMuseMessages({since: issue.since})`.
   If `ok` is false, leave the lease/cursor unacknowledged for retry.
2. Handle messages in sequence according to the user's existing instructions,
   only through `issue.latest` for this lease. Later arrivals belong to the next
   batch. If expected messages are missing, report it; do not skip them by
   advancing to `latest` merely because a read returned.
3. After each handled message, run:
   `python3 <hook-directory>/code-space-watchdog-state.py ack-messages
   --state-file <issue.state_file> --lease <issue.lease> --through <message.seq>`.
   Check its `ok/error` response. This persists partial progress, completes the
   lease at the observed batch boundary, and leaves later messages for the next
   poll. Do not hand-edit the cursor or acknowledge unhandled messages.
4. If those instructions call for a reply, use `sendAgentMessage({to, text})`
   with an agent **name** from `listAgents({})`, not an app session ID. Check
   `ok/error`; this action sends as Muse. Agents use their own session-scoped MCP
   tools. Do not send any test messages merely to verify this job's configuration.
5. A message from **Code Space** (GitHub setup in the repo picker) asking you
   to set up the GitHub broker: first start the Secure Vault flow with the
   user in your own surface — a fine-grained GitHub PAT, Contents + Pull
   requests read/write, selected repositories only, stored as a custom API
   credential named exactly `custom.github-broker`. Then finish the broker
   setup on the host: write
   `~/.config/muse-code-space-pilot/github-broker.json` (chmod 600)
   containing `{"mode": "surrogate", "credential_name":
   "custom.github-broker"}` (the config holds no secret), restart the
   broker with `systemctl restart muse-code-space-github-broker.service`
   (sudo if needed), and verify
   `https://127.0.0.1:443/__code_space/health` answers `ok: true`. Only then
   tell the user the broker is working. The setup dialog polls broker status
   itself; do not acknowledge the message until the broker is verified, and
   report the exact failing step instead of acknowledging if the Vault
   addition, config write, restart, or health check cannot be completed.

## Supply missing session summaries

1. Call `listSessions({limit: 100})`. For each unarchived session whose
   `session_summary` is null or blank, read `getSession({id, event_limit: 1000})`.
2. Write a concise sentence describing the requested work and actual progress,
   grounded in that session's prompt/transcript. Keep it within 240 characters;
   do not use a status such as "Thinking" as the summary.
3. Call `setSessionSummary({id: session.id, summary})` and check `ok/error`.
   Use the app session ID, not the agent's name or pilot session ID. Before
   writing, re-read the session and skip it if another worker/user has already
   supplied a summary. Existing nonempty summaries are not rewritten every pass:
   manual edits and Muse updates share this same field and the latest write wins.
4. `session_summary` is the only session label. Never write `task_title`,
   `agent_summary`, or the separate run-result `summary`. A missing summary is
   normal until there is enough context to describe the work.

Read and update session data through the artifact actions. Background reads
must not call `markAgentSeen`, advance the user's unread markers, append fake
transcript events, or change turn status just to maintain metadata.

## Fixed agent roster

Names, model/effort, SOUL, ratings, and animations are authored in the fixed
roster. There is no per-session icon generation/assignment step. The following
actions have been removed and must not be called: `setAgentSummary`,
`renameSession`, `setAgentPreferences`, `setAgentIcons`, `getAgentIcons`, and
`assignCompanion`. If a separately authorized handoff is needed, the current
entry point is `assignAgent({id, agent_id})`; model/effort overrides are rejected
by session creation and message APIs.

Report failures and incomplete identity/avatar synchronization explicitly.
Do not mark an avatar upload, message batch, or summary update successful solely
because the action transport returned without throwing.

## Restore the Code Space services after a host wipe

A host replacement can wipe /etc while everything under the home directory
survives, deleting the systemd units and stopping the pilot, relay, and
GitHub broker. When the wake reports missing units or an unhealthy pilot:

1. Verify the outage is real before touching anything: the units are
   genuinely absent from /etc/systemd/system AND the pilot health endpoint
   (http://127.0.0.1:18791/health) is unreachable. A missing-unit report can
   also fire transiently right after a reboot — if the units are already
   installed, enabled, active, and health returns ok:true, do not restart
   anything; a restart drops live sessions for no benefit.
2. Restore from the pre-generated unit files in the pilot runtime directory
   (~/workspace/muse-code-space-pilot/ on a standard install): copy
   muse-code-space-pilot.service, muse-code-space-relay.service,
   muse-code-space-github-broker.service, muse-code-space-watchdog.service,
   and muse-code-space-watchdog.timer into /etc/systemd/system/, run
   systemctl daemon-reload, enable all units, restart the relay, then the
   GitHub broker, then the pilot, and start the watchdog timer.
3. Require the health gate before continuing the pass: GET /health returns
   ok:true with the relay and GitHub broker up.
4. Never read or run pilot/install.sh or the install guide during a watchdog
   restore, and never run a full install: the installer re-pins and downloads
   the Muse binary and rewrites credentials, none of which a service restore
   needs — the pre-generated unit files are sufficient. Where the image has
   no crontab binary, the */2 watchdog cron cannot be installed;
   Restart=always in the units plus the systemd watchdog timer is the
   coverage, not a failure.
