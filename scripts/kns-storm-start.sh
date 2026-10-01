#!/bin/bash
# Start the KNS TN10 storm runner. Requires the literal argument GO (only after stp/parent says GO).
# Usage: ./start.sh GO [rate<=30] [max-hours]
set -u
D=/workspace/artifacts/kns-tn10/storm-2026-10-01; cd $D
[ "${1:-}" = "GO" ] || { echo "refusing: pass GO as first argument (explicit approval required)"; exit 3; }
RATE=${2:-30}; HOURS=${3:-24}
if [ -f runner.pid ] && kill -0 "$(cat runner.pid)" 2>/dev/null; then echo "already running pid $(cat runner.pid)"; exit 1; fi
[ -f STOP ] && { echo "removing old STOP file"; rm -f STOP; }
KNS_STORM_GO=1 KNS_SKIP_INDEXER=1 nohup node kns-storm-runner.mjs --broadcast 1 --owner-mode "${OWNER_MODE:-payer}" --rate "$RATE" --max-hours "$HOURS" >> runner-stdout.log 2>&1 &
echo $! > runner.pid; echo 500 > /proc/$!/oom_score_adj
sleep 3; kill -0 $! 2>/dev/null && echo "started pid $! rate=$RATE/min max_hours=$HOURS" || { echo "runner exited early:"; tail -5 runner-stdout.log; exit 1; }
