#!/usr/bin/env python3
"""Export public KNS TN10 create results to results/inscriptions.csv.

Reads api/smoke-result-*.json from the test box artifact dir (default
/workspace/artifacts/kns-tn10). Those files hold only public data:
domain, payer address, commit/reveal tx ids, inscription id, fee, time.
No keys are read or written.

Usage: python3 scripts/export-results-csv.py [SRC_DIR] [OUT_CSV]
"""
import csv, glob, json, os, sys

src = sys.argv[1] if len(sys.argv) > 1 else "/workspace/artifacts/kns-tn10"
out = sys.argv[2] if len(sys.argv) > 2 else "results/inscriptions.csv"
FIELDS = ["domain", "run", "payer_address", "commit_txid", "reveal_txid", "inscription_id", "fee_tkas", "created_at_utc"]
ALLOWED = {"domain", "payer", "commitId", "revealId", "inscriptionId", "feeKas", "p2shAddress", "at", "via", "run"}

def run_of(d, j):
    for p, r in (("stp-bulk-", "bulk"), ("stp-snap-", "snapshot-phase-a"), ("stp-s3-", "s3"), ("stp-smoke-", "smoke")):
        if d.startswith(p):
            return r
    return j.get("run") or "other"

rows = []
for f in glob.glob(os.path.join(src, "api", "smoke-result-*.json")):
    j = json.load(open(f))
    extra = set(j) - ALLOWED
    if extra:
        raise SystemExit(f"unexpected fields {extra} in {f}; refusing to export")
    if not j.get("revealId"):
        continue
    rows.append([j["domain"], run_of(j["domain"], j), j["payer"], j["commitId"], j["revealId"], j["inscriptionId"], j["feeKas"], j["at"]])
rows.sort(key=lambda r: (r[7], r[0]))
os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
with open(out, "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(FIELDS)
    w.writerows(rows)
print(f"{len(rows)} rows -> {out}")
