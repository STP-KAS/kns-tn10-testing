#!/bin/bash
# one explorer snapshot: screenshot + parsed counters -> jsonl
ts=$(date +%H%M); shot=/workspace/artifacts/kns-tn10/explorer-tn10-$ts.png
out=$(cd /tmp/kv && timeout 110 python3 cdp.py https://tn10.kaspa.stream/ $shot 40 2>/dev/null | sed -n '/=====TEXT=====/,$p')
python3 - "$shot" <<PY
import re,json,sys,datetime
t="""$(echo "$out" | head -120 | tr -d '"\\')"""
def g(label,after=1):
    L=t.split("\n")
    for i,l in enumerate(L):
        if l.strip()==label: return L[i+after].strip()
r={"at":datetime.datetime.now().astimezone().isoformat(timespec="seconds"),"tps":g("TPS"),"tps_1h":g("TPS",2),"mempool":g("Mempool"),"bps":g("BPS"),"kns_last_hour":g("KNS"),"covenants_last_hour":g("Covenants"),"screenshot":sys.argv[1]}
print(json.dumps(r)); open("/workspace/artifacts/kns-tn10/snapshot-wallets/explorer-snaps-2026-09-26.jsonl","a").write(json.dumps(r)+"\n")
PY
