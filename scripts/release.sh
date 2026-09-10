#!/usr/bin/env bash
# Cut a browxai release: verify, sign the tag, push. Publishing itself happens
# in .github/workflows/release.yml behind the `release` deployment environment —
# this script never runs `npm publish`, which AGENTS.md forbids locally.
#
#   ./scripts/release.sh            # version from package.json
#   ./scripts/release.sh v0.10.0    # explicit, must match package.json
#   DRY_RUN=1 ./scripts/release.sh  # run every check, stop before tagging
#
# Everything before the tag is reversible. The tag push is not: it triggers the
# publish workflow, and npm versions cannot be truly unpublished after 72h.

set -euo pipefail

cd "$(dirname "$0")/.."

die() {
  printf '\n\033[31mrelease: %s\033[0m\n' "$1" >&2
  exit 1
}
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

PKG_VERSION="$(node -p "require('./package.json').version")"
TAG="${1:-v$PKG_VERSION}"
[ "$TAG" = "v$PKG_VERSION" ] || die "tag $TAG does not match package.json version $PKG_VERSION"

step "Preconditions"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on branch '$BRANCH' — releases are cut from main"

[ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash first"

git fetch --quiet origin main
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse "@{u}")"
[ "$LOCAL" = "$REMOTE" ] || die "local main and origin/main differ — pull or push first"

# An existing tag is only fatal when that version actually shipped. A tag whose
# release run died before the publish job is a dead marker no consumer can have,
# and burning a version number on a CI bug is worse than reusing it.
TAG_LOCAL=false
TAG_REMOTE=false
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && TAG_LOCAL=true
git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1 && TAG_REMOTE=true

if [ "$TAG_LOCAL" = true ] || [ "$TAG_REMOTE" = true ]; then
  PKG_NAME="$(node -p "require('./package.json').name")"
  if npm view "$PKG_NAME@$PKG_VERSION" version >/dev/null 2>&1; then
    die "$PKG_NAME@$PKG_VERSION is already published — bump the version, never retag a released one"
  fi
  printf '\033[33mtag %s exists but %s@%s is NOT on the registry — the previous run never published.\033[0m\n' \
    "$TAG" "$PKG_NAME" "$PKG_VERSION"
  read -r -p "Delete the dead tag and re-cut it here? [y/N] " retag
  [ "$retag" = "y" ] || die "aborted — bump the version, or delete the tag yourself"
  [ "$TAG_LOCAL" = true ] && git tag -d "$TAG"
  [ "$TAG_REMOTE" = true ] && git push --delete origin "$TAG"
fi

grep -q "^## v${PKG_VERSION} " CHANGELOG.md ||
  die "CHANGELOG.md has no '## v$PKG_VERSION' section — promote '## Unreleased' first"

grep -q "^## Unreleased" CHANGELOG.md &&
  printf '\033[33mnote: CHANGELOG.md still has an "## Unreleased" section — fine if it is empty\033[0m\n'

# The ritual requires a signed tag. Fail here rather than after the gate has
# spent ten minutes, and fail loudly: an unsigned release tag is not a release.
step "Signing"
git config --get user.signingkey >/dev/null || die "no user.signingkey configured — cannot sign the tag"
printf 'signing format: %s\n' "$(git config --get gpg.format || echo openpgp)"
git tag -s "$TAG-signing-probe" -m probe >/dev/null 2>&1 || {
  git tag -d "$TAG-signing-probe" >/dev/null 2>&1 || true
  die "signing probe failed — is your SSH/GPG agent unlocked? (1Password users: approve the prompt)"
}
git tag -d "$TAG-signing-probe" >/dev/null

step "Quality gate (RELEASING.md step 1)"
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm audit --prod --audit-level=high

step "Keystone — a hard prerequisite, real browsers"
pnpm test:keystone

step "Docs site"
pnpm docs:build

step "Plugin versions"
# A changed plugin must be hand-bumped in the same commit; the publish job skips
# versions already on the registry, so a stale version silently ships nothing.
PREV_TAG="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || echo '')"
if [ -n "$PREV_TAG" ] && ! git diff --quiet "$PREV_TAG"..HEAD -- packages/plugins/; then
  printf '\033[33mplugins changed since %s — confirm each package.json#version was bumped:\033[0m\n' "$PREV_TAG"
  git diff --name-only "$PREV_TAG"..HEAD -- packages/plugins/ | sed 's/^/  /'
  grep -H '"version"' packages/plugins/*/package.json | sed 's/^/  /'
  read -r -p "Plugin versions correct? [y/N] " ok
  [ "$ok" = "y" ] || die "aborted — bump the plugin versions and re-run"
else
  echo "no plugin changes since ${PREV_TAG:-<no previous tag>}"
fi

if [ "${DRY_RUN:-}" = "1" ]; then
  step "DRY_RUN — everything passed, stopping before the tag"
  echo "Re-run without DRY_RUN=1 to tag and push $TAG."
  exit 0
fi

step "Tag and push — this is the irreversible step"
echo "About to sign $TAG at $(git rev-parse --short HEAD) and push it to origin."
echo "That triggers .github/workflows/release.yml, which publishes to npm once you"
echo "approve the 'release' environment."
read -r -p "Proceed? [y/N] " go
[ "$go" = "y" ] || die "aborted — nothing was tagged or pushed"

git tag -s "$TAG" -m "$TAG"
git push origin main --tags

step "Pushed. What happens next"
cat <<EOF
1. Watch the run:      gh run watch --exit-status \$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')
2. Approve the 'release' environment in the Actions UI when it prompts.
   Nothing publishes until you do.
3. Verify from a clean machine:
     npm install browxai@$PKG_VERSION
     npm audit signatures
4. Cut the GitHub Release from $TAG, pasting the CHANGELOG section.
   The workflow attaches sbom.cdx.json.
     gh release create $TAG --title "$TAG" --notes-file <(awk '/^## v${PKG_VERSION} /{f=1;next}/^## v/{f=0}f' CHANGELOG.md)
5. Restart any running browxai MCP daemons — they hold the old dist/ in memory.
EOF
