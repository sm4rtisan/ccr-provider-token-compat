#!/usr/bin/env bash
set -euo pipefail

version=$(node -p "require('./dist/plugin.json').version")
if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Expected a stable plugin version, got: $version" >&2
  exit 1
fi

tag="v$version"
release_exists() {
  gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1
}

if release_exists; then
  echo "$tag is already released."
  exit 0
fi

refs=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}")
tag_commit=$(awk -v ref="refs/tags/$tag" '
  $2 == ref { commit = $1 }
  $2 == ref "^{}" { peeled = $1 }
  END { print peeled ? peeled : commit }
' <<< "$refs")
if [[ -n $tag_commit && $tag_commit != "$GITHUB_SHA" ]]; then
  echo "$tag already points to a different commit. Use a new plugin version." >&2
  exit 1
fi

archive="dist/ccr-provider-token-compat-$tag.zip"
(cd dist && zip -q "${archive##*/}" index.cjs plugin.json index.cjs.sha256)
if ! gh release create "$tag" "$archive" dist/index.cjs dist/index.cjs.sha256 \
  --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --title "$tag" --generate-notes; then
  # Another run may have published this version after the initial check.
  release_exists || exit 1
fi
