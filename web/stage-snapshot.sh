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

echo "staged snapshot for slug \"$slug\" at $dest ($(find "$dest" -type f | wc -l) files)"
