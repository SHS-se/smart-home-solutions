#!/bin/bash
# dev.sh — Start the app locally against test or live Supabase
# Usage: ./scripts/dev.sh [test|live]
#
# Fetches the anon key from the Supabase CLI, optionally deploys edge functions,
# writes a .env.local file, then starts Vite on the correct port.

set -e

ENV="${1:-test}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DEPLOY_MODE="${DEPLOY_EDGE_FUNCTIONS:-auto}"

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

case "$ENV" in
  test)
    PROJECT_REF="vxqpgbzseckgceopitpm"
    PORT=3000
    ;;
  live|prod)
    PROJECT_REF="oosxndduqzhvrorgogaw"
    PORT=3001
    ;;
  *)
    echo "Usage: $0 [test|live]"
    exit 1
    ;;
esac

SUPABASE_URL="https://${PROJECT_REF}.supabase.co"

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
  echo "→ Deploying edge functions to $ENV ($PROJECT_REF)..."
  (
    cd "$PROJECT_DIR"
    supabase functions deploy --project-ref "$PROJECT_REF" --use-api --yes
  )
  echo "✓ Edge functions deployed"
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
