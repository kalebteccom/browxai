#!/usr/bin/env bash
# Run a command in a private copy of the workspace, so what it writes (dist/, generated docs, build caches) never lands in the checkout the other steps of the workflow read.
# The copy holds every file of the checkout except node_modules and .git. Each node_modules directory (root, workspace packages, website) and .git are symlinked back to the original, so nothing is installed or fetched again. The copy is removed on exit.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "gate-private-tree: usage: gate-private-tree.sh <command> [args...]" >&2
  exit 2
fi

SRC="$PWD"
TREE="$(mktemp -d)"
trap 'rm -rf "$TREE"' EXIT

tar -C "$SRC" --exclude=node_modules --exclude=.git -cf - . | tar -C "$TREE" -xf -

(cd "$SRC" && find . -name node_modules -type d -prune -print) | while IFS= read -r DIR; do
  mkdir -p "$TREE/$(dirname "$DIR")"
  ln -s "$SRC/$DIR" "$TREE/$DIR"
done
if [ -e "$SRC/.git" ]; then
  ln -s "$SRC/.git" "$TREE/.git"
fi

cd "$TREE"
STATUS=0
"$@" || STATUS=$?
exit "$STATUS"
