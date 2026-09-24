#!/usr/bin/env bash
# Re-split one Phase A range into ~CHUNK-wallet workers. TN10 only. Never touches 0-6 job (phase-a.pid).
# Usage: phase-a-resplit.sh <from> <to> [chunk=10]
set -uo pipefail
F=$1; T=$2; CHUNK=${3:-10}
OUT=/workspace/artifacts/kns-tn10/snapshot-wallets; S=/workspace/artifacts/kns-tn10/scripts; API=/workspace/artifacts/kns-tn10/api
[ "$F" -ge 7 ] || { echo "refuse: range touches 0-6"; exit 2; }
PIDF=$OUT/phase-a-$F-$T.pid
ts() { date -Is; }
if [ -f "$PIDF" ]; then
  P=$(tr -d '\n ' < "$PIDF")
  if kill -0 "$P" 2>/dev/null && ps -o args= -p "$P" | grep -q "kns-snap-phase-a.mjs --wallet-from $F --wallet-to $T "; then
    # wait for the idle gap between creates (no child in flight) so no commit/reveal is interrupted
    for i in $(seq 1 600); do [ -z "$(ps -o pid= --ppid "$P" | tr -d ' ')" ] && break; sleep 0.5; done
    KIDS=$(ps -o pid= --ppid "$P" | tr -d ' ' | tr '\n' ' ')
    [ -n "$KIDS" ] && { echo "$(ts) ERROR $F-$T never idle; not stopping"; exit 5; }
    KLABELS=$(for k in $KIDS; do ps -o args= -p $k | sed -n 's/.*--label \([^ ]*\).*/\1/p'; done | tr '\n' ' ')
    echo "$(ts) stop $F-$T pid=$P inflight_children=[$KIDS] labels=[$KLABELS]"
    kill -TERM "$P"
    for i in $(seq 1 60); do kill -0 "$P" 2>/dev/null || break; sleep 1; done
    kill -0 "$P" 2>/dev/null && { echo "$(ts) ERROR parent $P still alive"; exit 3; }
    for k in $KIDS; do for i in $(seq 1 300); do kill -0 "$k" 2>/dev/null || break; sleep 1; done; kill -0 "$k" 2>/dev/null && { echo "$(ts) ERROR child $k still running after 300s"; exit 3; }; done
    for L in $KLABELS; do
      CL=$API/snap-child-$L.log
      c=$(grep -c '"phase":"commit"' "$CL" 2>/dev/null || true); r=$(grep -c '"phase":"reveal"' "$CL" 2>/dev/null || true)
      a=$([ -f "$API/smoke-result-$L.json" ] && echo yes || echo no)
      echo "$(ts) inflight $L commit=$c reveal=$r artifact=$a"
    done
  else
    echo "$(ts) old worker $F-$T not running"
  fi
  mv "$PIDF" "$PIDF.retired-$(date +%H%M%S)"
fi
# any other stray phase-a worker overlapping? refuse
for p in $(pgrep -f 'kns-snap-phase-a.mjs --wallet-from'); do
  a=$(ps -o args= -p $p | sed -n 's/.*--wallet-from \([0-9]*\) --wallet-to \([0-9]*\).*/\1 \2/p'); set -- $a
  [ -n "${1:-}" ] || continue
  if [ "$1" -le "$T" ] && [ "$2" -ge "$F" ]; then echo "$(ts) ERROR overlapping worker pid=$p range=$1-$2"; exit 4; fi
done
f=$F
while [ "$f" -le "$T" ]; do
  t=$((f + CHUNK - 1)); [ $((T - t)) -lt $((CHUNK / 2)) ] && t=$T; [ "$t" -gt "$T" ] && t=$T
  cd "$S"
  setsid nohup node kns-snap-phase-a.mjs --wallet-from $f --wallet-to $t --domain-from 0 --domain-to 99 --delay-ms 12000 --broadcast 1 --retries 3 --fast-connect 1 \
    >> "$OUT/phase-a-stdout-$f-$t.log" 2>&1 < /dev/null &
  echo $! > "$OUT/phase-a-$f-$t.pid"
  echo "$(ts) launched $f-$t pid=$!"
  sleep 3
  f=$((t + 1))
done
