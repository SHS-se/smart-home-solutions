#!/bin/bash
# dev.sh — Start the app locally against test or live Supabase
# Usage:
#   ./scripts/dev.sh [test|live]
#   ./scripts/dev.sh migrate [test|live]
#
# Fetches the anon key from the Supabase CLI, optionally deploys edge functions,
# writes a .env.local file, then starts Vite on the correct port.
# The linked Supabase project is kept on test unless a live command is requested.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOY_MODE="${DEPLOY_EDGE_FUNCTIONS:-auto}"
EDGE_FUNCTIONS_DIR=""
DEPLOY_STATE_FILE=""
EDGE_FUNCTION_FINGERPRINT=""
MISSING_REMOTE_EDGE_FUNCTIONS=""
REMOTE_FUNCTION_CHECK_ERROR=""

TEST_PROJECT_REF="vxqpgbzseckgceopitpm"
LIVE_PROJECT_REF="oosxndduqzhvrorgogaw"
COMMAND="serve"
ENV="test"

if [ "${1:-}" = "migrate" ]; then
  COMMAND="migrate"
  ENV="${2:-test}"
else
  ENV="${1:-test}"
fi

should_deploy_edge_functions() {
  case "$DEPLOY_MODE" in
    1|true|TRUE|yes|YES)
      return 0
      ;;
    0|false|FALSE|no|NO)
      return 1
      ;;
    auto|"")
      [ "$ENV" = "test" ]
      return
      ;;
    *)
      echo "✗ Invalid DEPLOY_EDGE_FUNCTIONS value: $DEPLOY_MODE"
      echo "  Use auto, true, or false."
      exit 1
      ;;
  esac
}

get_listening_pid() {
  lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
}

get_process_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

compute_edge_function_fingerprint() {
  (
    cd "$PROJECT_DIR"
    {
      find "$EDGE_FUNCTIONS_DIR" -type f
      printf '%s\n' "supabase/config.toml"
    } | sort | while read -r file; do
      printf '%s\n' "$file"
      shasum -a 256 "$file"
    done | shasum -a 256 | awk '{print $1}'
  )
}

list_local_edge_functions() {
  (
    cd "$PROJECT_DIR"
    for dir in "$EDGE_FUNCTIONS_DIR"/*; do
      [ -d "$dir" ] || continue
      name="$(basename "$dir")"
      [ "$name" = "_shared" ] && continue
      printf '%s\n' "$name"
    done | sort
  )
}

list_remote_edge_functions() {
  supabase functions list --project-ref "$PROJECT_REF" --output json 2>/dev/null \
    | python3 -c 'import json, sys
data = json.load(sys.stdin)
if isinstance(data, list):
    items = data
elif isinstance(data, dict):
    items = data.get("functions", [])
else:
    items = []
names = []
for item in items:
    if isinstance(item, dict):
        name = item.get("name") or item.get("slug") or item.get("function_name") or item.get("id")
        if isinstance(name, str) and name:
            names.append(name)
print("\n".join(sorted(set(names))))'
}

remote_edge_functions_are_synced() {
  MISSING_REMOTE_EDGE_FUNCTIONS=""
  REMOTE_FUNCTION_CHECK_ERROR=""

  LOCAL_EDGE_FUNCTIONS="$(list_local_edge_functions)"
  REMOTE_EDGE_FUNCTIONS="$(list_remote_edge_functions)" || {
    REMOTE_FUNCTION_CHECK_ERROR="Could not query remote functions"
    return 1
  }

  while IFS= read -r function_name; do
    [ -n "$function_name" ] || continue
    if ! printf '%s\n' "$REMOTE_EDGE_FUNCTIONS" | grep -Fxq "$function_name"; then
      if [ -n "$MISSING_REMOTE_EDGE_FUNCTIONS" ]; then
        MISSING_REMOTE_EDGE_FUNCTIONS="${MISSING_REMOTE_EDGE_FUNCTIONS}, "
      fi
      MISSING_REMOTE_EDGE_FUNCTIONS="${MISSING_REMOTE_EDGE_FUNCTIONS}${function_name}"
    fi
  done <<EOF
$LOCAL_EDGE_FUNCTIONS
EOF

  [ -z "$MISSING_REMOTE_EDGE_FUNCTIONS" ]
}

edge_functions_changed_since_last_deploy() {
  EDGE_FUNCTION_FINGERPRINT="$(compute_edge_function_fingerprint)"

  if [ ! -f "$DEPLOY_STATE_FILE" ]; then
    return 0
  fi

  LAST_DEPLOY_FINGERPRINT="$(cat "$DEPLOY_STATE_FILE")"
  [ "$EDGE_FUNCTION_FINGERPRINT" != "$LAST_DEPLOY_FINGERPRINT" ]
}

record_edge_function_deploy() {
  mkdir -p "$(dirname "$DEPLOY_STATE_FILE")"
  printf '%s\n' "$EDGE_FUNCTION_FINGERPRINT" > "$DEPLOY_STATE_FILE"
}

case "$ENV" in
  test)
    PROJECT_REF="$TEST_PROJECT_REF"
    PORT=3000
    ;;
  live|prod)
    PROJECT_REF="$LIVE_PROJECT_REF"
    PORT=3001
    ;;
  *)
    echo "Usage:"
    echo "  $0 [test|live]"
    echo "  $0 migrate [test|live]"
    exit 1
    ;;
esac

link_project() {
  echo "→ Linking Supabase CLI to $ENV ($PROJECT_REF)..."
  (
    cd "$PROJECT_DIR"
    supabase link --project-ref "$PROJECT_REF" --yes
  )
}

run_migrations() {
  link_project
  echo "→ Pushing database migrations to $ENV ($PROJECT_REF)..."
  (
    cd "$PROJECT_DIR"
    supabase db push --linked --yes
  )
}

SUPABASE_URL="https://${PROJECT_REF}.supabase.co"
EDGE_FUNCTIONS_DIR="supabase/functions"
DEPLOY_STATE_FILE="$PROJECT_DIR/supabase/.temp/dev-edge-functions-${PROJECT_REF}.sha"

if [ "$COMMAND" = "migrate" ]; then
  run_migrations
  exit 0
fi

link_project

EXISTING_PID="$(get_listening_pid "$PORT")"
if [ -n "$EXISTING_PID" ]; then
  EXISTING_CWD="$(get_process_cwd "$EXISTING_PID")"
  echo "✗ Port $PORT is already in use by PID $EXISTING_PID"
  if [ -n "$EXISTING_CWD" ]; then
    echo "  Working directory: $EXISTING_CWD"
    if [ "$EXISTING_CWD" != "$PROJECT_DIR" ]; then
      echo "  This is not the current checkout."
      echo "  Stop that server before starting this one."
      exit 1
    fi
  fi
  echo "  Stop the existing dev server or use a different port."
  exit 1
fi

if should_deploy_edge_functions; then
  if [ "$DEPLOY_MODE" = "auto" ] || [ -z "$DEPLOY_MODE" ]; then
    if edge_functions_changed_since_last_deploy; then
      if [ -f "$DEPLOY_STATE_FILE" ]; then
        echo "→ Edge functions changed since the last $ENV deploy; deploying..."
      else
        echo "→ No previous $ENV edge function deploy fingerprint found; deploying..."
      fi
      (
        cd "$PROJECT_DIR"
        supabase functions deploy --project-ref "$PROJECT_REF" --use-api --yes
      )
      record_edge_function_deploy
      echo "✓ Edge functions deployed"
    elif remote_edge_functions_are_synced; then
      echo "→ Edge functions unchanged since the last $ENV deploy; skipping deploy"
    else
      if [ -n "$MISSING_REMOTE_EDGE_FUNCTIONS" ]; then
        echo "→ Remote $ENV is missing edge functions: $MISSING_REMOTE_EDGE_FUNCTIONS"
        echo "  Deploying to sync missing functions..."
      else
        echo "→ Could not verify remote edge functions; deploying to be safe..."
      fi
      (
        cd "$PROJECT_DIR"
        supabase functions deploy --project-ref "$PROJECT_REF" --use-api --yes
      )
      record_edge_function_deploy
      echo "✓ Edge functions deployed"
    fi
  else
    EDGE_FUNCTION_FINGERPRINT="$(compute_edge_function_fingerprint)"
    echo "→ Deploying edge functions to $ENV ($PROJECT_REF)..."
    (
      cd "$PROJECT_DIR"
      supabase functions deploy --project-ref "$PROJECT_REF" --use-api --yes
    )
    record_edge_function_deploy
    echo "✓ Edge functions deployed"
  fi
  echo ""
elif [ "$ENV" = "live" ]; then
  echo "→ Skipping edge function deploy for live by default"
  echo "  Set DEPLOY_EDGE_FUNCTIONS=true to force it."
  echo ""
fi

echo "→ Fetching anon key for $ENV ($PROJECT_REF)..."
ANON_KEY=$(supabase projects api-keys --project-ref "$PROJECT_REF" --output json 2>/dev/null \
  | python3 -c "import sys,json; keys=json.load(sys.stdin); print(next(k['api_key'] for k in keys if k['name']=='anon'))")

if [ -z "$ANON_KEY" ]; then
  echo "✗ Could not fetch anon key. Make sure you're logged in: supabase login"
  exit 1
fi

echo "→ Writing .env.local for $ENV..."
cat > "$PROJECT_DIR/.env.local" <<EOF
VITE_SUPABASE_URL=${SUPABASE_URL}
VITE_SUPABASE_PUBLISHABLE_KEY=${ANON_KEY}
EOF

echo "→ Starting dev server on port $PORT..."
echo "   Open: http://localhost:${PORT}"
echo ""
cd "$PROJECT_DIR"
export NVM_DIR="$HOME/.nvm"
[ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && \. "/opt/homebrew/opt/nvm/nvm.sh"
npm run dev -- --port "$PORT"
