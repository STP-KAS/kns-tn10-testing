#!/usr/bin/env bash
# Merge adjacent Phase A workers: phase-a-merge.sh <newFrom> <newTo> "<f1>-<t1>" "<f2>-<t2>" ...
# Stops each listed worker gracefully (SIGTERM; new code finishes in-flight create), then launches one worker for newFrom-newTo.
set -uo pipefail
NF=$1; NT=$2; shift 2
OUT=/workspace/artifacts/kns-tn10/snapshot-wallets; S=/workspace/artifacts/kns-tn10/scripts
[ "$NF" -ge 7 ] || { echo refuse; exit 2; }
for r in "$@"; do
  P=$(tr -d '\n ' < "$OUT/phase-a-$r.pid"); f=${r%-*}; t=${r#*-}
  if kill -0 "$P" 2>/dev/null && ps -o args= -p "$P" | grep -q -- "--wallet-from $f --wallet-to $t "; then
    kill -TERM "$P"; for i in $(seq 1 400); do kill -0 "$P" 2>/dev/null || break; sleep 1; done
    kill -0 "$P" 2>/dev/null && { echo "$(date -Is) ERROR $r pid $P still alive"; exit 3; }
    for k in $(pgrep -f "kns-snap-create.mjs --label stp-snap-w" ); do :; done
    echo "$(date -Is) stopped $r pid=$P ($(grep -o '"phase":"stopped"[^}]*' $OUT/phase-a-stdout-$r.log | tail -1))"
  fi
  mv "$OUT/phase-a-$r.pid" "$OUT/phase-a-$r.pid.retired-$(date +%H%M%S)"
done
for p in $(pgrep -f 'kns-snap-phase-a.mjs --wallet-from'); do
  a=$(ps -o args= -p $p | sed -n 's/.*--wallet-from \([0-9]*\) --wallet-to \([0-9]*\).*/\1 \2/p'); set -- $a
  [ -n "${1:-}" ] || continue
  if [ "$1" -le "$NT" ] && [ "$2" -ge "$NF" ]; then echo "$(date -Is) ERROR overlap pid=$p $1-$2"; exit 4; fi
done
cd "$S"; setsid nohup node kns-snap-phase-a.mjs --wallet-from $NF --wallet-to $NT --domain-from 0 --domain-to 99 --delay-ms 12000 --broadcast 1 --retries 3 --fast-connect 1 >> "$OUT/phase-a-stdout-$NF-$NT.log" 2>&1 < /dev/null &
echo $! > "$OUT/phase-a-$NF-$NT.pid"; echo "$(date -Is) launched $NF-$NT pid=$!"
