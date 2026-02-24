#!/bin/bash
# Start the Vite development server in background

LOGFILE="./dev.log"

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
bash -c 'source ~/.zprofile && npm run dev' > "$LOGFILE" 2>&1 &
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
