# Install and operate Muse Code Space (Muse assistant guide)

This guide is for **you, the user's Muse assistant**, not for a coding agent
inside Code Space. Read `AGENTS.md`, `docs/PILOT.md` and this guide before doing
anything destructive. Keep the app, pilot and credential relay as **separate
components**. On this platform the app is a Hatch TypeScript web artifact;
cloning a repository does not install or publish that artifact by itself.

## First: provision credentials in Secure Vault (required gate)

Do this **before** every other step in this guide — before cleanup, before
`install.sh`, before publishing the app. An install can complete every
mechanical step and still be useless because a credential is missing: the
relay authenticates every model request through the user's Secure Vault
credential, so without it every agent turn fails with an auth error that
only surfaces after the install looks done. Collect and verify the
credentials up front, while the fix is still "ask the user," not "debug a
finished install."

**Never ask the user to paste a secret in chat.** Every credential below is
stored through the platform's Secure Vault flow (the secure entry card /
API-access flow), which the assistant never sees the value of. Secure Vault
has **no read-back**: no tool can retrieve a stored value, so each
credential must be verified by *issuance*, not inspection — request a
surrogate for the entry and confirm the credential service issues one.

1. **Meta Model API credential — critical, gates the install.** The user
   must have a custom Secure Vault API credential named
   `custom.meta-model-api` holding their Meta Model API key. If it is not
   already stored, walk the user through storing it now via the Secure
   Vault API-access flow. Then verify: a surrogate (`hsurr:*`) can be
   issued for `custom.meta-model-api`. **If the credential is missing or
   cannot be issued, stop here and report that.** Do not run the installer
   and do not publish the app; there is no partial install worth having
   without it. (The `## Credentials` section under Step 1 explains how the
   relay consumes this credential, including the sentinel `auth.json` —
   that mechanism is why no real key ever lands on the pilot host.)
2. **GitHub broker credential — optional, ask once, now.** Ask the user
   whether Code Space sessions should have GitHub access. If yes, have
   them create a fine-grained GitHub PAT (Contents + Pull requests
   read/write, **selected repositories only**) and store it through Secure
   Vault as a custom API credential named `custom.github-broker`, then
   verify a surrogate can be issued for it the same way. If they decline,
   note the choice and proceed — the broker stays up and reports a clear
   credential error until one is provisioned, and this step can be done
   later without reinstalling. If the user instead plans GitHub **App**
   mode (full git transport), tell them to have the App ID, installation
   ID, and private key ready for the post-install setup dialog: the App
   private key is **not** stored in Secure Vault (it cannot be — the pilot
   must hold the real key to mint tokens, and the vault has no read-back);
   it is entered in the app's GitHub setup dialog and held in a host-local
   600 file written by the pilot, as described in `## Credentials` below.

Record which credentials verified before moving on, and say so in your
first progress report. This gate is also reproduced verbatim in
`docs/INSTALL_PROMPT.md`, the copy-paste prompt that starts an install, so
the requirement reaches the installing assistant even when the guide itself
is only skimmed.

## 0. Confirm prerequisites and clean up the unreleased test install

1. Confirm you have access to the web-artifact builder interface and its
   current **artifacts skill/instructions**. Those are authoritative for the
   exact plan → build → audit → submit procedure. If unavailable, stop and
   report that the app cannot be published from this environment. Do not use
   `bun run build`, hand-edit `.space-build/`, or claim a local build deployed.
2. Confirm the pilot host has Node, Python 3, systemd (for automatic startup),
   the required Muse CLI/SDK and `sessionMcp` capability, and its credential relay
   setup. See `docs/PILOT.md`. **Check the
   capability grant**, not just a version number. If a binary cannot grant
   required per-session MCP, do not start Code Space agents with it: they
   would have no agent-to-agent messaging.
3. This is a clean break from the unreleased test installation: do **not**
   migrate its pilot registry, transcripts, config or test sessions. Remove
   test sessions through app actions or supported artifact data operations,
   never by running sqlite or scripts against managed `app.db`. Remove only
   their identified workspaces; never wipe the shared `~/workspace/code/`
   parent. After the clean cutover, treat new session state as durable.
4. The repository is `https://github.com/dreveman/muse-code-space.git`.
   On the builder host, clone it directly into the artifact source location:

   ```bash
   mkdir -p ~/workspace/github/dreveman
   git clone https://github.com/dreveman/muse-code-space.git \
     ~/workspace/github/dreveman/muse-code-space
   ```

   If the checkout already exists, do not clone over it: inspect its remote
   and working tree, then use the artifact's edit workflow to update it
   without discarding local work. Check tracked files for credentials and
   runtime data before publication. If the pilot runs on a different host,
   clone the same repository there as well; the pilot installer uses that
   host's checkout.

### Retire the old generic services first

If `muse-pilot.service`, `muse-relay.service`, an old watchdog cron entry,
`~/workspace/muse-pilot/`, or `~/.config/muse-pilot/` exist, **verify that
these belong to this Code Space test deployment**. Inspect the old units'
`ExecStart`/`WorkingDirectory` and the cron command. If they point elsewhere,
stop and ask rather than touching someone else's Muse services. Otherwise
stop and disable the old watchdog and units, remove only those verified old
unit files/runtime/config, and reload systemd. No old state is copied. The
new installer refuses occupied ports, so finish this cleanup before it runs.

## 1. Install or update the pilot (on the pilot VM)

Pilot source comes from this repository's `pilot/` directory; runtime code
and state are under `~/workspace/muse-code-space-pilot/`. Never edit runtime
copies directly. On a shared pilot/builder host, use the checkout at
`~/workspace/github/dreveman/muse-code-space`. On separate hosts, use the pilot
host's clone of the same repository. The pilot's isolated Muse config and
credentials belong under `~/.config/muse-code-space-pilot/muse/`.

## Credentials

You should already have completed the **credentials gate** at the top of
this guide (Secure Vault entries stored and verified by issuance) before
reaching this section; what follows is the reference for how each
credential is consumed.

The standard install does **not** need a real CLI credential in `auth.json`.
The pilot writes a sentinel placeholder that satisfies the CLI's startup
check; real API authentication happens in the relay, which injects the
`custom.meta-model-api` credential via surrogate on every request to
`api.meta.ai`.

### Sentinel auth.json (standard install)

`pilot/install.sh` writes a sentinel placeholder automatically:

```json
{"schema_version": 1, "providers": {"meta": {"api_key": "relay-provided-sentinel"}}}
```

The CLI sends this sentinel to the relay, the relay strips it and substitutes
a fresh surrogate for `custom.meta-model-api`, and `api.meta.ai` accepts the
request. The user must have connected `custom.meta-model-api` through Secure
Vault (the relay cannot authenticate without it). If turns fail with auth
errors, the `custom.meta-model-api` credential is missing, expired, or
revoked — have the user reconnect it via Secure Vault.

Never commit `auth.json` to the repo, copy it between hosts, or include it
in snapshots. It is host-local, not source.

### GitHub broker credential

Code Space sessions get GitHub access through the loopback broker
(`pilot/github_broker.py`, port 443); sessions only ever hold a sentinel.
On this platform **Secure Vault has no read-back** — no tool can retrieve a
stored secret value — so the vault cannot supply the contents of a
credential file. The platform-native pattern is the same one the muse relay
uses: a custom credential entry plus per-request surrogates.

1. **Surrogate via custom entry (platform-native, preferred):** have the
   user create a fine-grained GitHub PAT (Contents + Pull requests
   read/write, **selected repositories only**) and store it through Secure
   Vault as a custom API credential entry named `custom.github-broker`.
   The credential service then issues `hsurr:*` surrogates for that entry.
   Write the host-local broker config (it contains no secret):
   `~/.config/muse-code-space-pilot/github-broker.json` (chmod 600) with
   `{"mode": "surrogate", "credential_name": "custom.github-broker"}`,
   then restart `muse-code-space-github-broker.service`. The broker
   attaches fresh surrogates as Bearer. **Scope limit (verified live):**
   surrogate mode covers the `gh`/API surface only — GitHub requires
   Basic-with-token-password for git transport and rejects Bearer there,
   while surrogates can only travel as Bearer, so `git clone/pull/push`
   in surrogate mode fails with an explicit broker message. Full git
   access needs App or PAT file mode below (broker holds a real token).
2. **GitHub App (full git + gh, recommended for landing code):** run
   `~/workspace/muse-code-space-pilot/setup-github-broker` in a Code Space
   terminal. It prompts for the App ID and installation ID, reads the App
   private key with terminal echo off (never paste the key to any agent in
   chat; Secure Vault cannot be the source for this file), validates the
   trio against GitHub, writes `github-broker.json` + the key (both 600),
   restarts the broker, and verifies it. PAT file mode
   (`{"mode": "pat", "token": …}` in the same JSON) works the same way for
   operators who write the file securely out of band.

`install.sh` never creates or overwrites this file; it only reports whether
one is present. Without it the broker stays up and session git/gh calls fail
with a clear `github broker credential error` until one is provisioned.
The broker reads the file at startup; restart the broker service after
provisioning or changing it.

The VM installer requires the Muse binary path chosen for this host. Before
running it, check the selected binary against the installed SDK and verify its
`sessionMcp` handshake grant. Choose the correct credentials and egress proxy
for this host.

**Run the installer as the ordinary pilot account**, so its rendered systemd
units use the correct `User=` and `HOME=`. Use its two-stage deployment if unit
installation needs root:

```bash
cd ~/workspace/github/dreveman/muse-code-space  # or its pilot-host clone
export MUSE_CODE_SPACE_RELAY_PORT=18790 MUSE_CODE_SPACE_PILOT_PORT=18791
# Optional: pin a specific verified muse binary. If unset, install.sh downloads
# the launcher from https://api.meta.ai/muse-launcher.sh, fetches the latest CLI,
# and pins a copy at ~/.local/bin/muse-pilot.
# export MUSE_CODE_SPACE_MUSE_BIN=/absolute/path/to/verified/muse
./pilot/install.sh --no-enable --no-cron
# Inspect the generated units for the expected User, HOME and Muse binary.
sudo install -m 0644 \
  ~/workspace/muse-code-space-pilot/muse-code-space-relay.service \
  /etc/systemd/system/muse-code-space-relay.service
sudo install -m 0644 \
  ~/workspace/muse-code-space-pilot/muse-code-space-pilot.service \
  /etc/systemd/system/muse-code-space-pilot.service
sudo systemctl daemon-reload
sudo systemctl enable muse-code-space-relay.service muse-code-space-pilot.service
sudo systemctl restart muse-code-space-relay.service
sudo systemctl restart muse-code-space-pilot.service
# As the ordinary pilot account, install the project-specific watchdog cron:
./pilot/install.sh --no-enable
```

`install.sh` checks port ownership before deploying and copies **all**
runtime source modules, including `files.mjs`, without touching new `state/`.
It sets up the pilot's Muse settings and writes a proxy environment file
without putting credentials in Git. If the
host has no systemd, follow `docs/PILOT.md` for a single supervised pilot and
relay; do not start two pilots on one port. If ports `18790`/`18791` are
occupied by other services, choose free values with the project's
`MUSE_CODE_SPACE_RELAY_PORT` / `MUSE_CODE_SPACE_PILOT_PORT` settings. Note:
the app's server defaults `MUSE_CODE_SPACE_PILOT_URL` to
`http://127.0.0.1:18791`; there is currently no API mechanism to override
it on a hosted artifact, so non-standard pilot ports are not supported.
On a host without
the VM relay (for example a local Mac), run the pilot from a normal terminal
with `MUSE_CODE_SPACE_RELAY_URL=none` instead of installing VM units.

Verify both services and the pilot's startup reconciliation before continuing:

```bash
systemctl status muse-code-space-relay.service muse-code-space-pilot.service \
  --no-pager
curl -fsS "http://127.0.0.1:${MUSE_CODE_SPACE_PILOT_PORT:-18791}/health"
```

`/health` must report `ok:true`, no unrecovered sessions, and the expected
relay state. On failure inspect the unit journals and
`~/workspace/muse-code-space-pilot/{pilot,relay}.log`; do not delete the
new state or bypass the required MCP server. Restarts preserve each visible
session id and its transcript (see `docs/PILOT.md`, Restart recovery).

## 2. Install or update the web artifact (builder host)

The artifact's catalog slug is a **deploy-time variable**: the platform
generates it when the artifact is created, and the `create` API accepts no
slug parameter. The builder adopts source from
`~/workspace/ts-spaces/<slug>/` — the directory name must match the
artifact's slug.

The git checkout lives at `~/workspace/github/dreveman/muse-code-space`
and is never modified by installation. For the web artifact, the installer
stages a **snapshot** of the checkout at the slug-matched path. The repo
carries `space.json.template` (with a `__ARTIFACT_SLUG__` placeholder);
the installer generates the real `space.json` in the snapshot (not in the
git checkout).

When the pilot VM is a different host, use a checkout of the same
repository there for `pilot/install.sh`; never transfer pilot state,
`auth.json`, `.dev/app.db`, or other local data between hosts.

1. Check if a snapshot already exists at `~/workspace/ts-spaces/<slug>/`
   with a generated `space.json` whose slug matches an artifact in the
   catalog. If so, use the edit workflow with that slug to update it from
   a fresh snapshot (re-copy from the git checkout first). Do not
   delete/recreate an existing artifact just to update it.
   **Before staging any update, record the current data counts** through
   the artifact's own actions/inspect views (never sqlite against
   `app.db`): the `listSessions` total (Active + Past) and the
   `listProjects` count. Write both numbers down; step 5 compares against
   them, and a drop means the update failed (see below).
2. If no snapshot exists (first install, or the old artifact was deleted):
   a. Create a **fullstack TypeScript web Space** with display name
      "Code Space". The platform will generate the slug; **capture it from
      the create response**. `icon_subject` is required by the API — pass a
      short factual description (e.g. "A private app for supervising headless
      coding-agent sessions."). The platform will generate an icon from it,
      which you will replace with the repo's `icon.webp` after the final
      build (see step 5).
   b. Stage a snapshot of the web artifact source at the slug-matched path
      and generate `space.json`. Only the files the web build needs —
      not `docs/` (human documentation) or `pilot/` (backend installed
      separately via `pilot/install.sh`). Use the repo's staging script:
      ```bash
      ~/workspace/github/dreveman/muse-code-space/web/stage-snapshot.sh <generated-slug>
      ```
      The script clears the bootstrap files the artifact system created
      (retrying once if the system is still writing), extracts a git archive
      of the web-build files, and generates `space.json` from the template.
      On updates it first backs up the existing `app.db` (SQLite online
      backup, WAL-safe) to `~/workspace/ts-spaces/.data-backups/` and
      restores it into the fresh snapshot, printing both lines
      (`backed up existing app database to …`, `restored app database
      from …`). **Verify both lines appear in its output.** If the
      database exists but cannot be backed up, the script aborts before
      clearing anything — resolve that failure; never work around it by
      clearing the directory manually. Keep the printed backup path with
      your step-1 counts for the step-5 comparison and any rollback.
      Note: `icon.webp` is intentionally excluded from the snapshot. The
      runtime owns the icon file on builder-created artifacts and restores
      its own generated icon before and after each build, deleting any
      `icon.*` you stage. The repo's icon is copied in after the final
      build (step 6).
      The git checkout at `~/workspace/github/dreveman/muse-code-space`
      is untouched; verify with `git status` there.
   c. Now use the edit workflow with the generated slug to build from the
      snapshot: the snapshot directory name, the generated `space.json`
      slug, and the catalog slug all match, so the builder will adopt the
      source.
3. Follow the current artifacts skill's **plan → build → audit → submit** flow.
   It is the only publishing path. Apply all pending `drizzle/` migrations
   while preserving the managed DB across edits. Never touch `.space-build/`
   manually. `bun run typecheck`, Node tests and `bun run test:restart` verify
   source locally but do not publish.
4. The app's server defaults `MUSE_CODE_SPACE_PILOT_URL` to
   `http://127.0.0.1:18791`, which matches the standard pilot install. Never
   publish auth tokens, runtime state or public pilot routes. The browser
   talks to app actions, not directly to the pilot.
5. After audit/submit confirms success, reload the Space; verify `listModels`,
   creation of a disposable agent, a completed turn, continuation, a terminal,
   `list_agents` / `send_message`, transcript persistence across restart, and
   an agent-written file opened in its tab. Do not interpret an absent old
   app DB as an instruction to import or delete pilot orphans automatically.
   **Then compare the data counts against step 1:** `listSessions` total
   and `listProjects` count must be at least what you recorded (they may
   legitimately grow while you worked). Any drop means the update lost
   data — treat the update as failed even if every health check is green
   (they exercise the pilot, whose state lives elsewhere): copy the
   backup printed by `stage-snapshot.sh` over the snapshot's `app.db`
   (whole-file restore only, never row edits), rebuild through the edit
   workflow, reload, and compare again before reporting success.
6. The watchdog hook (step 3 in "Code Space watchdog hook" below) automatically
   keeps the artifact's icon in sync with the repo's `icon.webp`. The sidebar
   icon comes from `~/workspace/ts-spaces/<slug>/icon.webp` (checked by
   content, max 8 MiB; WebP/PNG draw uncropped, JPEG crops to a circle). The
   runtime owns this file on builder-created artifacts and restores its
   generated copy before/after each build — the watchdog detects the mismatch
   within 15 seconds and copies the repo's icon over. Reload the app to see
   it (the daemon doesn't watch `ts-spaces/` for changes).

If an artifact action or build fails, report the exact step and retain all
state. Do not say "published" until the builder confirms a successful submit.

## 3. Operate the user's Muse assistant alongside Code Space agents

The user's Muse assistant is **not** a Code Space agent. The watchdog worker
reads its own live assistant name and avatar, preserves the color already saved
on the pilot, and synchronizes the complete identity through
`setAssistantIdentity({name, color, avatar_data_url})`, then use artifact actions
`listAgents`, `sendAgentMessage` and `readMuseMessages` (with the returned
`latest` sequence as the next `since`). Do not impersonate an agent or send
through a shell fallback; Code Space agents use their required
`mcp__code_space__send_message` tool. `Muse` and `Jolly` are reserved routing
aliases for the assistant. Names shown in the UI may be capitalized without
changing their canonical routing values.

### Session summaries and assistant avatar

The API uses **agent/session**; companion/task/conversation are UI terms.
Use the exact action names with `artifact.invoke_action`:

- `listSessions({limit?})` and `getSession({id, event_limit?})` discover
  sessions and read the conversation. `title` is the assigned agent's name.
- `setSessionSummary({id, summary})` sets the session's single short label
  (up to 240 characters after whitespace normalization), grounded in the
  transcript. `null` or blank clears it. The UI's Rename task edits this same
  field, so a later Muse update replaces a manual edit and vice versa.
  Reads return `session_summary`; without one the UI uses the initial prompt.
  This does not change activity, turn status, or unread markers. The legacy
  run-result `summary` is separate.
- `assignAgent({id, agent_id})` assigns an available fixed-roster agent to an
  idle session while keeping its history, summary, workspace, and project.
- `createSession({session_id, title?, prompt, workspaceRoot, project_id?})`
  starts a fixed-roster agent by canonical name (`title`); omission chooses
  the first free agent. The server applies model/effort. `continueSession`
  and `sendInput` also use the assigned configuration, without overrides.
- `listAgents()` is the messaging directory. `sendAgentMessage({to, text})`
  addresses an agent by **name**, not the app session ID. Read replies with
  `readMuseMessages({since})` and use its returned `latest` for the next read.
- `getAssistantIdentity()` returns `name`, `color`, nullable
  `avatar_data_url`, and nullable `user_name` alongside `ok/error`.
  `setAssistantIdentity({name?, color?, avatar_data_url?, user_name?})`
  configures Muse's own identity and the user's name. Omission keeps
  the current values; `null` clears the avatar or the user name. The
  assistant provides `user_name` (the user's own name) through this same
  call when it knows it; until then it reads back as `null`. Supply a static PNG/JPEG/WebP data
  URL, no larger than 256 KiB or 512px per side. It persists with the pilot's
  identity, and incoming Muse messages show it beside the text. The Muse
  logo is the fallback. Do not copy image bytes into messages or summaries.

Agent names, model/effort, SOUL, ratings and animations come from the fixed
roster. Do not generate or assign per-session artwork. The former
`setAgentSummary`, `renameSession`, `setAgentPreferences`, `setAgentIcons`,
`getAgentIcons`, and `assignCompanion` actions have been removed.

**Existing scheduled assistant job.** Update the existing job's instructions
so each run reads `<repo>/hooks/code-space-assistant-job.md` and performs one pass
for its configured artifact. Preserve its current schedule and inbox cursor.
That prompt requires all three duties: complete identity sync **including the
avatar**, inbox processing with `readMuseMessages`, and missing summaries with
`setSessionSummary`. The worker checks its own live identity on every invocation,
even when it woke for messages or summaries with no identity issue. Setting only
the assistant name/color is not a complete sync when its live identity has an
avatar. An unavailable image must be reported as incomplete while preserving
the current avatar.

Inspect the actual saved job prompt in Muse after updating it; changing this
repository does not update an already registered cron job or hook. Do not
create a duplicate job. During configuration verification, check identity
readback and action compatibility without sending messages or overwriting
existing summaries.

**Code Space watchdog hook.** Copy `<repo>/hooks/code-space-watchdog.sh` and
`<repo>/hooks/code-space-watchdog-state.py` together to `~/hooks/scripts/`, make
the shell script executable, and update the existing `hooks.add` hook
with ID `code-space-watchdog` and `poll_interval_secs: 15`. The worker handles
infrastructure health issues and `sessions_needing_summary` by reading each
session through `getSession` and setting a concise `setSessionSummary`.
Use the shared job prompt for that worker too. The shell hook now checks
saved identity drift and incoming messages through read-only pilot routes,
independently of summary discovery. Set `MUSE_CODE_SPACE_ARTIFACT_SLUG` to this
artifact's slug. No profile JSON file is required: the worker is the default
identity source and must never ask the user to supply or maintain one. Existing
installs can retain `MUSE_CODE_SPACE_ASSISTANT_PROFILE` as an optional override;
when configured, its original file-based behavior remains unchanged. The modes,
configuration, and worker acknowledgement commands are in `<repo>/hooks/README.md`.
The poller cannot see live worker-side changes while idle. A worker that finds
live drift during other work can claim a lease with `inspect --worker-identity`,
then re-confirm drift before using it. The shell poller never passes that flag.
An unavailable avatar source stays incomplete without blocking other work;
an explicitly absent live avatar is synchronized as `avatar_data_url: null`.
Only the worker advances handled-message cursors or acknowledges complete
name/color/avatar synchronization. There is no per-agent icon assignment work.
Keep one inbox consumer; do not add a second cron job for these new checks.
Test with `hooks.dry_run`, then
`hooks.enable`. An absent summary is normal; no summary is generated by the
app itself. Keep all metadata writes in artifact actions.

### Day-to-day verification and recovery

- In Code Space, use the hamburger menu's **Debug → Show relay log** to see
  safe model-connection statuses, duration and failure stage without shell
  access. If it shows a proxy, credential or upstream error, investigate
  that stage; neither a reachable relay nor `/health` proves a model call
  succeeds. You can also check `GET /health`, systemd and logs if you have
  VM access. A new agent showing **Connecting…** retains its first prompt;
  do not create duplicates to work around it.
- New agent workspaces default to `~/workspace/code/<12-hex-token>`, separate
  from the Hatch artifact's `~/workspace/ts-spaces/` source. Existing agents
  keep their saved paths; custom workspaces remain allowed.
- Existing agent workspaces and transcripts persist across pilot/app restart.
  Never wipe `~/workspace/muse-code-space-pilot/state`, `.dev/`, or the
  artifact DB to "fix" a blank list. Distinguish a fresh app DB from missing
  pilot state.
- Archived sessions remain in Past and can be restored; deletion is explicit
  and permanent. Do not automatically delete old sessions or orphan state.
- Use app actions for metadata and messages; install new pilot source with
  `pilot/install.sh` and publish app changes via the builder separately.
- If an image is rejected, inspect its format, dimensions, static format and byte size; retry only the metadata action, not the
  agent's turn.
