#!/usr/bin/env python3
"""Trickle watchdog (run under nice). Every 15 s: reads new lines of events.jsonl, status.json, /proc/meminfo and disk free; writes control.json.
Halve rate_scale (floor 1/16, at most once per 60 s) if: sampled mempool-exit p90 (last 2 min) > 30 s, rejects/errors > 5/min (last 2 min),
MemAvailable < 2 GB, or free disk on /workspace < 20 GB. Double back (max 1.0) after 5 healthy minutes since the last change/unhealthy tick.
Fee margin: if dust < 400 TKAS -> 1.5 (from 3.0); back to the base margin once dust > 2000 TKAS (top-up landed). Logs changes to watchdog.jsonl."""
import json, os, time, shutil, sys, datetime
D = "/workspace/artifacts/kns-tn10/trickle-2026-10-02"; EV = f"{D}/events.jsonl"; CTL = f"{D}/control.json"; LOG = f"{D}/watchdog.jsonl"
BASE_MARGIN = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
ERR = {"commit_rejected", "reveal_rejected", "tx_uncertain", "build_failed", "reveal_failed_pending", "topup_fanout_rejected", "still_in_mempool_30min"}
def now(): return datetime.datetime.now().astimezone().isoformat(timespec="seconds")
def log(o): open(LOG, "a").write(json.dumps({"at": now(), **o}) + "\n")
def write_ctl(c): open(CTL + ".tmp", "w").write(json.dumps(c) + "\n"); os.replace(CTL + ".tmp", CTL)
def memavail():
    for l in open("/proc/meminfo"):
        if l.startswith("MemAvailable:"): return int(l.split()[1]) / 1048576
ctl = {"rate_scale": 1.0, "feerate_margin": BASE_MARGIN, "reason": "start"}
try: ctl.update(json.load(open(CTL)))
except Exception: pass
write_ctl(ctl); pos = os.path.getsize(EV) if os.path.exists(EV) else 0; exits = []; errs = []; last_change = time.time(); last_bad = 0.0; stop_since = None
log({"phase": "watchdog_start", "pid": os.getpid(), **ctl})
while True:
    if os.path.exists(f"{D}/STOP"):
        stop_since = stop_since or time.time()
        if time.time() - stop_since > 180: log({"phase": "watchdog_stop", "reason": "STOP file present > 3 min"}); break
    else: stop_since = None
    try:
        with open(EV) as f:
            f.seek(pos); data = f.read(); 
        cut = data.rfind("\n") + 1; pos += len(data[:cut].encode()); t = time.time()
        for l in data[:cut].splitlines():
            try: e = json.loads(l)
            except Exception: continue
            ph = e.get("phase", "")
            if ph in ("commit_left_mempool", "reveal_left_mempool"): exits.append((t, e["since_submit_ms"]))
            elif ph in ERR: errs.append(t)
            elif ph == "runner_stop": pass
    except FileNotFoundError: pass
    t = time.time(); exits = [x for x in exits if t - x[0] < 120]; errs = [x for x in errs if t - x < 120]
    ex = sorted(v for _, v in exits); p90 = ex[min(len(ex) - 1, int(0.9 * len(ex)))] / 1000 if ex else None
    err_pm = len(errs) / 2; mem = memavail(); disk = shutil.disk_usage("/workspace").free / 2**30
    try: st = json.load(open(f"{D}/status.json")); dust = st.get("dust_left_tkas"); alive = st.get("finished_at") is None or time.time() - os.path.getmtime(f"{D}/status.json") < 300
    except Exception: dust, alive = None, True
    bad = [k for k, v in (("mempool_exit_p90>30s", p90 is not None and p90 > 30), ("rejects>5/min", err_pm > 5), ("ram<2GB", mem < 2), ("disk<20GB", disk < 20)) if v]
    m = {"exit_p90_s": p90, "exit_n": len(ex), "err_per_min": err_pm, "mem_avail_gb": round(mem, 2), "disk_free_gb": round(disk, 2), "dust_tkas": dust}
    changed = None
    if bad:
        last_bad = t
        if ctl["rate_scale"] > 0.0625 and t - last_change >= 60: ctl["rate_scale"] = max(0.0625, ctl["rate_scale"] / 2); changed = "halve: " + ",".join(bad)
    elif ctl["rate_scale"] < 1 and t - max(last_change, last_bad) >= 300: ctl["rate_scale"] = min(1.0, ctl["rate_scale"] * 2); changed = "step up after 5 healthy min"
    if dust is not None:
        if dust < 400 and ctl["feerate_margin"] > 1.5: ctl["feerate_margin"] = 1.5; changed = (changed + "; " if changed else "") + "dust<400 -> margin 1.5"
        elif dust > 2000 and ctl["feerate_margin"] != BASE_MARGIN: ctl["feerate_margin"] = BASE_MARGIN; changed = (changed + "; " if changed else "") + f"dust>2000 -> margin {BASE_MARGIN}"
    if changed: last_change = t; ctl["reason"] = changed; write_ctl(ctl); log({"phase": "control", **ctl, **m})
    elif int(t) % 300 < 15: log({"phase": "tick", **ctl, **m, "bad": bad})
    if not alive and t - last_change > 60: log({"phase": "watchdog_stop", "reason": "runner finished"}); break
    time.sleep(15)
