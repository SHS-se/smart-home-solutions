#!/usr/bin/env bash
set -euo pipefail

target=$1
key=$2
repository="ghcr.io/$(printf '%s' "$GITHUB_REPOSITORY" | tr '[:upper:]' '[:lower:]')-ci-$target"
tag="$repository:$key"

inspect() {
  docker buildx imagetools inspect "$tag" --format '{{ .Manifest.Digest }}'
}

if ! digest=$(inspect 2>&1); then
  case "$digest" in
    *'not found'*|*'manifest unknown'*|*'name unknown'*) ;;
    *) printf '%s\n' "$digest" >&2; exit 1 ;;
  esac
  bash .github/ci-images/build.sh "$target" "$tag"
  docker push "$tag"
  digest=$(inspect)
fi
if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  printf 'Unexpected registry digest for %s: %s\n' "$tag" "$digest" >&2
  exit 1
fi
printf '%s=%s@%s\n' "$target" "$repository" "$digest" >> "$GITHUB_OUTPUT"
