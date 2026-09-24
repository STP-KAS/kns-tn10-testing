#!/usr/bin/env bash
# Chain KNS TN10 bulk batches without idle gaps. TN10 only; never touches mainnet/farm.
set -uo pipefail
ROOT=/workspace/artifacts/kns-tn10
API="$ROOT/api"
SCRIPT="$ROOT/scripts/kns-bulk-create.mjs"
LOG="$API/bulk-chain-resume-0751-3000.log"
cd "$ROOT"
echo "$(date -Is) chain start from=$1 to_end=$2" | tee -a "$LOG"
START=${1:-751}
END=${2:-3000}
BATCH=${3:-250}
DELAY_MS=${4:-12000}
cur=$START
while [ "$cur" -le "$END" ]; do
  to=$((cur + BATCH - 1))
  if [ "$to" -gt "$END" ]; then to=$END; fi
  echo "$(date -Is) batch --from $cur --to $to" | tee -a "$LOG"
  node "$SCRIPT" --from "$cur" --to "$to" --delay-ms "$DELAY_MS" --retries 3 --broadcast 1 \
    >> "$API/bulk-${cur}-${to}-stdout.txt" 2>&1
  rc=$?
  echo "$(date -Is) batch $cur-$to exit=$rc" | tee -a "$LOG"
  # continue even on partial fails so gaps can be backfilled later; next range still runs
  cur=$((to + 1))
done
echo "$(date -Is) chain complete through $END" | tee -a "$LOG"
