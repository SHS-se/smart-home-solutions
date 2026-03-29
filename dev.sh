#!/bin/bash
# Start the Vite development server in background
# Usage: ./dev.sh [db]
#   db: "old" (pdqidiwovlvdyqgbdlda) or "new" (vxqpgbzseckgceopitpm, default)

LOGFILE="./dev.log"

DB="${1:-new}"

case "$DB" in
  old)
    VITE_SUPABASE_PROJECT_ID="pdqidiwovlvdyqgbdlda"
    VITE_SUPABASE_URL="https://pdqidiwovlvdyqgbdlda.supabase.co"
    VITE_SUPABASE_PUBLISHABLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBkcWlkaXdvdmx2ZHlxZ2JkbGRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzMDA3MTgsImV4cCI6MjA4NTg3NjcxOH0._QmRh8lDwEtvdCWetwmuecSff5OfItHMcqkXRXL3LpM"
    ;;
  new)
    VITE_SUPABASE_PROJECT_ID="vxqpgbzseckgceopitpm"
    VITE_SUPABASE_URL="https://vxqpgbzseckgceopitpm.supabase.co"
    VITE_SUPABASE_PUBLISHABLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ4cXBnYnpzZWNrZ2Nlb3BpdHBtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxNDE1NTgsImV4cCI6MjA4NzcxNzU1OH0.A56LvY0EnMHP3CulrnQH1MjfSfuejgC7xnrFZvKiOfc"
    ;;
  *)
    echo "Unknown db: $DB (use 'old' or 'new')"
    exit 1
    ;;
esac

echo "Using DB: $DB ($VITE_SUPABASE_PROJECT_ID)"

# Check if server is already running
if lsof -ti:8080 > /dev/null 2>&1; then
    echo "⚠️  Dev server already running on port 8080"
    echo "Run './stop.sh' to stop it first"
    exit 1
fi

echo "Starting Vite dev server in background..."
echo "Logs: $LOGFILE"
echo ""

# Start server in background, logging to file
# Source zprofile to ensure node/npm are available
bash -c "source ~/.zprofile && VITE_SUPABASE_PROJECT_ID='$VITE_SUPABASE_PROJECT_ID' VITE_SUPABASE_URL='$VITE_SUPABASE_URL' VITE_SUPABASE_PUBLISHABLE_KEY='$VITE_SUPABASE_PUBLISHABLE_KEY' npm run dev" > "$LOGFILE" 2>&1 &
DEV_PID=$!

# Wait a moment for server to start
sleep 2

# Check if it started successfully
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
