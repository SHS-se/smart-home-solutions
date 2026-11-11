#!/usr/bin/env bash
set -euo pipefail

target=$1
tag=$2
playwright_version=$(jq -er '.packages["node_modules/playwright"].version' package-lock.json)
docker build --file .github/ci-images/Dockerfile --target "$target" --tag "$tag" \
  --build-arg "PLAYWRIGHT_VERSION=$playwright_version" \
  --label "org.opencontainers.image.source=https://github.com/$GITHUB_REPOSITORY" .
