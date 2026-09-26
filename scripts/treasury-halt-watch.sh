#!/bin/bash
# Halts all KNS TN10 jobs cleanly once the treasury balance reads < 100,000 TKAS. Checks every ~60s.
# Self-terminates at 09:47 CEST 26 Sep (end of stress window). Never touches the miner farm / kaspad / keepalives.
D=/workspace/artifacts/kns-tn10; S=$D/snapshot-wallets; LOG=$S/treasury-halt.log; FLOOR=100000
END=$(date -d '2026-09-26 09:47' +%s)
echo "$(date -Is) watch start floor=$FLOOR pid=$$" >> $LOG
while [ "$(date +%s)" -lt "$END" ]; do
  bal=$(cd $D/scripts && timeout 50 node treasury-balance.mjs 2>/dev/null | tail -1)
  echo "{\"at\":\"$(date -Is)\",\"treasury_tkas\":\"$bal\"}" >> $S/treasury-watch.jsonl
  if [[ "$bal" =~ ^[0-9.]+$ ]] && awk -v b="$bal" -v f=$FLOOR 'BEGIN{exit !(b<f)}'; then
    echo "$(date -Is) HALT treasury=$bal TKAS < $FLOOR" >> $LOG
    touch $S/s3-STOP-POOL $S/s3-STOP $S/r1-STOP $S/r1-FUND-STOP
    # supervisors/loops first so nothing respawns, then workers (SIGTERM = finish current name)
    for pat in '^bash (\./)?r1-supervisor\.sh' '^bash kns-bulk-chain-resume\.sh' '^node r1-fund-loop\.mjs' 'node /workspace/artifacts/kns-tn10/scripts/treasury-fund-r1\.mjs' \
               '^node kns-snap-pool\.mjs' '^node kns-s3-pool\.mjs' '^node kns-snap-r1\.mjs' 'kns-bulk-create\.mjs --from' '^node scripts/kns-snap-phase-a\.mjs'; do
      for p in $(pgrep -f "$pat"); do echo "$(date -Is) SIGTERM $p $(tr '\0' ' ' </proc/$p/cmdline 2>/dev/null | cut -c1-120)" >> $LOG; kill -TERM $p 2>/dev/null; done
    done
    echo "$(date -Is) halt complete treasury=$bal" >> $LOG
    exit 0
  fi
  sleep 60
done
echo "$(date -Is) watch window ended (no halt)" >> $LOG
