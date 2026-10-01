#!/bin/bash
# Clean stop: touch STOP (runner stops starting names, finishes in-flight ones, exits). --hard also sends SIGTERM (same graceful drain).
D=/workspace/artifacts/kns-tn10/storm-2026-10-01; cd $D
touch STOP; echo "$(date -Is) STOP file written"
P=$(cat runner.pid 2>/dev/null); [ -z "$P" ] && exit 0
[ "${1:-}" = "--hard" ] && kill -TERM "$P" 2>/dev/null
for i in $(seq 1 150); do kill -0 "$P" 2>/dev/null || { echo "runner $P exited"; exit 0; }; sleep 1; done
echo "runner $P still draining after 150 s"; exit 1
