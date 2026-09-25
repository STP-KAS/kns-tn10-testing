#!/usr/bin/env bash
# When all Phase A 7-699 pools (kns-snap-pool.mjs) have exited, gracefully restart the s3 pool with more lanes
# (Phase A frees ~145 names/min of the shared indexer budget). One-shot. Log: snapshot-wallets/s3-ramp-after-phase-a.log
OUT=/workspace/artifacts/kns-tn10/snapshot-wallets; S=/workspace/artifacts/kns-tn10/scripts; LANES=${1:-40}
exec >> $OUT/s3-ramp-after-phase-a.log 2>&1
echo "$(date -Is) waiting for Phase A pools to finish; will set s3 lanes=$LANES"
while pgrep -f 'kns-snap-pool\.mjs --wallet-from' >/dev/null; do sleep 60; done
[ -f $OUT/s3-STOP-POOL ] && { echo "$(date -Is) s3-STOP-POOL present; not ramping"; exit 0; }
P=$(cat $OUT/s3-pool-700-20699.pid)
if kill -0 $P 2>/dev/null; then kill -TERM $P; for i in $(seq 1 300); do kill -0 $P 2>/dev/null || break; sleep 1; done; fi
kill -0 $P 2>/dev/null && { echo "$(date -Is) ERROR s3 pool $P did not stop"; exit 1; }
cd $S; setsid nohup node kns-s3-pool.mjs --wallet-from 700 --wallet-to 20699 --lanes $LANES --delay-ms 12000 --retries 3 >> $OUT/s3-stdout-pool-700-20699.log 2>&1 < /dev/null &
echo $! > $OUT/s3-pool-700-20699.pid; echo "$(date -Is) restarted s3 pool lanes=$LANES pid=$!"
