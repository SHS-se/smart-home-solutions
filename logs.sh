#!/bin/bash
# Watch the dev server logs

LOGFILE="./dev.log"

if [ ! -f "$LOGFILE" ]; then
    echo "No log file found. Is the dev server running?"
    echo "Run './dev.sh' to start the server"
    exit 1
fi

echo "Watching dev server logs (Ctrl+C to exit)..."
echo ""
tail -f "$LOGFILE"
