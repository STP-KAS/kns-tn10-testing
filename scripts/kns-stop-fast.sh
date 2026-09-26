#!/usr/bin/env bash
# --- guard (26 Sep): a fast relaunch is active on explicit user instruction; do not re-throttle without a new one
if [ -f /workspace/artifacts/kns-tn10/snapshot-wallets/FAST-RELAUNCH-ACTIVE ] && [ "${ALLOW_SLOW_SWITCH:-0}" != 1 ]; then
  echo "REFUSE: FAST-RELAUNCH-ACTIVE (user 26 Sep 07:43: relaunch + 7x fees). Set ALLOW_SLOW_SWITCH=1 only on a new explicit user instruction."; exit 9
fi
# Gracefully stop ALL fast KNS TN10 create runners (never SIGKILL, never mid commit/reveal), pid-agnostic.
#   kns-stop-fast.sh --dry-run   show what would be signalled (sends nothing)
#   kns-stop-fast.sh             do it, then wait (up to STOP_WAIT_S, default 900 s) until no create process remains
# Order: r1-STOP file + stop r1 watchdog -> kill bulk chain wrapper (no new batch) -> SIGTERM graceful pools
# (phase-a 0-6, snap pools, s3 pool: they finish the in-flight name) -> drain kns-bulk-create (SIGTERM only while it
# has no create child) -> wait. Leaves miners, kaspad, treasury/funding passes, monitors and kns-slow-runner alone.
set -uo pipefail
OUT=/workspace/artifacts/kns-tn10/snapshot-wallets; DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
WAIT=${STOP_WAIT_S:-900}
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }
slowpid=$(cat $OUT/slow-runner.pid 2>/dev/null || echo none)
# anchored: only processes whose argv is "[path/]node|bash [path/]<script>" (never an agent's `bash -c "..."` string)
p() { pgrep -f "^([^ ]*/)?(node|bash) ([^ ]*/)?($1)( |\$)" | grep -vx "$$" | grep -vx "$slowpid" || true; }
sig() { local s=$1; shift; for x in "$@"; do echo "$(ts) kill -$s $x  # $(ps -o args= -p $x 2>/dev/null | cut -c1-110)"; [ $DRY = 1 ] || kill -$s "$x" 2>/dev/null; done; }

echo "$(ts) === stop fast KNS runners (dry=$DRY)"
# 1) R1: stop file (worker finishes its current wallet then exits; watchdog exits; r1-fund-loop pauses after its pass)
echo "$(ts) touch $OUT/r1-STOP"; [ $DRY = 1 ] || touch $OUT/r1-STOP
sig TERM $(p 'r1-supervisor\.sh')                      # bash watchdog, would relaunch kns-snap-r1.mjs; no create of its own
sig TERM $(p 's3-supervisor\.mjs')                      # legacy s3 launcher (normally not running; s3-STOP already exists)
# 2) bulk chain: kill only the bash wrapper so no next batch starts (its current node batch keeps running, drained below)
sig TERM $(p 'kns-bulk-chain-resume\.sh')
# 3) graceful SIGTERM handlers (finish the in-flight create, then exit)
sig TERM $(p 'kns-snap-phase-a\.mjs') $(p 'kns-snap-pool\.mjs') $(p 'kns-s3-pool\.mjs')
# legacy s3 workers (spawn kns-s3-create per name): stop only between names
L=$(p 'kns-snap-s3\.mjs'); [ -n "$L" ] && { echo "$(ts) drain kns-snap-s3 workers: $L"; [ $DRY = 1 ] || bash /workspace/artifacts/kns-tn10/scripts/s3-drain-workers.sh $L & }
# 4) kns-bulk-create has NO signal handler: SIGTERM it only while it has no kns-smoke-create child (between labels)
for b in $(p 'kns-bulk-create\.mjs'); do
  echo "$(ts) drain kns-bulk-create $b (TERM when no create child)"
  [ $DRY = 1 ] && continue
  ( for i in $(seq 1 2400); do [ -d /proc/$b ] || exit 0
      if [ -z "$(pgrep -P $b)" ]; then sleep 0.3; [ -z "$(pgrep -P $b)" ] && { kill -TERM $b; echo "$(ts) drained kns-bulk-create $b"; exit 0; }; fi
      sleep 0.5; done; echo "$(ts) TIMEOUT draining $b" ) &
done
[ $DRY = 1 ] && { echo "$(ts) dry run: nothing sent"; exit 0; }
# 5) wait until nothing that can create remains
PAT='kns-bulk-chain-resume\.sh|kns-bulk-create\.mjs|kns-snap-phase-a\.mjs|kns-snap-pool\.mjs|kns-s3-pool\.mjs|kns-snap-r1\.mjs|r1-supervisor\.sh|kns-snap-s3\.mjs|s3-supervisor\.mjs|kns-(smoke|snap|s3)-create\.mjs'
t0=$(date +%s)
while :; do
  left=$(pgrep -af "^([^ ]*/)?(node|bash) ([^ ]*/)?($PAT)( |\$)" | grep -v -e "^$$ " -e "^$slowpid " || true)
  [ -z "$left" ] && { echo "$(ts) ALL fast create runners stopped ($(( $(date +%s)-t0 ))s)"; wait; exit 0; }
  if [ $(( $(date +%s)-t0 )) -ge $WAIT ]; then echo "$(ts) STILL ALIVE after ${WAIT}s (not killing; inspect logs):"; echo "$left"; exit 1; fi
  echo "$(ts) waiting ($(echo "$left" | wc -l) left): $(echo "$left" | awk '{print $1":"$3}' | tr '\n' ' ' | cut -c1-200)"
  sleep 20
done
