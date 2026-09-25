#!/usr/bin/env node
// Read-only: combined KNS throughput (new smoke-result artifacts by name family), s3/phase-a pool errors, indexer + memory.
import fs from "node:fs";
const API = "/workspace/artifacts/kns-tn10/api", OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const i = process.argv.indexOf("--window-min"); const WIN = Number(i > 0 ? process.argv[i + 1] : 5); const since = Date.now() - WIN * 60000;
const fam = {}; const total = {};
for (const f of fs.readdirSync(API)) {
  const m = f.match(/^smoke-result-(stp-[a-z0-9]+)-/); if (!m) continue;
  let k = m[1]; if (k === "stp-snap") k = /stp-snap-w00[0-6]-/.test(f) ? "phaseA_0_6" : "phaseA_7_699";
  total[k] = (total[k] || 0) + 1;
  try { if (fs.statSync(`${API}/${f}`).mtimeMs >= since) fam[k] = (fam[k] || 0) + 1; } catch {}
}
const errs = {}; let fails = 0, oks = 0;
for (const f of fs.readdirSync(OUT).filter((f) => /^(s3-pool|phase-a-pool)-\d+-\d+\.jsonl$/.test(f))) {
  const st = fs.statSync(`${OUT}/${f}`); if (st.mtimeMs < since) continue;
  const buf = fs.readFileSync(`${OUT}/${f}`, "utf8"); const tail = buf.slice(Math.max(0, buf.length - 3_000_000));
  for (const l of tail.split("\n")) { if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; } if (!(Date.parse(j.at) >= since)) continue;
    if (j.phase === "created") oks++; if (j.phase === "attempt_failed") { fails++; const e = String(j.error).replace(/[0-9a-f]{64}/g, "").slice(0, 60); errs[e] = (errs[e] || 0) + 1; } }
}
let idxMs = null, idxStatus = null;
try { const t0 = Date.now(); const r = await fetch("https://api.knsdomains.org/tn10/api/v1/stp-snap-w007-d000.kas/owner", { signal: AbortSignal.timeout(15000) }); idxStatus = r.status; await r.text(); idxMs = Date.now() - t0; } catch (e) { idxMs = "ERR"; }
const mem = fs.readFileSync("/proc/meminfo", "utf8"); const avail = Math.round(Number(mem.match(/MemAvailable:\s+(\d+)/)[1]) / 1024);
const per = Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, +(v / WIN).toFixed(1)]));
console.log(JSON.stringify({ t: new Date().toISOString(), window_min: WIN, per_min: per, combined_per_min: +(Object.values(fam).reduce((a, b) => a + b, 0) / WIN).toFixed(1), pool_ok: oks, pool_failed_attempts: fails, pool_fail_rate: +(fails / ((oks + fails) || 1)).toFixed(3), errs, totals: total, indexer_ms: idxMs, indexer_status: idxStatus, mem_avail_mb: avail }));
