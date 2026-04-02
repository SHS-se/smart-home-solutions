#!/bin/bash
# Start the Vite development server in background
# Usage: ./dev.sh [db]
#   db: "test" (vxqpgbzseckgceopitpm) or "live" (oosxndduqzhvrorgogaw, default)

LOGFILE="./dev.log"

DB="${1:-live}"

case "$DB" in
  test)
    VITE_SUPABASE_PROJECT_ID="vxqpgbzseckgceopitpm"
    VITE_SUPABASE_URL="https://vxqpgbzseckgceopitpm.supabase.co"
    VITE_SUPABASE_PUBLISHABLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ4cXBnYnpzZWNrZ2Nlb3BpdHBtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNDE1NTgsImV4cCI6MjA4NzcxNzU1OH0.A56LvY0EnMHP3CulrnQH1MjfSfuejgC7xnrFZvKiOfc"
    ;;
  live)
    VITE_SUPABASE_PROJECT_ID="oosxndduqzhvrorgogaw"
    VITE_SUPABASE_URL="https://oosxndduqzhvrorgogaw.supabase.co"
    VITE_SUPABASE_PUBLISHABLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9vc3huZGR1cXpodnJvcmdvZ2F3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0NTEwMTQsImV4cCI6MjA5MDAyNzAxNH0.h9GcaZwI0JrwOKH2JKUS1jo-DiarYpV9yfe8JQdZl4g"
    ;;
  *)
    echo "Unknown db: $DB (use 'test' or 'live')"
    exit 1
    ;;
esac

echo "Using DB: $DB ($VITE_SUPABASE_PROJECT_ID)"

if lsof -ti:8080 > /dev/null 2>&1; then
    echo "⚠️  Dev server already running on port 8080"
    echo "Run './stop.sh' to stop it first"
    exit 1
fi

echo "Starting Vite dev server in background..."
echo "Logs: $LOGFILE"
echo ""

bash -c "source ~/.zprofile && VITE_SUPABASE_PROJECT_ID='$VITE_SUPABASE_PROJECT_ID' VITE_SUPABASE_URL='$VITE_SUPABASE_URL' VITE_SUPABASE_PUBLISHABLE_KEY='$VITE_SUPABASE_PUBLISHABLE_KEY' npm run dev" > "$LOGFILE" 2>&1 &
DEV_PID=$!

sleep 2

if lsof -ti:8080 > /dev/null 2>&1; then
    echo "✓ Dev server started successfully"
    echo "  URL: http://localhost:8080/"
    echo "  PID: $DEV_PID"
    echo ""
    echo "Commands:"
    echo "  ./stop.sh          - Stop the server"
    echo "  tail -f $LOGFILE   - Watch logs"
    echo "  ./logs.sh          - Watch logs (convenience script)"
else
    echo "✗ Failed to start dev server"
    echo "Check $LOGFILE for errors"
    exit 1
fi
