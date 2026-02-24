#!/bin/bash
# Stop the Vite development server

echo "Stopping Vite dev server..."

# Find the process running on port 8080
PID=$(lsof -ti:8080)

if [ -z "$PID" ]; then
    echo "No dev server running on port 8080"
    exit 0
fi

echo "Found server process: $PID"
kill $PID

# Wait a moment and verify
sleep 1

if ! lsof -ti:8080 > /dev/null 2>&1; then
    echo "✓ Dev server stopped successfully"
else
    echo "⚠️  Process still running, forcing..."
    kill -9 $PID
    echo "✓ Dev server force-stopped"
fi
