#!/usr/bin/env bash
set -euo pipefail

# Preserve the runner paths so builds, reports and Git checkouts are visible to
# the surrounding Actions steps. Use the runner UID for generated files.
mkdir -p "$RUNNER_TEMP/shs-ci-home" "$RUNNER_TEMP/shs-ci-deno"
docker run --rm --ipc=host --user "$(id -u):$(id -g)" \
  --volume "$GITHUB_WORKSPACE:$GITHUB_WORKSPACE" \
  --volume "$RUNNER_TEMP:$RUNNER_TEMP" \
  --workdir "$GITHUB_WORKSPACE" \
  --env "HOME=$RUNNER_TEMP/shs-ci-home" \
  --env "DENO_DIR=$RUNNER_TEMP/shs-ci-deno" \
  --env CI --env GITHUB_ACTIONS --env GITHUB_WORKSPACE --env GITHUB_REF_NAME \
  --env RUNNER_TEMP --env CONTRACT_BASE --env SHS_SHARD \
  "$SHS_CI_IMAGE" bash -euc '
    if [ ! -L node_modules ]; then ln -s /opt/shs-ci/node_modules node_modules; fi
    exec "$@"
  ' shs-ci "$@"
