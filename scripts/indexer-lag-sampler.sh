#!/bin/bash
# Read-only: samples KNS TN10 indexer lag every 5 min until the stress window ends (09:46 CEST 26 Sep).
OUT=/workspace/artifacts/kns-tn10/snapshot-wallets/indexer-lag-2026-09-26.jsonl
END=$(date -d '2026-09-26 09:46' +%s)
while [ "$(date +%s)" -lt "$END" ]; do
  t0=$(date +%s%3N)
  body=$(curl -s -m 25 -w '\n%{http_code}' https://api.knsdomains.org/tn10/api/v1/stp-snap-w007-d000.kas/owner)
  code=$(echo "$body" | tail -1); msg=$(echo "$body" | head -1 | tr -d '\n' | cut -c1-300)
  ng=$(echo "$msg" | grep -oP 'NG \(\K[0-9]+'); dag=$(echo "$msg" | grep -oP 'BlockDag \(\K[0-9]+')
  lag=""; [ -n "$ng" ] && lag=$((dag-ng))
  echo "{\"at\":\"$(date -Is)\",\"http\":$code,\"ms\":$(( $(date +%s%3N)-t0 )),\"ng\":\"$ng\",\"dag\":\"$dag\",\"lag\":\"$lag\"}" >> $OUT
  sleep 300
done
