#!/usr/bin/env bash
# phase-a-rebalance.sh <stop ranges...> -- <start ranges...>   (ranges as F-T). Graceful stops, overlap-checked starts.
set -uo pipefail
OUT=/workspace/artifacts/kns-tn10/snapshot-wallets; S=/workspace/artifacts/kns-tn10/scripts
STOP=(); START=(); m=stop
for a in "$@"; do if [ "$a" = "--" ]; then m=start; elif [ $m = stop ]; then STOP+=("$a"); else START+=("$a"); fi; done
for r in "${STOP[@]}" "${START[@]}"; do [ "${r%-*}" -ge 7 ] || { echo "refuse $r"; exit 2; }; done
for r in "${STOP[@]}"; do
  P=$(tr -d '\n ' < "$OUT/phase-a-$r.pid" 2>/dev/null); f=${r%-*}; t=${r#*-}
  if [ -n "$P" ] && kill -0 "$P" 2>/dev/null && ps -o args= -p "$P" | grep -q -- "--wallet-from $f --wallet-to $t "; then kill -TERM "$P"; fi
done
for r in "${STOP[@]}"; do
  P=$(tr -d '\n ' < "$OUT/phase-a-$r.pid" 2>/dev/null)
  [ -n "$P" ] && for i in $(seq 1 400); do kill -0 "$P" 2>/dev/null || break; sleep 1; done
  [ -n "$P" ] && kill -0 "$P" 2>/dev/null && { echo "$(date -Is) ERROR $r still alive"; exit 3; }
  echo "$(date -Is) stopped $r ($(grep -o '"phase":"stopped","reason":"[a-zA-Z]*"' $OUT/phase-a-stdout-$r.log | tail -1))"
  [ -f "$OUT/phase-a-$r.pid" ] && mv "$OUT/phase-a-$r.pid" "$OUT/phase-a-$r.pid.retired-$(date +%H%M%S)"
done
for r in "${START[@]}"; do
  NF=${r%-*}; NT=${r#*-}
  for p in $(pgrep -f 'kns-snap-phase-a.mjs --wallet-from'); do
    a=$(ps -o args= -p $p | sed -n 's/.*--wallet-from \([0-9]*\) --wallet-to \([0-9]*\).*/\1 \2/p'); set -- $a
    [ -n "${1:-}" ] || continue
    if [ "$1" -le "$NT" ] && [ "$2" -ge "$NF" ]; then echo "$(date -Is) ERROR overlap pid=$p $1-$2 vs $r"; exit 4; fi
  done
  cd "$S"; setsid nohup node kns-snap-phase-a.mjs --wallet-from $NF --wallet-to $NT --domain-from 0 --domain-to 99 --delay-ms 12000 --broadcast 1 --retries 3 --fast-connect 1 >> "$OUT/phase-a-stdout-$NF-$NT.log" 2>&1 < /dev/null &
  echo $! > "$OUT/phase-a-$NF-$NT.pid"; echo "$(date -Is) launched $NF-$NT pid=$!"; sleep 2
done
