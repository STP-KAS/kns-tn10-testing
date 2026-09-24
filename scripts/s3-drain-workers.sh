#!/usr/bin/env bash
# Gracefully stop my s3 workers (pids given) only at a safe point: when they have no create child running
# (i.e. between names, never mid commit/reveal). Used to swap in the memory-throttled worker code.
for p in "$@"; do
  (
    for i in $(seq 1 600); do
      [ -d /proc/$p ] || exit 0
      if [ "$(pgrep -P $p | wc -l)" = "0" ]; then kill -TERM $p && echo "$(date -Is) drained $p"; exit 0; fi
      sleep 0.5
    done
    echo "$(date -Is) timeout $p"
  ) &
done
wait
