#!/usr/bin/env bash
# Deploy planning executors before callers. Preserve the preflight secret.
set -euo pipefail
PROJECT_REF="${1:?Usage: deploy-energy-planning.sh PROJECT_REF}"
cd "$(dirname "$0")/.."

HAS_SECRET="$(supabase secrets list --project-ref "$PROJECT_REF" --output json |
  python3 -c 'import json, sys; print("yes" if any(s["name"] == "ENERGY_PLANNING_SECRET" for s in json.load(sys.stdin)) else "no")')"
if [ "$HAS_SECRET" = "no" ]; then
  umask 077
  SECRET_DIR="$(mktemp -d)"
  trap 'rm -rf "$SECRET_DIR"' EXIT
  python3 - "$SECRET_DIR/env" <<'PY'
import pathlib, secrets, sys
pathlib.Path(sys.argv[1]).write_text("ENERGY_PLANNING_SECRET=" + secrets.token_hex(32) + "\n")
PY
  supabase secrets set --project-ref "$PROJECT_REF" --env-file "$SECRET_DIR/env"
fi

supabase functions deploy energy-optimisation-plan-step --project-ref "$PROJECT_REF" --use-api --yes

# The retired checkpoint endpoint must disappear from existing deployments too.
HAS_LEGACY_WORKER="$(supabase functions list --project-ref "$PROJECT_REF" --output json |
  python3 -c 'import json, sys; print("yes" if any(f["name"] == "energy-optimisation-planning-worker" for f in json.load(sys.stdin)) else "no")')"
if [ "$HAS_LEGACY_WORKER" = "yes" ]; then
  supabase functions delete energy-optimisation-planning-worker --project-ref "$PROJECT_REF" --yes
fi

# The removed schedule editor has no activation endpoint.
HAS_FIXED_PLAN="$(supabase functions list --project-ref "$PROJECT_REF" --output json |
  python3 -c 'import json, sys; print("yes" if any(f["name"] == "energy-optimisation-fixed-plan" for f in json.load(sys.stdin)) else "no")')"
if [ "$HAS_FIXED_PLAN" = "yes" ]; then
  supabase functions delete energy-optimisation-fixed-plan --project-ref "$PROJECT_REF" --yes
fi
