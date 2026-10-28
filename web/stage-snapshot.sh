#!/usr/bin/env bash
# stage-snapshot.sh — stage a web-build snapshot of this checkout for the
# Code Space artifact.
#
# Usage:
#   web/stage-snapshot.sh <artifact-slug>
#
# The artifact builder adopts source from ~/workspace/ts-spaces/<slug>/, so
# the snapshot directory name, the generated space.json slug, and the
# artifact's catalog slug must all match. This script is step 2b of
# docs/INSTALL_GUIDE_FOR_MUSE_ASSISTENT.md; it performs exactly the
# staging procedure that install testing proved out:
#
#   1. Clear the bootstrap files the artifact system created at the slug
#      path. The system may still be writing them, so retry once after a
#      short wait, and abort unless the directory is actually gone —
#      extracting over leftover bootstrap files makes the builder build
#      the placeholder instead of this source.
#   2. Extract a git archive of HEAD with only the web-build inputs
#      (client/, server/, drizzle/, companions/ and the root config
#      files). docs/, pilot/, dev/, hooks/ and icon.webp are excluded:
#      docs are human documentation, the pilot installs separately, and
#      the runtime owns the artifact icon (it deletes any staged icon.*
#      and restores its own; the repo icon is copied in after the final
#      build). companions/ IS a build input: client and server import
#      companions/catalog.json and the SOUL.md files directly.
#   3. Generate space.json from space.json.template with the slug
#      substituted for __ARTIFACT_SLUG__.
#
# The checkout is never modified: the snapshot comes from `git archive
# HEAD`, so a dirty working tree would silently stage committed state
# instead of what is on disk — the script refuses to run in that case.
#
# App data guard: the snapshot directory also holds the artifact's managed
# app.db, which `rm -rf` would destroy (2026-10-15: a routine re-stage
# silently reset the app to first-run state). Before clearing, an existing
# app.db is backed up with SQLite's online backup (WAL-safe) to
# ~/workspace/ts-spaces/.data-backups/<slug>-<timestamp>/ and restored into
# the fresh snapshot afterward. If the database exists but cannot be
# backed up, the script aborts before touching anything. This whole-file
# backup/restore is a host-level disaster guard only — never edit rows.
set -euo pipefail

slug="${1:-}"
if [[ -z "$slug" ]]; then
  echo "usage: $0 <artifact-slug>" >&2
  exit 2
fi
if [[ ! "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: invalid artifact slug: $slug" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$HOME/workspace/ts-spaces/$slug"

if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
  echo "error: checkout at $repo_root has uncommitted changes." >&2
  echo "Commit or stash first: the snapshot is taken from HEAD and must match the tree." >&2
  exit 1
fi

# 0. Preserve the artifact's database across the wipe (updates only).
BACKUP_DIR=""
if [[ -f "$dest/app.db" ]]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  BACKUP_DIR="$HOME/workspace/ts-spaces/.data-backups/${slug}-${stamp}"
  mkdir -p "$BACKUP_DIR"
  if ! python3 - "$dest/app.db" "$BACKUP_DIR/app.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True)
dst = sqlite3.connect(sys.argv[2])
try:
    src.backup(dst)
finally:
    dst.close()
    src.close()
PY
  then
    echo "error: could not back up $dest/app.db — aborting before clearing the snapshot." >&2
    echo "Your existing data is untouched at $dest/app.db. Resolve the backup failure and re-run." >&2
    exit 1
  fi
  if [[ ! -s "$BACKUP_DIR/app.db" ]]; then
    echo "error: backup of $dest/app.db produced an empty file — aborting before clearing the snapshot." >&2
    exit 1
  fi
  echo "backed up existing app database to $BACKUP_DIR/app.db"
fi

# 1. Clear bootstrap files (retry once; abort unless really gone).
rm -rf "$dest"
if [[ -e "$dest" ]]; then
  sleep 2
  rm -rf "$dest"
fi
if [[ -e "$dest" ]]; then
  echo "error: could not clear $dest — the artifact system may still be writing it." >&2
  exit 1
fi
mkdir -p "$dest"

# 2. Extract the web-build inputs from HEAD. git archive fails loudly if
#    a listed path is missing, so a renamed input cannot slip through.
git -C "$repo_root" archive HEAD -- \
  client server drizzle companions \
  package.json bun.lock bunfig.toml tsconfig.base.json space.json.template \
  | tar -x -C "$dest"

# 3. Generate space.json from the template.
sed "s/__ARTIFACT_SLUG__/$slug/g" "$dest/space.json.template" > "$dest/space.json"

# 4. Restore the preserved database into the fresh snapshot (updates only).
# The backup directory is retained for manual rollback; prune it by hand.
if [[ -n "$BACKUP_DIR" ]]; then
  cp "$BACKUP_DIR/app.db" "$dest/app.db"
  echo "restored app database from $BACKUP_DIR/app.db (backup retained at $BACKUP_DIR)"
fi

# Verify the snapshot is complete, self-consistent, and the checkout
# was not touched.
for f in space.json space.json.template package.json client server drizzle companions; do
  if [[ ! -e "$dest/$f" ]]; then
    echo "error: snapshot incomplete: missing $dest/$f" >&2
    exit 1
  fi
done
if ! grep -q "\"slug\": \"$slug\"" "$dest/space.json"; then
  echo "error: generated space.json does not carry slug \"$slug\"" >&2
  exit 1
fi
if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
  echo "error: checkout at $repo_root was modified during staging" >&2
  exit 1
fi


# Pin the staged bun.lock's @hatch/space-sdk integrity to the SDK tarball the
# staged package.json points at. Upstream ships that lockfile slot empty (the
# Pi extension's fallback install blanks it, because its fallback tarball is
# not the platform build), and the artifact builder cannot install a file:
# dependency with an empty integrity. Hashing whatever tarball is present at
# staging time keeps this correct across platform SDK re-spins; only the
# staged snapshot is modified, never the checkout.
_sdk_ref="$(grep -o '"@hatch/space-sdk": "file:[^"]*"' "$dest/package.json" | head -1 | sed 's/.*file://; s/"$//' || true)"
if [ -z "$_sdk_ref" ]; then
  # No @hatch/space-sdk file: dependency (a minimal fixture, or a tree that
  # does not use the SDK) — there is nothing to pin.
  echo "stage-snapshot: no @hatch/space-sdk file: dependency in $dest/package.json - nothing to pin"
elif [ ! -f "$_sdk_ref" ]; then
  echo "stage-snapshot: cannot locate the @hatch/space-sdk tarball referenced by $dest/package.json" >&2
  exit 1
else
_sdk_integrity="sha512-$(openssl dgst -sha512 -binary "$_sdk_ref" | openssl base64 -A)"
SDK_INTEGRITY="$_sdk_integrity" python3 - "$dest/bun.lock" <<'PYEOF2'
import os, re, sys
path = sys.argv[1]
integrity = os.environ["SDK_INTEGRITY"]
lines = open(path).read().splitlines(True)
for i, line in enumerate(lines):
    if '"@hatch/space-sdk": [' in line:
        lines[i], n = re.subn(r', "[^"]*"\],(\s*)$', ', "%s"],\\1' % integrity, line)
        if n:
            break
else:
    sys.exit("stage-snapshot: @hatch/space-sdk entry not found in " + path)
open(path, "w").write("".join(lines))
PYEOF2
grep -qF ""$_sdk_integrity"" "$dest/bun.lock" || { echo "stage-snapshot: failed to pin @hatch/space-sdk integrity in $dest/bun.lock" >&2; exit 1; }
echo "stage-snapshot: pinned @hatch/space-sdk integrity to $_sdk_integrity"
fi
echo "staged snapshot for slug \"$slug\" at $dest ($(find "$dest" -type f | wc -l) files)"
