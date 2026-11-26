#!/usr/bin/env bash
# Run a command in a private copy of the workspace, so what it writes (dist/, generated docs, build caches) never lands in the checkout the other steps of the workflow read.
# The copy holds every file of the checkout except node_modules and .git. Each node_modules directory (root, workspace packages, website) and .git are symlinked back to the original, so nothing is installed or fetched again. The copy is removed on exit.
# GATE_TREE_COPY_MODULES=1: hard-link a copy of each node_modules directory instead of symlinking it. Needed by the astro build: vite resolves a symlinked package to its real path outside the tree, and astro then looks that file up under the tree root ("No cached compile metadata found"). The copy goes in the parent of the checkout so it sits on the same filesystem and the hard links work; cp falls back to a plain copy if they do not.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "gate-private-tree: usage: gate-private-tree.sh <command> [args...]" >&2
  exit 2
fi

SRC="$PWD"
if [ "${GATE_TREE_COPY_MODULES:-}" = "1" ]; then
  TREE="$(mktemp -d "$SRC/../.gate-tree.XXXXXX" 2>/dev/null || mktemp -d)"
else
  TREE="$(mktemp -d)"
fi
trap 'rm -rf "$TREE"' EXIT

tar -C "$SRC" --exclude=node_modules --exclude=.git -cf - . | tar -C "$TREE" -xf -

(cd "$SRC" && find . -name node_modules -type d -prune -print) | while IFS= read -r DIR; do
  mkdir -p "$TREE/$(dirname "$DIR")"
  if [ "${GATE_TREE_COPY_MODULES:-}" = "1" ]; then
    cp -al "$SRC/$DIR" "$TREE/$DIR" 2>/dev/null || cp -a "$SRC/$DIR" "$TREE/$DIR"
  else
    ln -s "$SRC/$DIR" "$TREE/$DIR"
  fi
done
if [ -e "$SRC/.git" ]; then
  ln -s "$SRC/.git" "$TREE/.git"
fi

cd "$TREE"
STATUS=0
"$@" || STATUS=$?
exit "$STATUS"
