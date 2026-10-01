#!/usr/bin/env node
// Live summary of the KNS storm runner: names/min, failures, latency p50/p90, spend. Read-only. Usage: node summary.mjs [--window-min 10]
import fs from "node:fs";
const D = "/workspace/artifacts/kns-tn10/storm-2026-10-01";
const i = process.argv.indexOf("--window-min"); const W = i > 0 ? Number(process.argv[i + 1]) : 10;
const jl = (f) => (fs.existsSync(`${D}/${f}`) ? fs.readFileSync(`${D}/${f}`, "utf8").trim().split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
const names = jl("names.jsonl"), events = jl("events.jsonl"), calls = jl("public-api-calls.jsonl").filter((c) => c.runner);
const nowMs = Date.now(), since = (m) => (r) => nowMs - Date.parse(r.at) <= m * 60000;
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const fails = {}; for (const e of events) if (/rejected|failed|uncertain|quarantined|crash|exhausted|still_in_mempool/.test(e.phase)) fails[e.phase] = (fails[e.phase] || 0) + 1;
const failsW = {}; for (const e of events.filter(since(W))) if (/rejected|failed|uncertain|quarantined|crash|exhausted/.test(e.phase)) failsW[e.phase] = (failsW[e.phase] || 0) + 1;
const lw = names.filter(since(W)).map((n) => n.accepted_latency_ms);
const conf = events.filter((e) => e.phase === "reveal_left_mempool" && e.name_latency_ms).filter(since(W)).map((e) => e.name_latency_ms);
const spend = names.reduce((a, n) => a + n.name_spend_tkas, 0), fees = names.reduce((a, n) => a + n.commit_fee_tkas + n.reveal_fee_tkas, 0);
let status = {}; try { status = JSON.parse(fs.readFileSync(`${D}/status.json`, "utf8")); } catch {}
const start = events.find((e) => e.phase === "runner_start");
console.log(JSON.stringify({ at: new Date().toISOString(), running: (() => { try { process.kill(Number(fs.readFileSync(`${D}/runner.pid`, "utf8")), 0); return true; } catch { return false; } })(),
  names_total: names.length, per_min_1: names.filter(since(1)).length, [`per_min_avg_${W}m`]: +(names.filter(since(W)).length / W).toFixed(2), per_min_avg_60m: +(names.filter(since(60)).length / 60).toFixed(2),
  failures_total: fails, [`failures_${W}m`]: failsW, fail_rate_total: +(Object.values(fails).reduce((a, b) => a + b, 0) / ((names.length + Object.values(fails).reduce((a, b) => a + b, 0)) || 1)).toFixed(4),
  accepted_latency_ms: { p50: pct(lw, 0.5), p90: pct(lw, 0.9) }, left_mempool_latency_ms: { p50: pct(conf, 0.5), p90: pct(conf, 0.9) },
  spend_tkas: +spend.toFixed(3), fees_tkas: +fees.toFixed(4), avg_spend_per_name: names.length ? +(spend / names.length).toFixed(5) : null,
  funds_left_tkas: status.funds_left_tkas, est_hours_left: status.est_hours_left_at_cap, pending_reveals: status.pending_reveals, quarantined_wallets: status.wallets_quarantined,
  stranded: jl("stranded.jsonl").length, public_api_calls_by_runner: calls.length, runner_started: start?.at || null }, null, 1));
