# Building this web artifact

This directory is a git checkout — not the build source. A TypeScript space:
a React client in `client/`, server actions in `server/src/actions.ts`, the
schema in `server/src/schema.ts`, and Drizzle SQL migrations in `drizzle/`
(see `space.json.template` for the descriptor template).

Build, audit, and ship it only through the web-artifact builder interface your
session provides — the exact plan → build → audit → submit flow, how to edit or
inspect an existing artifact, and the schema/migration commands are all in your
builder instructions and the artifacts skill, which stay current if that
interface ever changes. Do not hand-edit the
built bundle under `.space-build/`, and do not `bun run build`: neither
publishes the artifact.

If you are not the builder subagent (for example, the main assistant landed
here), do not build from this directory. List the existing artifacts and
request a change by describing the edit — that spawns a builder to do the
work.

## Slug and directory

The artifact's catalog slug is a deploy-time variable: the platform generates
it at create time and the `create` API accepts no slug parameter. The builder
adopts source from `~/workspace/ts-spaces/<slug>/` — the directory name must
match the artifact's slug.

This git checkout lives at `~/workspace/github/dreveman/muse-code-space` and
is never modified by installation. For the web artifact, the installer stages
a snapshot of this checkout at `~/workspace/ts-spaces/<generated-slug>/` and
generates `space.json` there from `space.json.template` (with the
`__ARTIFACT_SLUG__` placeholder replaced). See
`docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md` for the full flow.

The display name ("Code Space") is independent of the slug and can change
freely via edit.

## Pilot (backend)

The `muse serve` pilot and credential relay that back this app's sessions
are sourced from `pilot/` in this repo and installed with
`pilot/install.sh` — see [docs/PILOT.md](docs/PILOT.md) for installation
and restart recovery. Never edit the live
copies under `~/workspace/muse-code-space-pilot` directly; change the repo
and reinstall. Sessions' GitHub access goes through the loopback broker in
`pilot/github_broker.py` (sentinel in sessions, real credential only at the
broker) — see the GitHub broker section of `docs/PILOT.md`.

## This artifact's data

This artifact's data lives in `app.db`, managed by the app: read it with the
artifact inspect data operations and change it through the app's own actions
(`artifact.invoke_action`) or an artifact edit, never by running sqlite or
scripts against the file.

## Repository portability

Keep committed content independent of the development machine. Asset catalogs
and documentation must reference committed repository assets, never local
generation directories, personal filesystem paths, or review artifacts. Before
committing, check references as well as the staged file list for these details.

The platform updates the local `@hatch/space-sdk` tarball in place. Keep its
file dependency, but omit only its integrity value from committed `bun.lock`.
Preserve all registry dependency pins and integrity values.
