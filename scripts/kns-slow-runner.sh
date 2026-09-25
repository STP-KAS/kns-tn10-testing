#!/usr/bin/env bash
# KNS TN10 SLOW runner: continues the S3 queue (stp-s3-w{700..20699}-d{n}, snapshot wallets, all funded) at
# <= 2 domain creates per rolling 10 minutes, by exec'ing the existing kns-s3-pool.mjs with ONE lane and a
# 300 s pause after every name. Resume state = api/smoke-result-<label>.json (labels with a revealId are skipped);
# stranded commits for a label are reused, never duplicated. TN10 only. Loads no keys itself (kns-s3-pool does, in memory).
#
#   kns-slow-runner.sh --check        preflight only (blocking processes, pending count, next labels). Sends nothing.
#   kns-slow-runner.sh --pace         pacing report: creates in the last 10 min (all families) + gaps of the slow run.
#   kns-slow-runner.sh [--holdoff-s N] RUN (foreground; start it detached with setsid nohup, see SWITCH-TO-SLOW.md).
#        Waits until no smoke-result artifact is younger than N s (default 300) so the switch-over window also stays
#        <= 2 creates / 10 min, then exec's node (the pid in slow-runner.pid IS the node process).
# Stop (graceful, finishes the in-flight name): kill -TERM "$(cat /workspace/artifacts/kns-tn10/snapshot-wallets/slow-runner.pid)"
# No auto-restart: this script never loops/relaunches.
set -uo pipefail
ROOT=/workspace/artifacts/kns-tn10; S=$ROOT/scripts; OUT=$ROOT/snapshot-wallets; API=$ROOT/api
WF=700; WT=20699; LANES=1; DELAY_MS=300000; RETRIES=3
PIDF=$OUT/slow-runner.pid; LOCK=$OUT/slow-runner.lock; POOL=$S/kns-s3-pool.mjs
MODE=run; HOLDOFF=300
while [ $# -gt 0 ]; do case "$1" in
  --check) MODE=check;; --pace) MODE=pace;; --holdoff-s) HOLDOFF=${2:?}; shift;;
  *) echo "unknown arg $1"; exit 2;; esac; shift; done
ts() { date '+%Y-%m-%dT%H:%M:%S%z'; }

# Any fast/other KNS create runner or restarter still alive? (escaped dots: the pattern never matches this shell's own argv)
PAT='kns-bulk-chain-resume\.sh|kns-bulk-create\.mjs|kns-snap-phase-a\.mjs|kns-snap-pool\.mjs|kns-s3-pool\.mjs|kns-snap-r1\.mjs|r1-supervisor\.sh|kns-snap-s3\.mjs|s3-supervisor\.mjs|phase-a-launch-when-funded\.mjs|kns-(smoke|snap|s3)-create\.mjs'
# anchored: only "[path/]node|bash [path/]<script>" processes, never an agent's `bash -c "..."` command string
blockers() { pgrep -af "^([^ ]*/)?(node|bash) ([^ ]*/)?($PAT)( |\$)" | grep -v -e "^$$ " || true; }

pending_report() {
  node -e '
    const fs=require("fs"),A="/workspace/artifacts/kns-tn10/api";let p=0,n=[];
    for(let w=700;w<=20699;w++)for(let d=0;d<(w<=10699?3:2);d++){const l=`stp-s3-w${String(w).padStart(5,"0")}-d${d}`;
      let ok=false;try{ok=!!JSON.parse(fs.readFileSync(`${A}/smoke-result-${l}.json`,"utf8")).revealId}catch{}
      if(!ok){p++;if(n.length<5)n.push(l)}}
    console.log(JSON.stringify({s3_pending:p,s3_total:50000,next_labels:n,est_days_at_1_per_5min:+(p*5.3/1440).toFixed(1)}))'
}

guard_pool_code() {  # the pacing argument depends on these lines of kns-s3-pool.mjs; refuse if they changed
  local okc=0
  grep -q 'const DELAY = Number(arg("--delay-ms"' "$POOL" && okc=$((okc+1))
  grep -q 'const LANES = Number(arg("--lanes"' "$POOL" && okc=$((okc+1))
  grep -q 'saveStatus();$' "$POOL" && grep -q '^    await sleep(DELAY);$' "$POOL" && okc=$((okc+1))
  grep -q 'process.on(s, () => {' "$POOL" && grep -q '"SIGTERM"' "$POOL" && okc=$((okc+1))
  [ "$okc" = 4 ] || { echo "$(ts) REFUSE: kns-s3-pool.mjs pacing/SIGTERM code changed (guard $okc/4) - re-verify before running"; return 1; }
  echo "$(ts) pool code guard OK sha256=$(sha256sum "$POOL" | cut -c1-16)"
}

pace_report() {
  local n10; n10=$(find "$API" -maxdepth 1 -name 'smoke-result-*.json' -mmin -10 | wc -l)
  echo "$(ts) creates (smoke-result artifacts, ALL families) in last 10 min: $n10  (cap 2)"
  find "$API" -maxdepth 1 -name 'smoke-result-*.json' -mmin -30 -printf '%TY-%Tm-%Td %TH:%TM:%.2TS  %f\n' | sort | tail -8
  if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "slow runner alive pid=$(cat "$PIDF") $(ps -o etime=,args= -p "$(cat "$PIDF")")"; else echo "slow runner NOT running"; fi
  local b; b=$(blockers | grep -v -e "^$(cat "$PIDF" 2>/dev/null) " || true); [ -n "$b" ] && { echo "OTHER create runners alive:"; echo "$b"; }
  tail -c 400000 "$OUT/s3-pool-$WF-$WT.jsonl" 2>/dev/null | node -e '
    const since=Date.now()-3*3600e3;const rows=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(j=>j&&Date.parse(j.at)>=since);
    const c=rows.filter(j=>j.phase==="created").map(j=>Date.parse(j.at));const gaps=c.slice(1).map((t,i)=>Math.round((t-c[i])/1000));
    const f=rows.filter(j=>j.phase==="attempt_failed").length;
    let maxIn10=0;for(let i=0;i<c.length;i++){let k=0;for(let j=i;j<c.length&&c[j]-c[i]<600000;j++)k++;maxIn10=Math.max(maxIn10,k)}
    console.log(JSON.stringify({s3_created_last_3h:c.length,s3_failed_attempts_last_3h:f,last_gaps_s:gaps.slice(-6),max_created_in_any_10min_window_3h:maxIn10}))'
}

case $MODE in
  pace) pace_report; exit 0;;
  check)
    echo "$(ts) slow-runner preflight (no transactions)"
    guard_pool_code || true
    b=$(blockers); if [ -n "$b" ]; then echo "BLOCKED - create runners still alive:"; echo "$b"; else echo "no create runners alive"; fi
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "slow runner already running pid=$(cat "$PIDF")"; fi
    pending_report
    echo "would exec: node $POOL --wallet-from $WF --wallet-to $WT --lanes $LANES --delay-ms $DELAY_MS --retries $RETRIES"
    [ -z "$b" ]; exit $?;;
esac

# ---- RUN
exec 9>"$LOCK"
flock -n 9 || { echo "$(ts) REFUSE: another slow runner holds $LOCK"; exit 3; }
guard_pool_code || exit 4
b=$(blockers); if [ -n "$b" ]; then echo "$(ts) REFUSE: create runners still alive:"; echo "$b"; exit 5; fi
while :; do
  young=$(find "$API" -maxdepth 1 -name 'smoke-result-*.json' -newermt "-${HOLDOFF} seconds" | wc -l)
  [ "$young" = 0 ] && break
  echo "$(ts) holdoff: $young create(s) in the last ${HOLDOFF}s, waiting 30s"; sleep 30
  b=$(blockers); if [ -n "$b" ]; then echo "$(ts) REFUSE: create runners alive during holdoff:"; echo "$b"; exit 5; fi
done
pending_report
echo $$ > "$PIDF"
echo "$(ts) SLOW START pid=$$ exec node kns-s3-pool.mjs --wallet-from $WF --wallet-to $WT --lanes $LANES --delay-ms $DELAY_MS --retries $RETRIES"
cd "$S" && exec node "$POOL" --wallet-from "$WF" --wallet-to "$WT" --lanes "$LANES" --delay-ms "$DELAY_MS" --retries "$RETRIES"
