#!/usr/bin/env python3
"""TN10 KNS storm ownership verify — /assets only, paced, resumable."""
from __future__ import annotations

import asyncio
import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Brussels")
BASE = "https://api.knsdomains.org/tn10/api/v1"
OUT_DIR = "/workspace/artifacts/kns-tn10/snapshot-wallets"
NAMES_PATH = os.path.join(OUT_DIR, "ownership-verify-storm-names-2026-09-26.jsonl")
RESULTS_PATH = os.path.join(OUT_DIR, "ownership-verify-results-2026-09-26.jsonl")
SUMMARY_PATH = os.path.join(OUT_DIR, "ownership-verify-summary-2026-09-26.json")
PROGRESS_PATH = os.path.join(OUT_DIR, "ownership-verify-progress-2026-09-26.jsonl")
CHECKPOINT_PATH = os.path.join(OUT_DIR, "ownership-verify-checkpoint-2026-09-26.json")
OWNER_CACHE_PATH = os.path.join(OUT_DIR, "ownership-verify-owner-assets-cache-2026-09-26.jsonl")

TARGET_RPS = 2.0  # CF-safe; stay under ~250/min
CONCURRENCY = 1
MAX_RETRIES = 8
PAGE_SIZE = 100
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
EXTRA_HEADERS = {
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://knsdomains.org/",
    "Origin": "https://knsdomains.org",
}

# shared rate limiter
_last_req = 0.0
_req_lock: asyncio.Lock | None = None
request_count = 0
request_count_lock: asyncio.Lock | None = None


def now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def progress(msg: str, **extra: Any) -> None:
    rec = {"at": now_iso(), "msg": msg, **extra}
    with open(PROGRESS_PATH, "a") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    print(json.dumps(rec), flush=True)


async def rate_wait() -> None:
    global _last_req, _req_lock
    if _req_lock is None:
        _req_lock = asyncio.Lock()
    async with _req_lock:
        min_interval = 1.0 / TARGET_RPS
        now = time.monotonic()
        wait = min_interval - (now - _last_req)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_req = time.monotonic()


async def http_json(method: str, url: str, body: dict | None = None) -> tuple[int, Any]:
    """Return (status, parsed_json_or_text). Retries on 429/5xx with backoff."""
    global request_count, request_count_lock
    if request_count_lock is None:
        request_count_lock = asyncio.Lock()

    data = None
    headers = {"User-Agent": UA, **EXTRA_HEADERS}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"

    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES):
        await rate_wait()
        async with request_count_lock:
            request_count += 1
            rc = request_count

        def _do() -> tuple[int, Any]:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            try:
                with urllib.request.urlopen(req, timeout=45) as resp:
                    raw = resp.read()
                    try:
                        return resp.status, json.loads(raw.decode())
                    except Exception:
                        return resp.status, raw.decode(errors="replace")[:500]
            except urllib.error.HTTPError as e:
                raw = e.read() if e.fp else b""
                try:
                    parsed = json.loads(raw.decode()) if raw else {"error": str(e)}
                except Exception:
                    parsed = {"error": raw.decode(errors="replace")[:500] or str(e)}
                return e.code, parsed
            except Exception as e:
                raise e

        try:
            status, payload = await asyncio.to_thread(_do)
        except Exception as e:
            last_err = e
            await asyncio.sleep(min(30, (2 ** attempt) + random.random()))
            continue

        if status == 403:
            # Cloudflare challenge — long cool-down
            backoff = min(180, 30 * (attempt + 1) + random.random() * 5)
            progress("cf_403_backoff", attempt=attempt, backoff=round(backoff,1), request_count=request_count)
            if attempt == MAX_RETRIES - 1:
                return status, payload
            await asyncio.sleep(backoff)
            continue
        if status == 429 or status >= 500:
            # tip-lag / rate limit — backoff
            backoff = min(90, (2 ** attempt) * (2 if status == 429 else 1) + random.random())
            if attempt == MAX_RETRIES - 1:
                return status, payload
            await asyncio.sleep(backoff)
            continue
        return status, payload

    return 0, {"error": str(last_err) if last_err else "unknown"}


def load_names() -> list[dict]:
    rows = []
    with open(NAMES_PATH) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_checkpoint() -> dict:
    if os.path.exists(CHECKPOINT_PATH):
        with open(CHECKPOINT_PATH) as f:
            return json.load(f)
    return {
        "done_payers": [],
        "phase": "owners",
        "started_at": now_iso(),
        "followup_done": False,
        "classify_done": False,
    }


def save_checkpoint(cp: dict) -> None:
    cp["updated_at"] = now_iso()
    tmp = CHECKPOINT_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cp, f)
    os.replace(tmp, CHECKPOINT_PATH)


def append_owner_cache(payer: str, assets: list[dict]) -> None:
    # assets: list of {asset, owner}
    with open(OWNER_CACHE_PATH, "a") as f:
        f.write(
            json.dumps(
                {"payer": payer, "assets": assets, "at": now_iso()},
                separators=(",", ":"),
            )
            + "\n"
        )


def load_owner_cache() -> dict[str, list[dict]]:
    cache: dict[str, list[dict]] = {}
    if not os.path.exists(OWNER_CACHE_PATH):
        return cache
    with open(OWNER_CACHE_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            cache[rec["payer"]] = rec["assets"]
    return cache


async def fetch_owner_assets(payer: str) -> tuple[str, list[dict] | None, str | None]:
    """Paginate /assets?owner=... Return (payer, assets_or_None, error)."""
    all_assets: list[dict] = []
    page = 1
    total_pages = 1
    while page <= total_pages:
        qs = urllib.parse.urlencode(
            {
                "owner": payer,
                "type": "domain",
                "page": page,
                "pageSize": PAGE_SIZE,
            }
        )
        url = f"{BASE}/assets?{qs}"
        status, payload = await http_json("GET", url)
        if status != 200 or not isinstance(payload, dict) or not payload.get("success"):
            return payer, None, f"http_{status}:{payload}"
        data = payload.get("data") or {}
        assets = data.get("assets") or []
        pag = data.get("pagination") or {}
        total_pages = int(pag.get("totalPages") or 1) or 1
        for a in assets:
            asset = a.get("asset") or ""
            owner = a.get("owner") or ""
            if asset:
                if not asset.endswith(".kas"):
                    asset = asset + ".kas"
                all_assets.append({"asset": asset, "owner": owner})
        page += 1
        if page > 200:  # safety
            return payer, None, "too_many_pages"
    return payer, all_assets, None


async def fetch_asset_owner(domain: str) -> tuple[str | None, str | None]:
    """assets?asset=domain → (owner_or_None, error_or_None). Empty assets = missing."""
    qs = urllib.parse.urlencode({"asset": domain, "pageSize": 5})
    url = f"{BASE}/assets?{qs}"
    status, payload = await http_json("GET", url)
    if status != 200 or not isinstance(payload, dict) or not payload.get("success"):
        return None, f"http_{status}:{payload}"
    data = payload.get("data") or {}
    assets = data.get("assets") or []
    if not assets:
        return None, None  # missing / not found
    # prefer exact match
    for a in assets:
        asset = a.get("asset") or ""
        if not asset.endswith(".kas") and asset:
            asset = asset + ".kas"
        if asset == domain:
            return a.get("owner") or "", None
    # fallback first
    return (assets[0].get("owner") or ""), None


async def domains_check(domains: list[str], address: str) -> dict[str, dict] | None:
    """POST /domains/check batches of <=100. Returns domain->info or None on error."""
    body = {"domainNames": domains, "address": address}
    status, payload = await http_json("POST", f"{BASE}/domains/check", body)
    if status != 200 or not isinstance(payload, dict) or not payload.get("success"):
        return None
    data = payload.get("data") or {}
    out = {}
    for d in data.get("domains") or []:
        dom = d.get("domain") or ""
        if dom and not dom.endswith(".kas"):
            dom = dom + ".kas"
        out[dom] = d
    return out


async def phase_fetch_owners(names: list[dict], cp: dict) -> dict[str, list[dict]]:
    by_payer: dict[str, list[dict]] = defaultdict(list)
    for n in names:
        by_payer[n["payer"]].append(n)

    done = set(cp.get("done_payers") or [])
    cache = load_owner_cache()
    # ensure done payers are in cache
    for p in list(done):
        if p not in cache:
            # was marked done but cache missing — refetch
            done.discard(p)

    payers = sorted(by_payer.keys())
    remaining = [p for p in payers if p not in done]
    progress(
        "phase_owners_start",
        total_payers=len(payers),
        already_done=len(done),
        remaining=len(remaining),
        request_count=request_count,
    )

    sem = asyncio.Semaphore(CONCURRENCY)
    lock = asyncio.Lock()
    errors: list[str] = []

    async def one(payer: str) -> None:
        async with sem:
            p, assets, err = await fetch_owner_assets(payer)
            async with lock:
                if err or assets is None:
                    errors.append(f"{payer[:24]}…:{err}")
                    # still checkpoint as attempted-fail so we can retry later
                    # do NOT mark done
                else:
                    append_owner_cache(p, assets)
                    cache[p] = assets
                    done.add(p)
                    cp["done_payers"] = list(done)
                    if len(done) % 50 == 0:
                        save_checkpoint(cp)
                        progress(
                            "owners_heartbeat",
                            done=len(done),
                            remaining=len(payers) - len(done),
                            request_count=request_count,
                            err_sample=errors[-3:] if errors else [],
                        )

    # batch gather in chunks to avoid huge task list memory, but 17k is fine
    chunk = 50
    for i in range(0, len(remaining), chunk):
        batch = remaining[i : i + chunk]
        await asyncio.gather(*(one(p) for p in batch))
        save_checkpoint(cp)
        progress(
            "owners_chunk",
            done=len(done),
            remaining=len(payers) - len(done),
            request_count=request_count,
            errors=len(errors),
        )

    # retry failed payers once
    failed = [p for p in payers if p not in done]
    if failed:
        progress("owners_retry", count=len(failed), request_count=request_count)
        errors.clear()
        for i in range(0, len(failed), chunk):
            batch = failed[i : i + chunk]
            await asyncio.gather(*(one(p) for p in batch))
            save_checkpoint(cp)

    still_failed = [p for p in payers if p not in done]
    progress(
        "phase_owners_done",
        done=len(done),
        failed=len(still_failed),
        request_count=request_count,
    )
    cp["failed_payers"] = still_failed
    save_checkpoint(cp)
    return cache


async def classify_and_followup(names: list[dict], cache: dict[str, list[dict]], cp: dict) -> None:
    # Build expected owner sets
    owner_domains: dict[str, set[str]] = {}
    asset_owner_global: dict[str, str] = {}  # asset -> owner from all owner fetches
    for payer, assets in cache.items():
        s = set()
        for a in assets:
            s.add(a["asset"])
            if a["asset"] and a.get("owner"):
                asset_owner_global[a["asset"]] = a["owner"]
        owner_domains[payer] = s

    results: dict[str, dict] = {}
    need_followup: list[dict] = []

    for n in names:
        domain = n["domain"]
        payer = n["payer"]
        if payer not in cache:
            results[domain] = {
                "domain": domain,
                "payer": payer,
                "classification": "uncertain",
                "observed_owner": None,
                "reason": "payer_assets_fetch_failed",
                "revealId": n.get("revealId"),
            }
            continue
        owned = owner_domains.get(payer, set())
        if domain in owned:
            obs = asset_owner_global.get(domain) or payer
            results[domain] = {
                "domain": domain,
                "payer": payer,
                "classification": "owned_expected",
                "observed_owner": obs,
                "reason": "in_owner_assets",
                "revealId": n.get("revealId"),
            }
        else:
            need_followup.append(n)

    progress(
        "classify_initial",
        owned_expected=sum(1 for r in results.values() if r["classification"] == "owned_expected"),
        need_followup=len(need_followup),
        uncertain=sum(1 for r in results.values() if r["classification"] == "uncertain"),
        request_count=request_count,
    )

    # Follow-up assets?asset= for each missing-from-list
    sem = asyncio.Semaphore(CONCURRENCY)
    lock = asyncio.Lock()
    follow_done = 0

    async def follow_one(n: dict) -> None:
        nonlocal follow_done
        domain = n["domain"]
        payer = n["payer"]
        async with sem:
            owner, err = await fetch_asset_owner(domain)
            async with lock:
                follow_done += 1
                if err:
                    results[domain] = {
                        "domain": domain,
                        "payer": payer,
                        "classification": "uncertain",
                        "observed_owner": None,
                        "reason": f"asset_lookup_error:{err}",
                        "revealId": n.get("revealId"),
                    }
                elif owner is None:
                    results[domain] = {
                        "domain": domain,
                        "payer": payer,
                        "classification": "missing",
                        "observed_owner": None,
                        "reason": "assets_asset_empty",
                        "revealId": n.get("revealId"),
                    }
                elif owner == payer:
                    results[domain] = {
                        "domain": domain,
                        "payer": payer,
                        "classification": "owned_expected",
                        "observed_owner": owner,
                        "reason": "assets_asset_match",
                        "revealId": n.get("revealId"),
                    }
                else:
                    results[domain] = {
                        "domain": domain,
                        "payer": payer,
                        "classification": "owned_other",
                        "observed_owner": owner,
                        "reason": "assets_asset_other_owner",
                        "revealId": n.get("revealId"),
                    }
                if follow_done % 100 == 0:
                    progress(
                        "followup_heartbeat",
                        done=follow_done,
                        total=len(need_followup),
                        request_count=request_count,
                    )

    if need_followup:
        progress("followup_start", count=len(need_followup), request_count=request_count)
        chunk = 50
        for i in range(0, len(need_followup), chunk):
            batch = need_followup[i : i + chunk]
            await asyncio.gather(*(follow_one(n) for n in batch))
            progress(
                "followup_chunk",
                done=min(i + chunk, len(need_followup)),
                total=len(need_followup),
                request_count=request_count,
            )

    # domains/check cross-check for missing (batches of 100)
    missing_domains = [r for r in results.values() if r["classification"] == "missing"]
    if missing_domains:
        progress("domains_check_start", count=len(missing_domains), request_count=request_count)
        # use first payer as address (API requires address)
        addr = missing_domains[0]["payer"]
        for i in range(0, len(missing_domains), 100):
            batch = missing_domains[i : i + 100]
            doms = [b["domain"] for b in batch]
            info = await domains_check(doms, addr)
            if info is None:
                # mark those that were missing as still missing but note check failed
                for b in batch:
                    results[b["domain"]]["reason"] = results[b["domain"]].get("reason", "") + ";domains_check_failed"
                continue
            for b in batch:
                d = b["domain"]
                meta = info.get(d)
                if meta is None:
                    results[d]["reason"] = results[d].get("reason", "") + ";domains_check_absent"
                    continue
                avail = meta.get("available")
                results[d]["domains_check"] = {
                    "available": avail,
                    "isReservedDomain": meta.get("isReservedDomain"),
                }
                if avail is False:
                    # taken but our assets?asset= returned empty — uncertain
                    results[d]["classification"] = "uncertain"
                    results[d]["reason"] = "assets_empty_but_check_unavailable"
                elif avail is True:
                    results[d]["reason"] = "assets_empty_and_check_available"

    # Retry uncertain once
    uncertain = [r for r in results.values() if r["classification"] == "uncertain"]
    if uncertain:
        progress("uncertain_retry_start", count=len(uncertain), request_count=request_count)
        sem2 = asyncio.Semaphore(CONCURRENCY)

        async def retry_one(r: dict) -> None:
            domain = r["domain"]
            payer = r["payer"]
            async with sem2:
                owner, err = await fetch_asset_owner(domain)
                if err:
                    return  # stay uncertain
                if owner is None:
                    results[domain] = {
                        **r,
                        "classification": "missing",
                        "observed_owner": None,
                        "reason": (r.get("reason") or "") + ";retry_empty",
                    }
                elif owner == payer:
                    results[domain] = {
                        **r,
                        "classification": "owned_expected",
                        "observed_owner": owner,
                        "reason": (r.get("reason") or "") + ";retry_match",
                    }
                else:
                    results[domain] = {
                        **r,
                        "classification": "owned_other",
                        "observed_owner": owner,
                        "reason": (r.get("reason") or "") + ";retry_other",
                    }

        await asyncio.gather(*(retry_one(r) for r in uncertain))

    # Write results jsonl (deterministic order)
    with open(RESULTS_PATH, "w") as f:
        for n in names:
            r = results.get(n["domain"])
            if r is None:
                r = {
                    "domain": n["domain"],
                    "payer": n["payer"],
                    "classification": "uncertain",
                    "observed_owner": None,
                    "reason": "no_result",
                    "revealId": n.get("revealId"),
                }
            f.write(json.dumps(r, separators=(",", ":")) + "\n")

    # Summary
    counts = defaultdict(int)
    samples = {"owned_other": [], "missing": [], "uncertain": []}
    for n in names:
        r = results[n["domain"]]
        c = r["classification"]
        counts[c] += 1
        if c in samples and len(samples[c]) < 20:
            samples[c].append(
                {
                    "domain": r["domain"],
                    "payer": r["payer"],
                    "observed_owner": r.get("observed_owner"),
                    "reason": r.get("reason"),
                }
            )

    started = cp.get("started_at") or now_iso()
    summary = {
        "at": now_iso(),
        "started_at": started,
        "storm_names": len(names),
        "unique_payers": len({n["payer"] for n in names}),
        "owned_expected": counts["owned_expected"],
        "owned_other": counts["owned_other"],
        "missing": counts["missing"],
        "uncertain": counts["uncertain"],
        "request_count": request_count,
        "duration_note": f"from {started} to {now_iso()}",
        "api_notes": [
            "/owner was tip-lag blocked (HTTP 500, >36k behind BlockDag) so /assets was used",
            "Primary: GET /assets?owner=&type=domain&pageSize=100",
            "Follow-up: GET /assets?asset=<domain.kas> for names missing from owner list",
            "Optional cross-check: POST /domains/check for missing classification",
            "reveal-uncertain-2026-09-26.jsonl not found in artifacts; none included",
            "TN10 only; miner farm not touched",
        ],
        "failed_payers": cp.get("failed_payers") or [],
        "samples": samples,
        "paths": {
            "storm_names": NAMES_PATH,
            "results": RESULTS_PATH,
            "summary": SUMMARY_PATH,
            "progress": PROGRESS_PATH,
            "checkpoint": CHECKPOINT_PATH,
            "owner_cache": OWNER_CACHE_PATH,
        },
    }
    with open(SUMMARY_PATH, "w") as f:
        json.dump(summary, f, indent=2)
    progress("complete", **{k: summary[k] for k in ("storm_names", "owned_expected", "owned_other", "missing", "uncertain", "request_count")})
    cp["phase"] = "done"
    cp["classify_done"] = True
    cp["followup_done"] = True
    save_checkpoint(cp)


async def main() -> None:
    progress("script_start", pid=os.getpid())
    names = load_names()
    progress("names_loaded", count=len(names), unique_payers=len({n["payer"] for n in names}))
    cp = load_checkpoint()
    if "started_at" not in cp:
        cp["started_at"] = now_iso()
        save_checkpoint(cp)

    cache = await phase_fetch_owners(names, cp)
    await classify_and_followup(names, cache, cp)
    progress("script_exit", request_count=request_count)


if __name__ == "__main__":
    asyncio.run(main())
