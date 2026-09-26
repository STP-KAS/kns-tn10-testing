#!/bin/bash
# Usage: scale-relaunch.sh <phaseA_lanes> <phaseA_delay_ms> <s3_lanes> <s3_delay_ms>
# Gracefully stops the Phase A 7-699 and s3 pools and relaunches with KNS_SKIP_INDEXER=1, KNS_FEE_MULT=7.
set -u
D=/workspace/artifacts/kns-tn10; S=$D/snapshot-wallets; cd $D/scripts
PA=$(cat $S/phase-a-pool-7-699.pid); S3=$(cat $S/s3-pool-700-20699.pid)
kill -TERM $PA $S3 2>/dev/null
for i in $(seq 1 150); do kill -0 $PA 2>/dev/null || kill -0 $S3 2>/dev/null || break; sleep 2; done
kill -0 $PA 2>/dev/null && echo "WARN phaseA still running"; kill -0 $S3 2>/dev/null && echo "WARN s3 still running"
export KNS_FEE_MULT=7 KNS_SKIP_INDEXER=1
nohup node kns-snap-pool.mjs --wallet-from 7 --wallet-to 699 --lanes $1 --domain-from 0 --domain-to 99 --delay-ms $2 --broadcast 1 --retries 3 >> $S/phase-a-stdout-pool-7-699.log 2>&1 &
echo $! > $S/phase-a-pool-7-699.pid; echo 500 > /proc/$!/oom_score_adj
nohup node kns-s3-pool.mjs --wallet-from 700 --wallet-to 20699 --lanes $3 --delay-ms $4 --retries 3 >> $S/s3-stdout-pool-700-20699.log 2>&1 &
echo $! > $S/s3-pool-700-20699.pid; echo 500 > /proc/$!/oom_score_adj
echo "{\"at\":\"$(date -Is)\",\"step\":\"relaunch\",\"phaseA_pid\":$(cat $S/phase-a-pool-7-699.pid),\"phaseA_lanes\":$1,\"phaseA_delay\":$2,\"s3_pid\":$(cat $S/s3-pool-700-20699.pid),\"s3_lanes\":$3,\"s3_delay\":$4,\"skip_indexer\":1}" | tee -a $S/scale-steps-2026-09-26.jsonl
