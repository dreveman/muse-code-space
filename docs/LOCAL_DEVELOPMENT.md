# Developing Code Space on Your Laptop

This guide covers how to work on all parts of Code Space from a MacBook
(or a Linux machine). It assumes you're comfortable with a terminal.

## Architecture overview

Code Space has four parts. The request path is always:

```
+-----------------+      +-----------------+
|     Client      | ---> |     Server      |
+-----------------+      +-----------------+
```

- **Client** (`client/src/`): React + TypeScript UI. Session list, transcript,
  composer, settings menu, wire-log debug panel. This is what you see.
- **Server** (`server/src/actions.ts`): backend actions for the web artifact.
  The **only** writer to the app DB. Never talks to `muse` directly; it calls
  the pilot over HTTP and streams session events back into the app.
- **Pilot** (`pilot/pilot.mjs`): long-lived Node daemon on `127.0.0.1:18791`.
  Owns one `muse serve` host via the official `@muse-code/sdk`, manages
  sessions, pumps turns, runs the stall watchdog, and keeps a wire-debug
  ring buffer. The transcript file is the session: `state/events-<id>.jsonl`.
- **muse serve**: the Muse Code agent runtime, spawned and supervised by the
  pilot. Check the selected CLI's `sessionMcp` grant before deployment.

For UI work you only need the client (+ something to serve pilot traffic).
For full end-to-end testing you need all four pieces running.

## Prerequisites

### MacBook

1. **Node.js 20+**: `brew install node` (or via nvm). Check: `node --version`
2. **Bun ≥ 1.4** (artifact toolchain): `brew install bun`. Check with
   `bun --version`.
   `bun.lock` is lockfile version 2, which bun 1.3.x cannot parse (ignore
   the `packageManager: bun@1.3.10` hint in `package.json`).
3. **Muse CLI**: the `muse` binary on your PATH. Check: `muse --version`
4. **Python 3**: needed by the credential relay. Check: `python3 --version`
5. **Git**: pre-installed on most Macs, otherwise `brew install git`

### Linux

Same list, installed with your distro's package manager (`apt`, `dnf`, …)
instead of `brew`.

## Getting the code

```bash
git clone <repo-url> muse-code-space
cd muse-code-space
```

### One-time: install the space SDK (Mac / non-VM machines)

`package.json` depends on `@hatch/space-sdk` via
`file:/opt/hatch/skills/spaces/ts-runtime/dist/space-sdk.tgz`. That file
exists on the Muse VM only, so `bun install` fails elsewhere until you put
a copy at the **same path**. Do not change the path in `package.json` or
vendor the tgz into the repo — the VM builder uses the `/opt/hatch` copy,
and a repo copy would silently drift from it.

1. Get the tgz from the VM (ask the Muse agent with VM access for a
   download link and its current sha256; it lives at the path above on the
   VM). Use the tarball and checksum from the same host update.
2. Verify and install it (needs sudo once):
   ```bash
   shasum -a 256 ~/Downloads/space-sdk.tgz   # compare with the VM-provided checksum
   sudo mkdir -p /opt/hatch/skills/spaces/ts-runtime/dist
   sudo cp ~/Downloads/space-sdk.tgz /opt/hatch/skills/spaces/ts-runtime/dist/space-sdk.tgz
   ```
3. Install deps and typecheck:
   ```bash
   bun install
   bun run typecheck
   ```

Keeping it in sync: there is no version feed. When the hash of
`/opt/hatch/skills/spaces/ts-runtime/dist/space-sdk.tgz` on the VM
(`sha256sum` there) changes, the builder is on a new SDK — fetch it again
and rerun typechecking against it.

The SDK dependency follows that host-provided tarball. The committed
`bun.lock` intentionally omits only the SDK entry's integrity value because
the platform replaces the file in place. Preserve every registry dependency's
version and integrity value. If regenerating the lockfile restores the SDK
digest, remove just that digest before committing. SDK API or dependency
changes can still require compatibility updates; omitting the digest only
avoids rejecting a platform update because the tarball's bytes changed.

Bun can also reuse a cached local tarball after the host replaces it, even
with `--force`. If the installed SDK still has the old contents, refresh only
its installation and its `@hatch/space-sdk` entry in the artifact's Bun cache
(including that entry's referenced cache payload), then reinstall. Keep the
registry caches. A fresh snapshot with a fresh cache avoids this stale SDK case.

### What works locally vs. VM-only

| Step | Mac | Notes |
|---|---|---|
| `bun run typecheck` | ✅ | needs the SDK step above |
| client/server unit tests | ✅ | `node --test client/src/*.test.mjs server/src/*.test.mjs` (no SDK needed) |
| pilot syntax + tests | ✅ | `cd pilot && npm ci && node --check pilot.mjs && node --test recovery.test.mjs` |
| `bun run build:server` | ✅ | local sanity check only |
| `bun run build:client` | ❌ | the SDK's `buildClient()` only runs inside the artifact builder (it exits unless the builder sets `HATCH_SPACES_BUILD_DRIVER`). Don't set it yourself — use `bun run dev`, which builds the client its own way |
| `bun run dev` (local dev server) | ✅ | UI + server actions locally, see below |
| `bun run dev:fake-pilot` | ✅ | scripted test pilot, no muse/VM needed |
| `bun run typecheck:dev` | ✅ | typechecks `dev/` |
| relay with VM credentials | ❌ | Real authd and egress proxy are VM-only. |
| relay diagnostics tests | ✅ | `python3 -m unittest pilot/test_muse_relay.py` stubs credentials and upstream HTTP. |

None of the local builds publish anything — use the web-artifact builder
plan → build → audit → submit flow (see `docs/PUBLISHING.md`).

## Developing the UI

The fastest iteration loop. Most UI tweaks need no backend changes.

### Local dev server (`bun run dev`)

`dev/server.ts` stands in for the Hatch runtime so the real UI and the real
server actions run on your machine:

```bash
# Option 1 — fake pilot (no muse, no VM; scripted turns)
bun run dev:fake-pilot                              # terminal 1, :18792
MUSE_CODE_SPACE_PILOT_URL=http://127.0.0.1:18792 bun run dev  # terminal 2

# Option 2 — a local pilot running your Mac's muse serve (see "Running the pilot locally")
MUSE_CODE_SPACE_MUSE_BIN=$(which muse) MUSE_CODE_SPACE_RELAY_URL=none \
  node pilot/pilot.mjs   # terminal 1
bun run dev                                                              # terminal 2

# Option 3 — the VM's real pilot with live sessions
ssh -L 18791:127.0.0.1:18791 your-vm-host           # terminal 1
bun run dev                                         # terminal 2 (default :18791)

# open http://127.0.0.1:4173
```

How it maps to the real host:

- **Client**: built with `Bun.build` (development mode, sourcemaps) into
  `.dev/dist` — not `client/dist`, and not via the SDK's `buildClient()`.
  Rebuilds on every change under `client/` and live-reloads the page.
- **Actions**: `POST /actions` with `{action, args, actionCallId}` →
  `{data}` | `{error}`, the same protocol as the host's action bridge. Args
  and responses are validated with each action's zod schemas. Edits under
  `server/src` restart the process (`bun --watch`).
- **Mock `ctx`**:
  - `ctx.db`: Drizzle over `bun:sqlite` at `.dev/app.db`, with `drizzle/`
    migrations applied on start. Use `MUSE_CODE_SPACE_DEV_DIR` for an
    isolated test DB; do not wipe `.dev/` as routine cleanup. It is never
    the artifact's managed `app.db`.
  - `ctx.executePrivileged`: runs `server/src/privileged.ts` in-process
    (pilot URL from `$MUSE_CODE_SPACE_PILOT_URL`).
  - `ctx.invalidateQueries`: pushes a refetch to open tabs. The UI also
    polls, so this only makes updates arrive sooner.
  - `ctx.agent.spawnTask` returns `{ok:false}`, so there's no
    fallback-supervisor path locally.
  - `ctx.emit` does nothing; `ctx.blobs`, `ctx.inference` and `ctx.tool`
    throw. This app doesn't use them.
- **Companion models**: `listModels` reads the pilot's live, entitlement-filtered
  `/models` catalog. Saved `syncModels` rows remain a fallback for ordinary model
  selection and labels; `access_checked: false` means they cannot prove paid access.
  Locally the dev server also seeds those rows at startup. The UI refreshes live
  access every 30 seconds and when refocusing after billing. First messages use
  the chosen companion's model/effort; `assignAgent` saves replacement defaults
  without changing task activity. Paid companions require their exact model,
  checked again on the server before assignment or admission.
- **Last updated + sorting**: `updated_at` means the last prompt or agent
  reply (including agent-to-agent messages, asking/answering a question).
  Polling, tools, status changes, rename, model/effort, project edits and
  archive/restore don't change it. Migration `0015` reconstructs older
  inflated timestamps from transcript events. Restore has its own
  `restored_at`, which moves a stale agent to Active without changing its
  displayed last-updated time. A pending question is `needs_you` (also true
  for failed agents). The Sort by menu on the Active/Past row orders agents
  **within** their existing project/age groups: Priority (needs you,
  finished, working, idle), Updated (last prompt/reply), Created (newest).
- **Archiving**: Successful archive leaves the current Active/Past filter
  unchanged; the row disappears from Active and is retained in Past. If it
  was the open agent, the transcript closes to “Select an agent to see its
  transcript.”; archiving another agent keeps the current transcript open.
  No replacement agent is automatically selected, so the remaining Active
  rows can be archived in sequence. Restore still returns to Active.
- **Unread status**: Migration `0017` adds `output_revision` and
  `seen_output_revision`, both initially zero (historical output is treated
  as read). New visible agent output, including tool/workflow revisions in
  place, increments the output revision; user prompts and hidden lifecycle
  notices don't. A bold name + green dot means unread output. Once seen, a
  working agent shows a subtle spinner and a succeeded one a checkmark.
  `markAgentSeen({ id, output_revision })` atomically advances the seen
  watermark only as far as the rendered revision; it never changes
  `updated_at`. The client calls it when the selected transcript reaches the
  bottom while visible, not just on selection. Other recent agents are polled
  in rotating batches while the UI is open so their replies can become unread
  without first visiting them.
- **Session summary**: `setSessionSummary({ id, summary })` edits the single
  optional `session_summary`, a short sentence up to 240 characters. Muse and
  the UI's Rename task controls write the same field; the last update wins.
  Whitespace is collapsed, and `null` or blank input clears it. Without one,
  sidebar labels fall back to the first prompt. It is separate from a turn's
  result/error `summary` and does not change activity or unread markers.
  Migration `0023` consolidates the former task title and agent description,
  removes `task_title`, and drops obsolete per-session icon storage.
- **Fixed agents**: `createSession` accepts a roster name in `title` (omission
  selects the first free agent). `assignAgent({id, agent_id})` hands off an
  idle session. The server selects the agent's configured model/effort.
  Creation, continuation, and input actions reject model/effort overrides;
  `setAgentPreferences`, `setAgentIcons`, `getAgentIcons`, `renameSession`,
  `setAgentSummary`, and `assignCompanion` are no longer exposed. Agent names,
  artwork, SOUL, and preferences remain authored in `companions/`.
- **Muse assistant avatar**: `getAssistantIdentity()` returns `name`, `color`,
  and nullable `avatar_data_url` (plus `ok/error`). `setAssistantIdentity`
  accepts optional `avatar_data_url`: omission preserves it, `null` clears
  it. It must be a static PNG/JPEG/WebP data URL, at most 256 KiB and 512px
  per side. Both actions and pilots validate it without extra dependencies.
  The real pilot persists it in `state/assistant.json`; the fake pilot saves
  it in `MUSE_CODE_SPACE_FAKE_PILOT_STATE` when configured. Incoming messages
  use a 44px avatar with text in the adjacent column, falling back to the
  Muse logo for missing or broken images. The UI caches identity separately;
  image bytes never enter agent directories or message events.
- **Muse maintenance job**: the canonical worker instructions are in
  `hooks/code-space-assistant-job.md`. Each pass checks the worker's own live
  name/**avatar**, preserving the pilot's saved color, reads `readMuseMessages`
  with a durable per-artifact cursor, and fills missing `session_summary` values
  with `setSessionSummary`.
  An existing registered job must be updated in Muse separately; repo edits do
  not replace its saved prompt. The shell watchdog now detects identity drift
  and pending messages as well as health/summary work; the worker acknowledges
  verified identity sync and successfully handled message sequences through
  `hooks/code-space-watchdog-state.py`. See `hooks/README.md` for worker-sourced
  identity, the optional profile override, and the state/cursor protocol.
- **Expandable tool transcripts**: migration `0018` adds nullable
  `output_events.tool_details`. The existing compact tool label and timing
  stay unchanged; new rows save verbatim arguments, Muse's bounded
  `visibleOutput`, and an optional stored `outputRef`. Clicking the inner
  tool row reveals at most 12 lines. Only a separate **Show all** click fetches
  more: `readToolOutputPage` reads the DB-stored ref through the pilot's
  `/sessions/:id/tools/output` → `item/readOutput`, in 256 KiB pages (up to
  a 64 MiB display safety limit). Binary/unavailable output reports a visible
  error instead of claiming the preview is complete. Older rows remain
  expandable but say their details were not recorded. The fake pilot's
  `long-tool` prompt supplies 18 visible and 35 stored output lines.
  A code-defined adapter registry (`client/src/toolPresentation.ts`) labels
  observed `read_file`, `write_file`, and `edit_file` calls as Reading→Read,
  Writing→Wrote, and Editing→Edited. Bash shows Running bash→Ran bash with
  the bounded `args.description`; expanded Bash shows the verbatim command
  rather than its result (the global raw-output toggle exposes the result).
  A real pilot probe confirmed that a nonzero Bash exit uses
  `failureReason: "process exited with status 7"`; only the Ran bash name turns
  red in that case. Code Space message/list tools have friendly names, and
  unknown tools fall back to Running→Ran (Failed on errors). There is no
  blanket hidden-tool list: only a successful `send_message` row with a
  matching outgoing To event is suppressed in normal view. Failed/unmatched
  calls stay visible, and raw-tool mode reveals all rows. Every running tool
  shows a subtle row spinner instead of a duplicate live timer. Afterward,
  durations appear by default, but read/write show a line count or KB size
  instead. Edits suppress durations without changing stored timing. Read output
  is recognized only with Muse's verified `Read text file …` numbered format;
  successful writes show the submitted content only when the tool's result
  confirms the same byte count. Both use the diff pane's border, scrolling,
  and tight line numbers without +/- markers or change colors. Verified,
  complete files starting at line 1 use the shared Shiki token renderer for a
  short explicit extension allowlist (`.ts/.tsx`, JS, JSON, CSS, HTML, Python,
  Rust, SQL and shell). Unknown, ambiguous, partial, oversized, or invalid
  files stay plain; the lazy tokenizer caps input at 128 KiB / 2,500 lines,
  switches with Light/Dark/System, and never inserts HTML or rewrites output.
  Unrecognized, failed, and oversized file output falls back to the existing
  raw transcript.
  Native Muse `search` has its own Searching→Searched row: a bounded parser
  groups verified `path:line:match` and `path-line-context` rows by file,
  counts only matches (not context), and handles empty results, files-only,
  and typed JSONL output. Incomplete results are marked partial, not falsely
  called “No matches”; unexpected, ambiguous, failed, or oversized output
  falls back to raw. The **Show raw tool output** toggle always preserves the
  original arguments and result. A disposable real Muse 1.4.4 Code Space
  agent verified text-mode context rows and a zero-hit empty result.
  Edit rows show validated `patchSummary` counts. Expanding an edit row loads
  its applied `tool_patch` JSON automatically once the row is visible (even
  with **Expand tools by default**, offscreen patches aren't eagerly fetched).
  `readToolOutputPage(source:"patch")` authorizes the DB-stored ref for this
  session/event and caps patches at 4 MiB. A strict unified text diff is the
  fallback, labeled unverified. The full validated diff sits in a
  keyboard-scrollable pane (up to 420px / 48dvh high) with a thin border,
  colored changes, and line numbers on the same background as each diff row.
  Only a validated structured patch's first hunk beginning at line 1 gets
  source syntax color on its separately tokenized old/new lines; later or
  unverified hunks remain plain because their multiline lexical state is
  unknown. The gutter fits the widest sign+number and leaves one character
  before the code; raw `---`/`+++`/`@@` headers are omitted.
  **Show raw tool output**, **Show wire log**, and **Show relay log** live under
  the hamburger menu's **Debug** heading. Raw output still has a separate
  Show all path. Both logs read oldest-to-newest, opening at the bottom and
  following new entries only while the reader stays there. The relay log
  shows sanitized HTTP status/latency and failure stages, not credentials,
  request bodies or raw headers. Unknown tools with valid JSON output get
  syntax colors via React text nodes, never injected HTML. File tabs share
  the terminal side panel. The header shows an agent-file menu only when the
  agent owns artifacts: `listOwnedArtifacts`
  derives these from persisted, completed `write_file` tool events with a
  matching byte count and path, deduped newest first. Reads, edits, failed or
  unverified writes, and shell commands never add ownership. The menu chooses
  one of those files; the direct Open action on a tool preview remains separate.
  A tab shows the current on-disk version, not historical tool output. Its
  icon buttons refresh, download (basename only) or copy the original text
  without line-number gutters; closing it does not affect terminal shells.
  `readSessionFile` checks app ownership and the session mapping, and the
  pilot refuses paths outside its saved workspace, symlink components, binary
  text and files over 256 KiB / 10,000 lines. No app DB files are read
  directly. The fake pilot's `read-ts-tool`, `write-ts-tool`, `edit-diff`,
  `read-tool`, `write-tool`, `search-tool`, `search-empty`, `search-bad`,
  `bash-nonzero`, and `json-tool` prompts exercise these paths.
  `dev/fixtures/edit-patch.json` is sanitized from a disposable real Muse
  `edit_file` run.

  To repeat the native search smoke test in Code Space, create a disposable
  agent in its own `~/workspace/code/<short-token>` directory. Ask it to
  use `write_file` to place the same unique marker in two small files, then
  call the built-in **`search` tool (not bash or MCP)** with that marker,
  `output_mode:"text"`, and one line of context before/after. Ask for a second
  search for an absent marker. Inspect the expanded rows for **2 matches · 2
  files**, both context lines and match lines, and **No matches** respectively;
  toggle **Show raw tool output** to compare the original `path:line:text`
  bytes. Keep/archive the transcript through the app; never wipe `.dev/`.
- **Reasoning summaries**: MSP `reasoning.summary[]` is streamed on full
  `reasoning` items; the pilot already relays them through `turn.items()`.
  Migration `0019` allows `output_events.kind='thinking'` without losing tool
  details or existing event IDs. The worker updates one row per `itemId` as
  its summary changes, even while hidden. It never stores/renders the item's
  raw `text` (private provider reasoning); an empty summary stays invisible.
  Reasoning is dim italic Markdown in the normal transcript. The agent menu's
  **Show reasoning** checkbox is a browser-local view preference, default on,
  switchable mid-turn or afterward — no start/turn setting. Reasoning alone
  does not change last prompt/reply time or unread status. The fake pilot's
  `thinking` prompt emits empty, partial and completed summary revisions.
- **Transcript and appearance preferences**: the agent menu has browser-local
  **Show reasoning** and **Expand tools by default** switches. The latter
  opens each tool's bounded 12-line preview without fetching stored full
  output; individual rows can still be closed, and changing the switch
  resets visible rows to the new default. The same menu offers **Color mode**:
  System default (follows OS changes), Light, or Dark. These palettes cover
  the app, transcript, wire log and terminal tabs; the selection is saved in
  browser local storage and does not change sessions or turns. For a quick
  check, send `thinking long-tool` to the fake pilot, toggle both switches,
  and compare Light/Dark/System while changing the OS appearance.
- **Companion activity**: the companion's name stays visible above its current
  activity, including friendly tool names shared with the transcript rows.
  Recent reply output is labeled **Typing**. The bottom indicator defaults to
  three animated dots; enable **Show activity details** in the hamburger menu
  for the activity label and elapsed time (no token estimate or thinking level).
  This browser-local preference is off by default and survives reloads.
- **Workspace paths**: these are paths on the pilot's machine. At startup the
  dev server reads the pilot's home folder from `/health` (`home`) and sets
  `MUSE_CODE_SPACE_HOME_ROOT`, so with a local pilot `~/workspace/...` is
  `/Users/<you>/workspace/...`. The last confirmed home is cached per
  `MUSE_CODE_SPACE_PILOT_URL` in `.dev/pilot-home.json`, so a restart while the
  pilot is down still uses the right paths. The VM pilot, the fake pilot,
  and older pilots without `home` keep `/home/hatch`. On a fresh checkout
  without a cached home, start the pilot before the dev server (or set
  `MUSE_CODE_SPACE_HOME_ROOT` explicitly).
- Env: `MUSE_CODE_SPACE_DEV_PORT` (4173), `MUSE_CODE_SPACE_DEV_HOST`
  (127.0.0.1), `MUSE_CODE_SPACE_DEV_DB`, `MUSE_CODE_SPACE_PILOT_URL`,
  `MUSE_CODE_SPACE_HOME_ROOT` (override detected home), and
  `MUSE_CODE_SPACE_DEV_LOG_ACTIONS=1` (log every action call).

**Fake pilot** (`dev/fake-pilot.ts`) implements the parts of the pilot API
the actions call:
- `/health`, `/models`, `/sessions`, `/turns`, `/turns/interrupt`, `/poll`,
  `/recover`, `/sessions/:id/tools/output`, `/user-inputs*` and `/debug/wire`.
- Each prompt plays a scripted turn: tool call → answer →
  `turn_completed`.
- `MUSE_CODE_SPACE_FAKE_PILOT_ADMIT_DELAY_MS=<ms>` holds starts/turns before
  admitting them (a slow pilot), to see the UI's "Sending" state.
- `MUSE_CODE_SPACE_FAKE_PILOT_HOME=/Users/<you>` reports that home in `/health`
  (pretend to run on a Mac). It rejects workspace paths outside that folder.
- Its catalog default is deliberately not the first model, like a real
  catalog's `isDefault` entry.
- Prompt keywords select other scripts: `workflow` (two agents finish in the
  background before a host-started turn), `fail` (turn error), `slow` (10s
  steps to test Stop), `ask` (a question the UI must answer), and
  `long-transcript [N] [live]` / `benchmark [N] [live]` (generates `N` realistic
  transcript items — default `200`, up to `1500` — across reasoning, TS/Py/CSS/Rust
  file reads & writes, structured edit diffs, multi-file searches, bash runs,
  peer/assistant messages, workflows, and rich Markdown replies; add `live` or
  `stream` to stream the tail steps over time after the bulk history lands).
- `receive-message` previews an incoming companion message: **From Pip**, or
  **From Juno** when the current companion is Pip. No sender task is required.
  `send-message-tool` previews an outgoing **To Pip** message. These are
  scripted transcript events, not delivery between two tasks. Add `slow` to
  either prompt to slow the script down.
- It's a test double. When the real pilot's API changes, update it too.

**Where the app's data lives:** the dev server's DB is `.dev/app.db`, kept
across restarts (`bun --watch` restarts included). Use
`MUSE_CODE_SPACE_DEV_DIR=/some/other/dir` for an isolated second instance;
leave the existing `.dev/` state alone.

### Testing model upgrades

The fake pilot defaults to `MUSE_CODE_SPACE_FAKE_PILOT_MODEL_ACCESS=full`, which
exposes Spark, Wonder, and Wonder Full. Restart only your fake pilot with one of:

```sh
MUSE_CODE_SPACE_FAKE_PILOT_MODEL_ACCESS=spark bun run dev:fake-pilot
MUSE_CODE_SPACE_FAKE_PILOT_MODEL_ACCESS=wonder bun run dev:fake-pilot
MUSE_CODE_SPACE_FAKE_PILOT_MODEL_ACCESS=full bun run dev:fake-pilot
```

`spark` locks the eight Wonder companions; `wonder` unlocks Nova, Bea, Iris,
and Ember while Kit, Luna, Otto, and Sage still require Full. The UI updates
on refocus or its next model-access refresh; no dev-server restart is needed.
Cards and handover rows link to `https://dev.meta.ai/billing`. Try starting and
handing over a task before and after changing access; missing paid models must
never substitute Spark or another Wonder tier. With the pilot stopped, the UI
shows unknown access rather than an upgrade claim. Fake `/sessions` and `/turns`
also reject unavailable model IDs, matching the entitlement-filtered catalog.

Run `bun dev/model-access-test.ts` for an isolated integration check of access,
starts, handovers, partial subscriptions, revoked access, and offline discovery.
It uses its own fake pilot and dev server on ports 18897 and 4187, with temporary
state, and stops both when finished. Override the ports with
`MUSE_CODE_SPACE_MODEL_TEST_PILOT_PORT` and `MUSE_CODE_SPACE_MODEL_TEST_APP_PORT`.

### Companion sidebar and cards

The normal **Code Companions** sidebar shows Active/Past controls and tasks
with their descriptions and status above the available companions. With no
tasks, the available companions appear directly under the description.
Once any unarchived task exists, the available list becomes an **Available**
dropdown, collapsed by default. Archiving the last active task restores the
open list, even when past tasks exist. Filtering opens the available list.
The default bench shows five companions, with **More companions** revealing
the rest. The roster has 20 companions: Echo uses the green parrot, Rio the
aviator dog, Mochi the monkey, Tilly the pink detective bird, and Ember the
orange fox.
Select a companion to see their card in the main view. With no tasks, the
sidebar is focused on choosing a companion and desktop opens Pip's card.
Use the card's left/right arrows to browse available companions; browsing
wraps around and keeps the sidebar selection in sync.
Mobile starts with the sidebar and uses the card's **Back to companions** button
to return to it. Swiping does not change companions.

On phones, cards share one collapsed size: at most 440 px tall, constrained by
actual space above the prompt. A small portrait sits beside the name and role,
with ratings in two columns. Every card reserves the same description/upgrade
row. As height decreases, trade-offs, then skills, move into **More about**;
the portrait and spacing shrink too. When very little space remains, ratings
also move into details. These changes apply to every companion at the same
available height, so browsing never changes the card's size. The prompt's
styling and controls are unchanged.

**More about** uses the same quiet text and chevron style as **More companions**.
It expands the card inline to show model/effort and SOUL.md. On phones, it also
reveals the full description, ratings, skills, and trade-off. The card grows to
fit its content, including an expanded SOUL.md; only the surrounding view
scrolls. The prompt stays in place. Press the button again to collapse the card
back to its shared size. Check tall and short phones, landscape, locked cards,
a multiline prompt, and keyboard viewport changes.

Desktop collapsed cards reserve identical rows for descriptions, upgrade
notices, ratings, skills, and trade-offs, so locked and unlocked cards have the
same footprint and section positions. The desktop upgrade notice uses the same
single-line label and link as phone cards, with a smaller reserved row.
Locked cards use a still portrait with an Unavailable banner and grayscale,
slightly dimmed content. The upgrade notice stays at full text contrast in both
layouts.
Cards do not scroll their contents internally; expanded cards grow naturally.

Card idle and conversation idle use separate artwork slots. Pip has a full-body
card animation and a portrait idle shared by the sidebar and conversation view.
Its portrait wake-up is selected on the first render of a new task, with no
idle/still flash before it. Follow-up prompts go straight to Working. Animation
changes cross-fade over 640 ms; Working moves only the paw.
Other companions use their own still images as portrait placeholders until
polished; Nova keeps its existing portrait idle and uses a still card placeholder.
Reduced motion uses a matching still for each view, and archived tasks stay still.

- The prompt stays below the card. Pick a companion and send the first
  message to start their task; choosing a companion alone saves no task.
  There is no separate create button or draft screen. First messages use the
  chosen name and default model/effort, with a generated working directory.
  Try an empty message, a failed send, and offline queue/cancel/reconnect.
- The companion button in either composer opens a companion picker. Before
  the first message it switches companions and keeps unsent text. In a task
  it hands over to an available companion, keeping the task ID, transcript,
  folder, project, and unsent message. The previous companion becomes free.
  Stop any current turn first. Busy companions are excluded, and the server
  checks availability again.
- Past tasks show a still companion portrait labeled **Archived task**.
  If the previous companion owns another unarchived task (even a quiet one),
  sending and restoring are blocked until a free companion is chosen from
  the prompt's picker. Choosing a replacement keeps the task archived and
  preserves its history, project, folder, and unsent draft. Sending or
  restoring claims the companion; the server checks again and rejects
  conflicting claims from other tabs. A rejected start restores the task's
  previous state and releases the temporary claim.
- **Active/Past** and sort controls appear once a task exists. **Filter**
  appears with more than one task and matches companion names, task summaries,
  prompts, and output, plus available companions' names, roles, and skills.
- Tasks are most recently updated first by default. Active tasks automatically
  group by project once at least one project exists. Past
  contains explicitly archived tasks; an old unarchived task stays active.
- Cards show ratings, skills, trade-offs, and **More about** for the default
  model/effort and SOUL.md. Test narrow screens, dark
  mode, and reduced motion; sidebar portraits are always stills.
- Companion definitions remain read-only; stable assignments and
  configuration editing come later. The current
  name-based roster association is documented in `companions/README.md`.

### Terminal (prototype)

The terminal button (>_) next to the session menu always opens a new
terminal: a shell in the session's working directory on the pilot's host,
where `muse serve` runs. Terminals appear to the right of the transcript
(below it on narrow screens), and a session can have any number ("Terminal 1",
"Terminal 2", …). The strip shares the terminal pane's background; a thin
underline marks the selected tab. Each tab's × closes it and ends its shell.
The tab strip is generic (`client/src/SidePanel.tsx`), so other views could
join it later. On desktop, drag either thin vertical divider to
resize sidebar/chat or chat/terminal; the terminal itself auto-resizes to its
pane. The handles accept Left/Right arrows (Shift for bigger steps), Home/End,
and double-click to reset. Widths are saved in the browser's local storage,
clamped when the window narrows; the stacked narrow-screen layout has no
resize handles. The chat/terminal split is retained when the tab pane is
closed and reopened.

- **Client:** `client/src/TerminalPanel.tsx` (one tab's content) renders it with
  [wterm](https://wterm.dev) (`@wterm/react`). There's no WebSocket path from
  the browser to the VM, so it goes through the app's actions:
  `terminalOutput` long-polls output by byte offset, and `terminalInput`
  sends keystrokes batched every ~12 ms, strictly in order.
- **Server:** `openTerminal` / `terminalInput` / `terminalOutput` /
  `terminalResize` / `closeTerminal` in `actions.ts`. They're owner-only
  when the host reports a viewer.
- **Pilot:** `pilot/terminals.mjs` + `pilot/pty_bridge.py` (stdlib Python,
  no `node-pty` or other native modules). Shells belong to an app session:
  switching sessions and coming back, or reloading the page, rebuilds the
  tabs from the pilot (`GET /terminals?key=`) and replays recent output.
  Closing a tab, archiving or deleting the session, or restarting the pilot
  ends its shell(s). Tests:
  `node --test pilot/terminals.test.mjs`.
- The fake pilot uses the same module, so `bun run dev:fake-pilot` gives
  real local shells.
- The shell's environment is an explicit allowlist (see
  `MUSE_CODE_SPACE_TERMINAL_ENV` below), so running the pilot from iTerm
  doesn't leak
  `TERM_PROGRAM=iTerm.app` and friends into it.

### Agent names

New agents get a name, not a title made from their first prompt.
`server/src/agentNames.ts` hands them out: Pip, Juno, Milo, … then
numbered ("Pip 2"). "Jolly" and "Muse" are reserved for your Muse
assistant (see below). Names are unique across active and archived agents
(case-insensitively) because they also address agents **in Muse**:
- **On create:** the pilot sets it with `session/rename` before the first
  turn and reports Muse's canonical name, which becomes the agent's title.
  Other agents use that name to address it in peer messages.
- **Rename task** in the sidebar or transcript menu changes only the task label
  (`session_summary` via `setSessionSummary`). It does not rename the companion or agent in Muse. The label
  appears under the companion name and is included in task filtering.
- **Companion handoff** changes the agent name in Muse (`POST /sessions/:id/rename`)
  while preserving the task label.
- **Name changes from Muse** (`session/nameChanged`: its own automatic name,
  `/name`) reach the app as `name_changed` events, and the title follows.
- A recovered backend session gets the name again.

The UI derives an agent's hue from its normalized name, not its working
folder. Pip has the same color in the selected sidebar row and peer-message
name chips on any machine or workspace. A companion name change updates its
color; task renaming does not. Older messages retain the color of the name
printed on them. The chat has no metadata header. Terminal, artifact, and menu controls
float at the top right of the chat column, with a back button on mobile.
The first message starts below the controls; scrolling content can pass
behind them without moving the controls or covering side-panel tabs.

### Agent-to-agent messages

Muse's native peer messaging doesn't work for agents run through
`muse serve`: muse 1.4 registers a session-message target only for
interactive (TUI) sessions, so serve-hosted agents never get its
`send_session_message` tool. The pilot provides messaging instead.

- **Required built-in tools for agents:**
  - The pilot requests MSP's experimental `sessionMcp` capability during
    `initialize` and **refuses to boot unless the host grants it**. The
    selected Muse Code binary must support and grant per-session MCP; that
    handshake grant is the compatibility check, not just a version string.
  - Each started or resumed session gets Code Space's MCP server through
    per-session `config.mcpServers` (`code-space`, streamableHttp, `required`),
    producing tools such as `mcp__code_space__send_message`. If that server
    cannot start, session creation fails visibly rather than producing an
    agent that cannot message. The SDK facade doesn't forward `config`, so
    the pilot adds it to `session/start`/`session/resume` after checking the
    handshake grant.
  - Its URL `/mcp/<token>` identifies the agent, so tool calls always know
    the sender. The tools are **`send_message(to, text)`** and
    **`list_agents()`** (`pilot/mcp.mjs`). There is no bash fallback.
  - When GitHub integration is set up (a broker credential is
    provisioned), the same server also offers **`github_create_pr`**,
    **`github_pr_status`**, and **`github_list_prs`** (`pilot/githubTools.mjs`).
    Calls run from the pilot through the local GitHub broker with the
    session sentinel — agents never hold a credential — and repo/head
    default to the session workspace's origin remote and current branch.
    The gate is checked per request, so provisioning GitHub later lights
    the tools up without restarting sessions.
  - **`github_monitor_pr(number)`** starts background monitoring: the
    pilot (`pilot/prMonitor.mjs`) polls the PR through the broker about
    once a minute for reviews/approvals, new comments, CI transitions,
    and merge/close, persisting monitors in `pr-monitors.json` so they
    survive restarts. Material changes upsert a live `pr_monitor`
    transcript row and deliver a turn to the owning session. Monitoring
    stops when the PR merges or closes (or via `stop: true`).
  - During pilot startup the HTTP listener starts before sessions resume,
    so required MCP servers can connect; `/health` reports unhealthy and
    normal API routes return 503 until reconciliation finishes.
- **Composer @mentions:** both draft and existing-agent composers suggest
  available agent names after `@` (pilot `listAgents` with a cached session
  fallback if it is offline), excluding the sender by pilot ID and canonical
  name, plus `@Jolly (your Muse assistant)` (or the real avatar name returned
  by the pilot). Enter/Tab chooses a suggestion, arrows navigate, Escape
  dismisses; mouse/touch also work. Names are inserted canonically for
  routing (multiword names are quoted). A prompt such as `Send @pip a message
  asking it to replace the contents of test.rs with TEST` stays in the sender's
  transcript as written. The pilot's first-turn preamble explicitly tells the
  agent to use `mcp__code_space__send_message(to: "pip")`; on later turns the
  pilot adds the same routing hint to explicit `Send @name …` requests addressed
  to a known other agent or the Muse assistant by its current avatar name.
  The agent still chooses the message text and makes
  the MCP call itself; the browser does **not** send as the user's Muse identity
  or invoke a bash messenger. A queued offline prompt keeps the same text.
- **Your Muse assistant** uses the app's actions (`artifact.invoke_action`):
  `listAgents`, `sendAgentMessage({to, text})`, `readMuseMessages({since})`,
  and `getAssistantIdentity` / `setAssistantIdentity({name?, color?, avatar_data_url?})`.
- **The assistant's identity:**
  - Default **Jolly** (the default Muse avatar), color **`#d0e4fc`**
    (R .816 G .894 B .988).
  - On a Muse VM the assistant sets its real avatar name and theme color
    with `setAssistantIdentity`. It's saved in `state/assistant.json`;
    `MUSE_CODE_SPACE_ASSISTANT_NAME` / `MUSE_CODE_SPACE_ASSISTANT_COLOR`
    change the defaults.
  - **Reserved names:** `muse`, `jolly` and the assistant's name. No agent
    can take them (new names skip them, renames are refused), and messages
    addressed to any of them go to the assistant. `muse` remains a working
    compatibility alias, but `list_agents` advertises the usable avatar name.
- **Agent directory display:** `list_agents` returns one bullet per other
  agent and `Jolly — your Muse assistant` (or the current avatar name), never
  a `muse` pseudo-agent. The expanded tool row retains “You are Milo. You can
  message:” above the list, with Milo colored like other agent chips. It drops
  the `Arguments: {}` / `Output:` wrapper and uses the same name-colored chips
  as From/To messages;
  the global raw-output toggle restores the original text for debugging.
  Older `muse — Jolly, ...` results are presented with the avatar name too.
- **Delivery:** the pilot delivers each message to the recipient (by name,
  case-insensitive) as a new turn, queued behind a running one. The turn
  starts with the sender's identity and instructions to reply via
  `mcp__code_space__send_message`. Messages from the user's Muse assistant
  identify its avatar. Replies to the assistant go to `state/muse-inbox.jsonl`.
- **Transcripts** show a message row on both sides. The sender's To row is
  canonical when the matching `send_message` MCP tool succeeds, so the normal
  view doesn't repeat the same send as a tool row. The tool event remains
  stored and is visible with **Show raw tool output**; failed or unmatched
  sends remain visible even in normal view.
  - *From Jolly · your Muse assistant*: the Muse logo, in the assistant's
    color.
  - Otherwise *From* / *To* a name chip in that agent's color.
  - Migration `0013` adds the `message` kind.
- **Pilot routes:** `GET /agents`, `POST /messages {from:"muse", to, text}`
  (only the user's Muse assistant uses it), `GET /messages/muse?since=`,
  `GET|POST /assistant`, `POST /mcp/:token`. Agents send only through their
  session-scoped MCP tool. The fake pilot implements the non-MCP routes.

### Agent-to-agent work (workflows, subagents)

In `muse serve` the model coordinates other agents with **`muse.workflow`**:
a script runs child agents (`host.agent()`, `host.parallel()`) in the
background, each in its own child session. When they're done, `muse serve`
delivers the results by **starting a turn in the parent session itself**.
Native `subagent_*` tools and peer session messaging aren't enabled there
(yet). Their protocol items are handled the same way, though.

- **Pilot:** it taps every host notification, not just the turns it started.
  - A `turn/started` for a turn it didn't start (workflow results, finished
    background tasks, cron) is followed like its own and announced as a
    `host_turn_started` event.
  - Updates to `workflow`/`subagent` items that arrive after their turn ended
    are relayed too.
  - Control: `POST /sessions/:id/workflows/:runId/cancel` (`workflow/cancel`).
    Not `subagent/readResult`: that's a steering command for the parent
    agent, not a data read for clients. Per-child results aren't on the
    protocol, so the UI shows each child's status and run time plus the
    workflow's final summary.
- **App:** each workflow/subagent item is one live `agents` row, updated in
  place (migration `0012` adds the kind).
  - The transcript shows a block with the workflow name, status, run time
    and Stop, plus a row per child agent (status, run time), and the
    workflow's result. muse names a child only on its first update and
    reports progress steps (`scheduled`/`started`/`usage`) before `terminal`.
    The row carries names over and normalizes statuses. The final message is
    a `<workflow-launch-reconciled>` envelope whose `final_summary` is shown.
  - The session keeps syncing while agents run, even after the turn ended.
  - A host-started turn shows a note ("Muse continued on its own…") and the
    session runs again.
- **Fake pilot:** a prompt containing `workflow` plays the real sequence:
  launch, turn ends, children progress (same status steps and message
  envelope as muse 1.4), host turn with the answer. Stop works.

### Starting an agent while the pilot is down

The first prompt is saved in the app DB as a `queued` agent even when the pilot
cannot accept it. The UI says **Connecting…** and shows the saved first
message rather than pretending Muse is thinking. While the UI is open,
`recoverPendingAgents` runs every 5 seconds. The worker claims one eligible
queued agent with a short DB retry lease and sends its original prompt when
the pilot returns. A lease expires after a
worker crash, and `POST /sessions` deduplicates by the app's stable
`workspaceName`, so a lost HTTP reply doesn't create a second agent/turn.
Closing and reopening the UI also resumes recovery. This replaces the
unclaimed fallback-supervisor path for *new* agents.

Network/relay outages keep the agent queued and retrying. If the pilot
explicitly rejects the first prompt (e.g. an invalid model), the agent turns
**Failed** with the reason in its transcript and a **Retry start** button.
Both the app's and pilot's saved state must survive service restarts. Migration
`0014_add_pilot_start_retry.sql` adds a bounded retry lease and remembers
whether a model was explicitly selected; when the app has no live catalog,
the pilot chooses its own default after it reconnects.

- **System errors:** migration `0021` marks failure rows explicitly (including
  older recognized restart/start errors). Failed starts, turns, recovery and
  answer delivery render red; neutral restart/stop notices keep their normal
  color. Error wording is never used as the sole classification for new rows.

### Testing restarts (`bun run test:restart`)

When only the pilot is down, app DB-backed lists/transcripts remain readable.
`syncPilotEvents` reports `pilot_available:false`; the selected session shows
**Connecting…** beneath the companion's name in its status bubble, just as
for a browser-to-app outage, without an unexplained live timer. Once polling
succeeds, the connection status clears and a lost
running turn fails visibly. New agents' first prompts are saved in app.db;
the browser's one-message offline queue is only held in memory.

Follow-up prompts also queue when the pilot is unavailable, including a
temporary transport failure during submission. `sendInput` and
`continueSession` return `retryable: true` for those failures; actual prompt
rejections remain errors. The queue waits for its target session's pilot poll,
even when another companion is selected, and refreshes the session status
before delivery. Cancel restores the queued text without sending it.

Restarts are where this system is hardest to get right, so there's a
harness for them. `dev/restart-test.ts` starts its **own** pilot (:18894) and
dev server (:4176) with throwaway state in a temp dir. It never touches the
pilot or dev server you're using. It drives the app's actions the way the
UI does:

```bash
bun run test:restart          # fake pilot: fast, no muse needed
bun run test:restart --real   # real pilot + your machine's muse serve (run from a normal terminal)
bun run test:restart --keep   # keep the temp state + logs even on success
```

| # | Scenario | Must hold |
|---|---|---|
| 0 | create a session, finish a turn | turn succeeds |
| 1 | restart the dev server | transcript kept, follow-up turn succeeds |
| 2 | restart the pilot (SIGTERM) | follow-up turn succeeds |
| 3 | crash the pilot (SIGKILL) | follow-up turn succeeds |
| 4 | kill `muse serve` under the pilot (`--real` only) | pilot respawns it, follow-up succeeds |
| 4a | crash the app worker with a new tool in progress | the pilot keeps running; the turn finishes once after app restart |
| 5 | restart the pilot with a new tool in progress | the turn ends visibly (never stuck "running"), its tool timer stops, and a follow-up succeeds |
| 6 | restart everything at once | follow-up turn succeeds |
| 7 | end state | exactly one app session, transcript intact |
| 8 | create while pilot down, restart the app, start pilot | original prompt runs once after reconnection |
| 9 | pilot accepted a start but the HTTP reply was lost, then crashed | app attaches to the original pilot session and turn after the restart; no duplicate agent/prompt |

It prints PASS/FAIL per scenario and exits non-zero on any failure. The
mid-turn cases require a tool from the **new** turn to be in progress; old
transcript rows and missed waits cannot pass them. Logs are in the temp dir
it prints. With `--real`, the test agents' workspaces are
created under `~/workspace/code/<12-hex-token>` (the app only accepts
workspaces under `~/workspace`) and removed at the end. The real-mode test
refuses to reuse a pre-existing path before creating any agent. The fake pilot
keeps its sessions via `MUSE_CODE_SPACE_FAKE_PILOT_STATE=<file>` (the harness
sets it). Without that, every pilot restart forgets all sessions, and
scenarios 2–6 fail with `unknown session`.

Known limits:
- Spark companions prefer `muse-spark-1.3` when the saved catalog has it,
  otherwise they take the first model. This fallback doesn't know the
  catalog's `isDefault` (that isn't stored in the app DB). Wonder and Wonder
  Full companions require their exact model from the live filtered catalog.
- The app is served top-level, not framed by the Hatch host, so host
  features (auth refresh, safe-area chrome offsets) aren't exercised.

### Running the pilot locally (Mac with a compatible Muse CLI)

```bash
MUSE_CODE_SPACE_MUSE_BIN=$(which muse) MUSE_CODE_SPACE_RELAY_URL=none \
  node pilot/pilot.mjs
```

Verified 2026-10-03: boots, `muse serve` authenticates through AI Gateway
under `~/.config/muse-code-space-pilot` (no relay, no
`auth.json` needed), turns stream, bash tool calls work with
`--disable-sandbox`, and turns are accepted in about 60ms.

- **Model IDs vary by host.** Check the local gateway catalog through
  `/models` rather than copying an ID from another machine. When a caller
  talks directly to the pilot without a model (`POST /sessions` without
  `modelId`), the pilot uses its catalog default. App `createSession` instead
  selects the roster agent's preferred model when available, otherwise the
  first host model. It rejects explicit model/effort overrides.

- `pilot.mjs` defaults to `muse` on PATH. The explicit
  `MUSE_CODE_SPACE_MUSE_BIN=$(which muse)` selects the same launcher; it must
  grant the `sessionMcp` capability, or the pilot fails fast.
- State goes to `~/workspace/muse-code-space-pilot/state`. New agents default to
  `~/workspace/code/<12-hex-token>`, separate from Hatch's `ts-spaces/` source.
  Existing sessions keep their saved path, and a caller may set a custom
  directory. The app checks generated-path conflicts with saved sessions,
  and the pilot refuses a new generated path that already exists on the host.
  Custom paths may point to existing directories. Use
  `MUSE_CODE_SPACE_PILOT_PORT` to avoid clashing with another pilot.
- Set `MUSE_CODE_SPACE_RELAY_URL=none`. The credential relay is VM-only (see
  `docs/PILOT.md`), and on a Mac `muse` reaches the model API itself
  through AI Gateway. Without this setting, the pilot waits 30s for a relay
  at boot and refuses every turn with `relay_down`. With it, `/health` reports
  `"relay": "disabled"`. The pilot warns at boot if
  `~/.config/muse-code-space-pilot/muse/settings.json` still points Muse at
  the relay.
- Run it from a normal terminal: inside a sandboxed agent shell `muse serve`
  exits with `sandbox-exec: sandbox_apply: Operation not permitted`
  (nested sandboxing), which is the harness, not the pilot.

### Files to edit (client)

- `client/src/App.tsx` — main app: session list, transcript, composer, menus
- `client/src/theme.css` — all styling
- `client/src/WireDebug.tsx` — wire-log debug panel
- `client/src/api.ts` — API client for server actions
- `client/src/main.tsx` — entry point

### Testing UI changes

1. Run `bun run dev` (with the fake pilot or the VM pilot) and edit; the page
   reloads on save.
2. Test at desktop **and** mobile widths (browser dev tools device toolbar).
3. Verify: session list renders, transcript streams, composer sends a prompt,
   settings menu opens, no console errors.
4. Run `node --test client/src/*.test.mjs server/src/*.test.mjs`.
5. Typecheck before publishing: from the repo root, `bun run typecheck`.

## Developing the server

The server actions bridge the UI and the pilot. In production they run in
the artifact runtime; locally `bun run dev` runs them in-process against a
throwaway SQLite DB (see "Local dev server"). Final verification still
happens after deploy.

### Files to edit (server)

- `server/src/actions.ts` — every server action (sessions, polling,
  `sendInput`, wire-debug passthrough, …)
- `server/src/schema.ts` — database schema
- `server/src/pilotEvents.ts` — pilot event parsing/formatting
- `server/src/privileged.ts` — privileged helpers (e.g. resolving pilot URL)

### Testing server changes

1. Edit `server/src/*.ts`.
2. `bun run typecheck` from the repo root, plus the unit tests.
3. Exercise them locally through `bun run dev` (the fake pilot covers
   success / `fail` / `slow` + stop / `ask` paths), or call one directly:
   ```bash
   curl -s -X POST http://127.0.0.1:4173/actions -H 'content-type: application/json' \
     -d '{"action":"listSessions","args":{}}'
   ```
4. Publish (see below) to deploy, then exercise through the app.

## Developing the pilot

Standalone Node daemon — the easiest part to run and test locally.

### Files to edit (pilot)

- `pilot/pilot.mjs` — everything: session registry, turn pumping, idle
  watchdog, stall recovery, wire-debug buffer, HTTP API
- `pilot/install.sh` — deploys code to
  `~/workspace/muse-code-space-pilot/` and restarts the project units. Never
  edit runtime copies directly; change the repo and reinstall.
- `pilot/watchdog.sh` — liveness watchdog
- `pilot/muse_relay.py` — project credential relay and safe UI diagnostics
- `pilot/recovery.test.mjs` — regression tests

### Testing pilot changes

```bash
cd pilot
npm ci                            # first time: installs @muse-code/sdk
node --check pilot.mjs            # syntax check — always run this first
node --test recovery.test.mjs     # regression suite
node pilot.mjs                    # start it; spawns muse serve itself (see
                                  # "Running the pilot locally" for Mac env)

# In another terminal:
curl -s http://127.0.0.1:18791/health | python3 -m json.tool
curl -s http://127.0.0.1:18791/debug/wire | python3 -c "
import json, sys
d = json.load(sys.stdin)
for e in d['entries'][-10:]:
    print(e['at'][11:19], e['dir'], e['method'], e.get('ms', ''))
"

# Deploy to the runtime location when it works:
./install.sh
```

### Pilot endpoints

| Method & path | Purpose |
|---|---|
| `GET /health` | Liveness: sessions, relay state, open/stuck turns, `home` (the pilot's home folder) |
| `GET /debug/wire` | Wire-debug ring buffer (pilot<->backend traffic, always captured) |
| `POST /debug/wire` `{"clear": true}` | Empty the wire buffer |
| `GET /sessions/:id/poll?since=N` | New events since seq N (what the app worker calls) |
| `GET /sessions/:id/events` | SSE stream of session events |
| `POST /sessions/:id/turns` `{"text": "…"}` | Start a turn (fast; returns turnId) |
| `POST /sessions/:id/turns/interrupt` | Interrupt the running turn (priority lane) |
| `POST /sessions/:id/recover` | Recreate a lost backend session from its transcript |
| `POST /sessions/:id/rename` `{name}` | Rename the agent in Muse (`session/rename`); returns the canonical name |
| `POST /sessions/:id/workflows/:workflowRunId/cancel` | Stop a workflow and its child agents (`workflow/cancel`) |
| `POST /terminals` `{key, cwd, cols, rows, terminalId?}` | A new UI terminal for an app session (a login shell on a PTY in `cwd`, via `pty_bridge.py`), or reattach to one of its terminals by `terminalId` |
| `GET /terminals?key=<sessionId>` | The session's terminals (`terminalId`, `number`, `exited`), oldest first |
| `POST /terminals/:id/input` `{data}` · `POST /terminals/:id/resize` `{cols, rows}` | Keystrokes / window size |
| `GET /terminals/:id/output?since=N&waitMs=M` | Long-poll output by byte offset (base64; 1 MB replay window; `exited`/`exitCode`) |
| `DELETE /terminals/:id` · `DELETE /terminals/by-key/:sessionId` | Kill one shell (closing its tab), or all of a session's shells (archive / delete) |
| `DELETE /sessions/:id` | Permanently forget a session: registry entry, alias, `events-<id>.jsonl` (409 `turn_running` while a turn runs; idempotent). `muse serve`'s own session store is untouched (MSP has no delete verb) |

### Pilot environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MUSE_CODE_SPACE_RELAY_URL` | `http://127.0.0.1:18790` | Credential relay the pilot waits for at boot and checks before admitting turns. `none` turns all relay checks off (Mac / hosts where `muse` reaches the model API itself). Never set `none` on the VM. |
| `MUSE_CODE_SPACE_MUSE_BIN` | `muse` on PATH (direct run); VM unit uses the installer's selected binary | Muse Code binary for `muse serve`; must grant `sessionMcp` at initialize or the pilot fails to boot. |
| `MUSE_CODE_SPACE_PILOT_PORT` | `18791` | Project pilot HTTP port; installer checks ownership before binding. |
| `MUSE_CODE_SPACE_RELAY_PORT` | `18790` | Relay port (unit, settings, watchdog and pilot URL must agree). |
| `MUSE_CODE_SPACE_PILOT_URL` | `http://127.0.0.1:18791` | App/worker URL for the project pilot; set when its port differs. |
| `MUSE_CODE_SPACE_HOME_ROOT` | detected pilot home (or `/home/hatch`) | Host home used for agent workspace paths. |
| `MUSE_EXPERIMENTAL_LOCAL_SESSION_MESSAGING`, `MUSE_EXPERIMENTAL_EXTERNAL_AGENT_INGRESS` | `1` (set by the pilot) | Muse's peer messaging between agents (experimental in 1.4). The pilot turns both on for its `muse serve`; set either to `0` to turn it off. |
| `MUSE_CODE_SPACE_WRITABLE_DIRS` | `~/workspace` | Folders agents may write to (newline- or colon-separated). On a Mac, `muse` is Meta's launcher, which runs the CLI in a macOS sandbox: without this, writes to agent workspaces fail with "Operation not permitted". Passed as `META_3PAI_ADDITIONAL_WRITABLE_DIRS`, which a plain CLI binary ignores. |
| `MUSE_CODE_SPACE_TERMINAL_SHELL` | your login shell (passwd) | Shell for UI terminals. |
| `MUSE_CODE_SPACE_TERMINAL_ENV` | — | Extra variables for UI terminals, `KEY=value;OTHER=value`. Terminals otherwise get only `HOME`, `USER`, `LOGNAME`, `SHELL`, a minimal system `PATH`, `LANG` (plus the real locale categories `LC_ALL`/`LC_CTYPE`/`LC_COLLATE`/`LC_MESSAGES`/`LC_MONETARY`/`LC_NUMERIC`/`LC_TIME` and `TMPDIR` if set; not iTerm's `LC_TERMINAL*`), `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=wterm`. The login shell builds the rest from your profile. Nothing else is inherited from wherever the pilot runs. |
| `MUSE_CODE_SPACE_PYTHON` | `python3` | Python used for PTY bridges. |
| `MUSE_CODE_SPACE_ASSISTANT_NAME`, `MUSE_CODE_SPACE_ASSISTANT_COLOR` | `Jolly`, `#d0e4fc` | Default assistant identity, superseded by its saved identity. |
| `MUSE_CODE_SPACE_TERMINAL_IDLE_MS` | `0` (never) | Optional: kill UI terminals nobody has read for this long. Not needed: closing a tab, archiving or deleting the session, or a pilot restart ends its shells. |
| `MUSE_CODE_SPACE_PILOT_STATE_DIR` | `~/workspace/muse-code-space-pilot/state` | Registry, aliases and `events-*.jsonl` transcripts. Override to run a second pilot beside the real one. |
| `MUSE_CODE_SPACE_WORKSPACES` | `~/workspace/code` | Default parent for direct pilot callers without `workspaceRoot`. `workspaceName` hashes to a stable 12-hex suffix; app-created sessions pass their own saved path. |
| `MUSE_CODE_SPACE_TURN_IDLE_TIMEOUT_MS` | `300000` (5 min) | A turn producing no output with **no tool running** (agent just "thinking") is treated as wedged after this long. |
| `MUSE_CODE_SPACE_TURN_TOOL_TIMEOUT_MS` | `3600000` (60 min) | A turn with a **tool actively in progress** gets this much silence before it's treated as wedged. Long builds/tests are normal — don't lower this casually. |
| `MUSE_CODE_SPACE_TURN_START_TIMEOUT_MS` | `600000` (10 min) | Budget for the first item of a turn. |

Timeouts always fail **visibly** in the transcript ("Turn stalled… send a new
message to retry") — never a silent spinner.

## Publishing your changes

This is a web artifact. Complete and verify source edits, then use the
**current web-artifact builder** plan → build → audit → submit flow. The
builder instructions and artifacts skill specify the exact interface; this
checkout cannot publish with `bun run build` or `.publish-request`. Keep the
generated `space.json` (from `space.json.template`) and its required source
directory. Include
Drizzle migrations without replacing managed `app.db`. Pilot code is deployed
separately with `pilot/install.sh`; preserve new runtime state afterward.
Follow `docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md` and `docs/PUBLISHING.md`.
Never claim a publication succeeded until the builder confirms submit.

## Common workflows

### UI tweak

1. `bun run dev:fake-pilot` with
   `MUSE_CODE_SPACE_PILOT_URL=http://127.0.0.1:18792 bun run dev`
   (or `bun run dev` against the tunnelled VM pilot); open :4173.
2. Edit `client/src/App.tsx` / `theme.css`; the page reloads on save.
3. `bun run typecheck` and the unit tests.
4. Publish through the artifact builder and verify its audit/submit result.

### Pilot fix

1. Edit `pilot/pilot.mjs`.
2. `node --check pilot.mjs`; run `node --test` if the suite exists.
3. Run it locally, check `/health` and `/debug/wire`.
4. `./pilot/install.sh` to deploy; confirm the service is healthy.
5. Publish any matching app change separately through the artifact builder.

### Debug a stuck agent

1. **Health**: `curl -s http://127.0.0.1:18791/health | python3 -m json.tool`
   — look at `turns.open`, `turns.stuck`, `turns.maxIdleMs`.
2. **Wire log**: `curl -s http://127.0.0.1:18791/debug/wire` — look at the last
   `turn/start`, any `FAIL` entries, and which tool call is sitting in
   `inProgress`.
3. **Backend CPU**: `ps aux | grep 'muse.*serve' | grep -v grep` — high CPU
   means it's working; low CPU + no output for minutes means wedged.
4. **In the UI**: session settings menu → "Show wire log" (capture is
   always on; the toggle only shows/hides).

### Unstick a wedged turn

Prefer the app's Stop control or the pilot's targeted
`POST /sessions/<session-id>/turns/interrupt`; wait for a terminal outcome
before retrying. If the VM pilot itself must restart, inspect open turns and
use `sudo systemctl restart muse-code-space-pilot.service` on a unit-managed
host, then verify `/health`. Never run a broad `pkill`, launch a competing
pilot, or delete registry/transcript state to unstick a turn.

## Mac-specific notes

- `muse serve --disable-sandbox` is required in the Linux container (its
  sandbox can't mount `/proc` there). On a Mac the sandbox may work fine —
  try removing the flag from the pilot's spawn args if you want sandboxing,
  but test carefully; sandbox failures are subtle.
- The credential relay is Python 3 (`muse_relay.py`); make sure `python3` is
  on your PATH.
- Pilot state lives under `~/workspace/muse-code-space-pilot/` (`~` is
  `/Users/<you>` on a Mac). Create it before first run; the pilot keeps
  `state/`, logs, and the session registry there.
- The iOS app talks to the **published** sidebar Space, not your local dev
  server. For on-phone testing, publish through the artifact builder, or use
  desktop browser dev-tools mobile emulation.
- Voice input uses the browser's built-in speech recognition; it works in
  desktop Chrome/Safari and mobile Safari with no extra setup.

## Linux VM

Use `docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md` to confirm pilot/relay health,
install source and publish with the builder. Do not assume a running service,
a source checkout or an artifact exists simply because a clone exists.

## Further reading

- `docs/PILOT.md` — pilot architecture, installation and restart recovery
- `docs/LIVE_TESTING.md` — testing against the running services
- `docs/PUBLISHING.md` — builder-based publication and safety
- `AGENTS.md` (repo root) — house rules: what never to edit by hand
- Pilot log: `~/workspace/muse-code-space-pilot/pilot.log`
