#!/usr/bin/env bash
# R1 progress (TN10): funded / created out of 5,000 (wallets 20700-25699, 1 name each), failures, workers, error rate, treasury. No secrets.
OUT=/workspace/artifacts/kns-tn10/snapshot-wallets
python3 - "$OUT" <<'PY'
import json, os, sys, glob, time
out = sys.argv[1]
def rj(p, d=None):
    try: return json.load(open(p))
    except Exception: return d
def alive(pid):
    try: os.kill(int(pid), 0); return True
    except Exception: return False
def pidf(n):
    try: return open(f"{out}/{n}").read().strip()
    except Exception: return None
f = rj(f"{out}/desk-fund-r1-status.json", {}) or {}
run = (f.get("runs") or [{}])[-1]
loop = rj(f"{out}/desk-fund-r1-loop-state.json", {}) or {}
done = [rj(p, {}) for p in glob.glob(f"{out}/r1-done/w*")]
failed = [rj(p, {}) for p in glob.glob(f"{out}/r1-failed/w*")]
gave_up = sum(1 for x in failed if (x or {}).get("passes", 0) >= 3)
lens = {}
for d in done: lens[d.get("length")] = lens.get(d.get("length"), 0) + 1
ws = rj(f"{out}/r1-worker-state.json", {}) or {}
wp, sp = pidf("r1-worker.pid"), pidf("r1-supervisor.pid")
lp = pidf("desk-fund-r1-loop.pid")
print(f"funded wallets     : {f.get('funded_total', 0)} / 5000   sent {f.get('sent_tkas_total', 0):,.2f} TKAS, fees {f.get('fees_tkas_total', 0):.4f}, txs {f.get('txs_total', 0)}, passes {f.get('passes', 0)}")
print(f"  last pass        : state={run.get('state')} at {run.get('finished_at') or run.get('run_id')} next_index={run.get('next_index')} next_need={run.get('next_need_tkas')} remaining_need={run.get('remaining_need_tkas')} million_reserve={run.get('million_reserve_tkas')}")
print(f"  fund loop        : pid {lp} alive={alive(lp) if lp else False} state={loop.get('state')} waiting_for={loop.get('waiting_for')}")
print(f"names created      : {len(done)} / 5000   by length {dict(sorted((k,v) for k,v in lens.items() if k))}")
print(f"failures           : wallets with failed passes={len(failed)} (gave up after 3 passes: {gave_up})")
a = ws.get('attempts', 0) or 0
print(f"worker counters    : ok={ws.get('ok',0)} failed={ws.get('failed',0)} renamed(taken)={ws.get('taken_renamed',0)} attempts={a} attempt_errors={ws.get('attempt_errors',0)} rate_limited/timeouts={ws.get('rate_limited',0)} indexer_errors={ws.get('indexer_errors',0)} rpc_reconnects={ws.get('rpc_reconnects',0)}")
w = ws.get("window") or {}
print(f"error rate         : total {(ws.get('attempt_errors',0)/a if a else 0):.1%}   last 30 min {w.get('rate', 0):.1%} ({w.get('errors', 0)}/{w.get('attempts', 0)}, rl={w.get('rate_limited', 0)})")
print(f"worker process     : pid {wp} alive={alive(wp) if wp else False} lanes running={ws.get('lanes_running')} target={ws.get('lanes_target')} ceiling={ws.get('ceiling')} backlog={ws.get('backlog')} rss={ws.get('rss_mb')}MB avail={ws.get('avail_mb')}MB rpc={ws.get('rpc_url')} backoff_until={ws.get('backoff_until')}")
print(f"watchdog           : pid {sp} alive={alive(sp) if sp else False}   stop file {out}/r1-STOP present={os.path.exists(out + '/r1-STOP')}")
PY
echo -n "treasury           : "; timeout 60 node /workspace/artifacts/kns-tn10/scripts/s3-treasury-balance.mjs 2>/dev/null | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print("{:,.2f} TKAS (via {})".format(d["treasury_tkas"], d["url"]))' || echo "rpc unavailable"
