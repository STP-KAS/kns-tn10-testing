#!/usr/bin/env bash
# phase-a-pool-start.sh <from> <to> <lanes>  - start (or restart gracefully) a Phase A pool for the range; refuses overlaps.
set -uo pipefail
F=$1; T=$2; L=$3
OUT=/workspace/artifacts/kns-tn10/snapshot-wallets; S=/workspace/artifacts/kns-tn10/scripts
[ "$F" -ge 7 ] || { echo refuse; exit 2; }
PF=$OUT/phase-a-pool-$F-$T.pid
if [ -f "$PF" ] && kill -0 "$(cat $PF)" 2>/dev/null; then
  P=$(cat $PF); kill -TERM $P; for i in $(seq 1 300); do kill -0 $P 2>/dev/null || break; sleep 1; done
  kill -0 $P 2>/dev/null && { echo "ERROR pool $P still alive"; exit 3; }; echo "$(date -Is) stopped pool $F-$T pid=$P"
fi
for p in $(pgrep -f 'kns-snap-(phase-a|pool)\.mjs --wallet-from'); do
  a=$(ps -o args= -p $p | sed -n 's/.*--wallet-from \([0-9]*\) --wallet-to \([0-9]*\).*/\1 \2/p'); set -- $a
  [ -n "${1:-}" ] || continue
  if [ "$1" -le "$T" ] && [ "$2" -ge "$F" ]; then echo "$(date -Is) ERROR overlap pid=$p $1-$2"; exit 4; fi
done
cd $S; setsid nohup node kns-snap-pool.mjs --wallet-from $F --wallet-to $T --lanes $L --domain-from 0 --domain-to 99 --delay-ms 12000 --broadcast 1 --retries 3 >> $OUT/phase-a-stdout-pool-$F-$T.log 2>&1 < /dev/null &
echo $! > $PF; echo "$(date -Is) launched pool $F-$T lanes=$L pid=$!"
