#!/usr/bin/env bash
# S3 progress: funded wallets, names created (of 50,000 = 10,000 x 3 [700-10699] + 10,000 x 2 [10700-20699]), failures, workers, treasury balance. No secrets.
OUT=/workspace/artifacts/kns-tn10/snapshot-wallets
API=/workspace/artifacts/kns-tn10/api
TOTAL_W=20000; TOTAL_N=50000
python3 - "$OUT" "$API" "$TOTAL_W" "$TOTAL_N" <<'PY'
import json, os, sys, glob
out, api, tw, tn = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
def rj(p, d=None):
    try: return json.load(open(p))
    except Exception: return d
f = rj(f"{out}/desk-fund-700-20699-status.json", {}) or {}
run = (f.get("runs") or [{}])[-1]
import re
n3 = n2 = 0
for n in os.listdir(api):
    m = re.match(r"smoke-result-stp-s3-w(\d{5})-d(\d)\.json$", n)
    if not m: continue
    w, d = int(m.group(1)), int(m.group(2))
    if 700 <= w <= 10699 and d <= 2: n3 += 1
    elif 10700 <= w <= 20699 and d <= 1: n2 += 1
names = n3 + n2
agg = dict(ok=0, failed=0, taken=0, attempts=0, attempt_errors=0, wallets_done=0, wallets_aborted=0)
for p in glob.glob(f"{out}/s3-status-*.json"):
    s = rj(p, {}) or {}
    for k in agg: agg[k] += int(s.get(k, 0) or 0)
sup = rj(f"{out}/s3-supervisor-state.json", {}) or {}
states = {}
for k, s in (sup.get("ranges") or {}).items(): states[s["state"]] = states.get(s["state"], 0) + 1
def alive(pid):
    try: os.kill(int(pid), 0); return True
    except Exception: return False
fp = open(f"{out}/desk-fund-700-20699.pid").read().strip() if os.path.exists(f"{out}/desk-fund-700-20699.pid") else None
sp = open(f"{out}/s3-supervisor.pid").read().strip() if os.path.exists(f"{out}/s3-supervisor.pid") else None
print(f"funded wallets     : {f.get('funded_total', 0)} / {tw}  (funder state={run.get('state')}, pid {fp} alive={alive(fp) if fp else False})")
print(f"  sent / fees / txs: {run.get('sent_tkas', 0)} TKAS / {run.get('fees_tkas', 0)} TKAS / {run.get('txs', 0)} txs this run")
print(f"names created      : {names} / {tn}  (3-name tier 700-10699: {n3}/30000, 2-name tier 10700-20699: {n2}/20000)")
print(f"worker counters    : ok={agg['ok']} failed={agg['failed']} taken={agg['taken']} attempts={agg['attempts']} attempt_errors={agg['attempt_errors']} wallets_done={agg['wallets_done']} wallets_aborted={agg['wallets_aborted']}")
err = agg['attempt_errors'] / agg['attempts'] if agg['attempts'] else 0
print(f"attempt error rate : {err:.1%}")
print(f"supervisor         : pid {sp} alive={alive(sp) if sp else False} max_workers={sup.get('max_workers')} running={sup.get('running')} ranges={states} stop_file={sup.get('stop_file')}")
PY
echo -n "treasury           : "; timeout 60 node /workspace/artifacts/kns-tn10/scripts/s3-treasury-balance.mjs 2>/dev/null | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print("{:,.2f} TKAS (via {})".format(d["treasury_tkas"], d["url"]))' || echo "rpc unavailable"
