# Code Space watchdog

`code-space-watchdog.sh` polls service health, the Muse assistant identity,
messages addressed to Muse, missing session summaries, and the artifact icon.
It wakes the existing Muse worker only when work is due. Identity and inbox
checks use read-only pilot HTTP endpoints and work even if no artifact DB has
been discovered. Writes to Code Space remain in the worker's artifact actions.

Copy **both** the shell hook and `code-space-watchdog-state.py` into the hook
scripts directory. The helper uses Python 3's standard library, already required
by this project's pilot; no new packages are needed. Update the existing hook's
worker prompt to read `code-space-assistant-job.md`. Keep its existing cadence;
do not register a duplicate hook or inbox-processing job.

## Configuration

Configure these on the existing hook invocation:

| Variable | Meaning |
| --- | --- |
| `MUSE_CODE_SPACE_PILOT_URL` | Pilot URL; defaults to `http://127.0.0.1:18791`. |
| `MUSE_CODE_SPACE_ASSISTANT_PROFILE` | Optional authoritative profile JSON override. Leave unset for worker-sourced identity; no user-maintained file is required. |
| `MUSE_CODE_SPACE_ARTIFACT_SLUG` | Artifact scope for cursor/state isolation; defaults to `code-space`. Set the actual artifact slug when installing. |
| `MUSE_CODE_SPACE_WATCHDOG_STATE_DIR` | State directory; defaults to `~/hooks/state/code-space-watchdog`. Separate files are derived from pilot URL and artifact scope. |
| `MUSE_CODE_SPACE_ARTIFACTS_DIR` | Artifact discovery root; defaults to `~/workspace/ts-spaces`. |

### Default identity source: the Muse worker

No profile file is needed. The worker reads its own current assistant name and
avatar from its runtime source and preserves the theme color already saved on
the pilot. It never asks the user to supply identity values or uses a companion
roster image. A live identity with no avatar explicitly clears the saved avatar;
an unavailable source leaves it intact and keeps sync incomplete.

The poller checks only `GET /assistant`: it wakes a worker if no acknowledged
identity exists or that saved identity changes. After acknowledgement it stays
silent while the saved fingerprint matches. It cannot detect changes to the
worker's live name/avatar while idle. The worker checks its live identity on
every invocation, including wakes for other work, and uses the claim flag below
only when it finds drift. Do not add another scheduled job for identity.

### Optional profile-file override

Existing installations may continue to set `MUSE_CODE_SPACE_ASSISTANT_PROFILE`.
In that mode the profile supplies name, color, and avatar, exactly as before.
Keep the source current through the real profile provider or its adapter; a
one-time snapshot cannot detect later source changes. A configured but missing
or unreadable file remains an error. Do not ask a user to create this file as a
prerequisite for normal installation.

Example source file (the image path is relative to the profile file):

```json
{
  "name": "Jolly",
  "color": "#d0e4fc",
  "avatar_path": "avatar.webp",
  "revision": "profile-version-7"
}
```

Supply exactly one of `avatar_path` or `avatar_data_url`. The source image may
be animated or larger than the target limit; the worker prepares a static,
bounded avatar for `setAssistantIdentity`. The source is limited to 8 MiB.
Use an explicit `null` avatar field for a profile that deliberately has no image.
Omitting both avatar fields is incomplete configuration. The optional `revision`
also triggers synchronization when changed; image content changes are detected
even when its path is unchanged.

## Worker protocol

The wake payload contains `issues`. Relevant issues are:

- `assistant_identity_needs_sync`: `worker_source` in default mode when saved
  identity drifted or no acknowledged sync exists. Profile mode also reports
  profile changes. Source/identity read failures remain actionable errors.
- `muse_messages_pending`: includes `since`, `latest`, and `count`; no message
  bodies are copied into the wake payload.
- `muse_messages_check_failed`: the inbox could not be checked. This is not
  treated as an empty inbox and does not move the cursor.

Each work item includes `state_file` and a `lease` token. Fresh leases suppress
duplicate workers for ten minutes; expired work is retried. A changed saved
identity promptly replaces a worker-mode lease; a changed profile source replaces
a profile-mode lease. State writes and acknowledgements are locked
and atomic. A dry run does not create state or change leases/cursors.

In worker mode, pending identity state contains `mode: "worker"`, without a
profile path or source fingerprint. Normal `inspect` calls throttle an unchanged
unacknowledged saved identity for ten minutes. A change to the saved identity
changes the signature and immediately reissues the lease. State remains version
`1`; existing profile-mode state and acknowledgements stay compatible.

A worker that wakes for other work, finds its own live identity differs from
`getAssistantIdentity`, and has no identity lease can explicitly claim one:

```sh
python3 <hook-directory>/code-space-watchdog-state.py inspect \
  --pilot-url '<hook-pilot-url>' --scope '<artifact-slug>' \
  --state-file '<hook-state-file>' --worker-identity
```

`--worker-identity` always emits a fresh `worker_source` lease under the state
lock, even if the saved identity matches the last acknowledgement. Only the
worker uses it; the shell poller never does. It is invalid with `--profile-file`.
Re-confirm live drift after claiming; if identities match, leave that claim
unused and let it expire. Ordinary polls clear stale identity work when the
saved fingerprint matches the acknowledgement.

After successfully setting **name, color, and avatar**, or verifying a matching
identity for a normal due issue, save the complete exact payload in a private
temporary JSON file and acknowledge it:

```sh
python3 <hook-directory>/code-space-watchdog-state.py ack-identity \
  --state-file '<issue.state_file>' --lease '<issue.lease>' \
  --identity-file '<private-upload-payload.json>'
```

Both modes require the pilot's saved name/color/avatar to match that payload.
Worker mode hashes the decoded uploaded avatar bytes (or explicit null), with
`revision: null`, for its source fingerprint. Profile mode re-reads and verifies
the configured source as before. Missing avatar fields, partial uploads,
profile changes, and stale leases cannot be marked successful. Remove the
private payload after acknowledgement; no image bytes are stored in state.
An unavailable runtime avatar source leaves synchronization incomplete without
blocking messages or summaries. See `code-space-assistant-job.md` for the full
worker protocol and avatar size/format requirements.

For an inbox issue, call `readMuseMessages({since: issue.since})`. Handle only
messages through `issue.latest` for that lease. After each successful message:

```sh
python3 <hook-directory>/code-space-watchdog-state.py ack-messages \
  --state-file '<issue.state_file>' --lease '<issue.lease>' \
  --through '<successfully-handled-message.seq>'
```

Reading/detecting a message never advances the handled cursor. Partial progress
survives restarts. New arrivals wait for the next batch; acknowledgements cannot
exceed the observed batch, move backwards, or use a replaced lease. Retrying the
same completed acknowledgement is harmless. Leave failures unacknowledged so
they retry. Use the helper to update state instead of editing its JSON directly.

The hook and acknowledgement helper never send messages or POST identity
updates to the pilot. The Muse worker uses `setAssistantIdentity`,
`readMuseMessages`, and `setSessionSummary` through `artifact.invoke_action`.
This preserves app invalidation and the distinction between metadata and work.

## Preserve an existing inbox cursor when installing

If the existing job has already handled messages, obtain its last successfully
handled sequence before switching consumers. Import that known value once,
before enabling normal polls, using the same pilot URL and scope as the hook:

```sh
python3 <hook-directory>/code-space-watchdog-state.py init \
  --pilot-url 'http://127.0.0.1:18791' --scope '<artifact-slug>' \
  --handled-through '<existing-successfully-handled-sequence>'
```

Pass `--state-dir` too if the hook uses a custom state directory. Initialization
refuses to overwrite existing state or import a cursor ahead of the pilot's
inbox. Never substitute the inbox's current `latest` for the handled cursor;
that could skip unhandled messages. For a new inbox consumer, the initial cursor
is `0`. If the old consumer's progress is unknown, resolve that configuration
before enabling a replacement consumer rather than silently resetting it.

## Verification

```sh
python3 -m unittest discover -s hooks -p 'test_*.py' -v
bash -n hooks/code-space-watchdog.sh
```

The tests use temporary state and a local pilot double. They do not inspect an
artifact DB, change registered jobs, or send real messages. After installing,
use the hook system's dry run to verify worker mode (or an optional profile
override) and the pilot before
letting the existing worker consume the new issue types.
