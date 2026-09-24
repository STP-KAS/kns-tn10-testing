#!/usr/bin/env bash
# R1 watchdog (bash, ~no memory): keeps exactly ONE kns-snap-r1.mjs process alive (it runs all lanes in-process).
# Relaunches it if it dies (max 30 relaunches), unless snapshot-wallets/r1-STOP exists or all wallets are finished.
# Never kills anything.
OUT=/workspace/artifacts/kns-tn10/snapshot-wallets; S=/workspace/artifacts/kns-tn10/scripts
echo $$ > $OUT/r1-supervisor.pid
echo 500 > /proc/self/oom_score_adj 2>/dev/null
n=0
while true; do
  if [ -f $OUT/r1-STOP ]; then echo "$(date -Is) stop file present, watchdog exiting"; exit 0; fi
  pid=$(cat $OUT/r1-worker.pid 2>/dev/null)
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    if [ -f $OUT/r1-worker-state.json ] && grep -q '"finished_at"' $OUT/r1-worker-state.json && [ "$(ls $OUT/r1-done | wc -l)" -ge 5000 ]; then echo "$(date -Is) all done"; exit 0; fi
    avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
    if [ "$avail" -lt 1000 ]; then echo "$(date -Is) worker down, waiting for memory (avail ${avail} MB)"; sleep 60; continue; fi
    n=$((n+1)); if [ $n -gt 30 ]; then echo "$(date -Is) too many relaunches, giving up"; exit 1; fi
    cd $S && setsid nohup node kns-snap-r1.mjs >> $OUT/r1-worker.stdout 2>&1 < /dev/null &
    echo "$(date -Is) launched worker pid $! (launch $n)"
    sleep 30
  fi
  sleep 60
done
