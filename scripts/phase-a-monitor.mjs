#!/usr/bin/env node
// Read-only monitor for Phase A 7-699: throughput/errors over a window, RPC + indexer latency, process counts.
// Usage: node phase-a-monitor.mjs [--window-min 5]
import fs from "node:fs"; import { execSync } from "node:child_process"; import { pathToFileURL } from "node:url"; import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const i = process.argv.indexOf("--window-min"); const WIN = Number(i > 0 ? process.argv[i + 1] : 5);
const since = Date.now() - WIN * 60000;
let ok = 0, fail = 0, skipIdx = 0, errs = {}, totalOk = 0;
for (const f of fs.readdirSync(OUT).filter((f) => /^phase-a-(pool-)?\d+-\d+\.jsonl$/.test(f) && f !== "phase-a-0-6.jsonl")) {
  const [a] = f.match(/\d+/g).map(Number); if (a < 7) continue;
  for (const l of fs.readFileSync(`${OUT}/${f}`, "utf8").split("\n")) {
    if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.ok === true) totalOk++;
    if (j.phase === "skip_exists") continue;
    const t = Date.parse(j.at || 0); if (!(t >= since)) continue;
    if (j.ok === true) ok++; else if (j.ok === false) { fail++; const e = String(j.error || "code_" + j.code).slice(0, 80); errs[e] = (errs[e] || 0) + 1; }
    else if (j.phase === "skip_exists_indexer") skipIdx++;
  }
}
// unique created names 7-699 (artifacts)
let created = 0;
for (const f of fs.readdirSync("/workspace/artifacts/kns-tn10/api")) { const m = f.match(/^smoke-result-stp-snap-w(\d{3})-d\d{3}\.json$/); if (m && +m[1] >= 7) created++; }
const ps = execSync("ps -eo args", { encoding: "utf8" }).split("\n");
const cnt = (re) => ps.filter((l) => re.test(l) && !/\brg\b|ps -eo/.test(l)).length;
const procs = { phaseA_workers_7_699: cnt(/kns-snap-phase-a\.mjs --wallet-from (?!0 )/), pools_7_699: cnt(/kns-snap-pool\.mjs --wallet-from/), phaseA_0_6: cnt(/kns-snap-phase-a\.mjs --wallet-from 0 /), smoke_children: cnt(/kns-smoke-create\.mjs/), s3_workers: cnt(/kns-snap-s3\.mjs/), bulk: cnt(/kns-bulk-create\.mjs/) };
let rpcMs = null, rpcUrl = null, idxMs = null, idxStatus = null;
try { const t0 = Date.now(); const rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: "testnet-10" }); await rpc.connect({ timeoutDuration: 15000 }); await rpc.getServerInfo(); rpcMs = Date.now() - t0; rpcUrl = rpc.url; await rpc.disconnect(); } catch (e) { rpcMs = "ERR " + String(e).slice(0, 80); }
try { const t0 = Date.now(); const r = await fetch("https://api.knsdomains.org/tn10/api/v1/stp-snap-w007-d000.kas/owner", { signal: AbortSignal.timeout(15000) }); idxStatus = r.status; await r.text(); idxMs = Date.now() - t0; } catch (e) { idxMs = "ERR " + String(e).slice(0, 80); }
console.log(JSON.stringify({ t: new Date().toISOString(), window_min: WIN, ok, fail, fail_rate: ok + fail ? +(fail / (ok + fail)).toFixed(3) : 0, per_min: +(ok / WIN).toFixed(2), skip_indexer: skipIdx, errs, created_7_699: created, procs, rpc_connect_ms: rpcMs, rpc_url: rpcUrl, indexer_ms: idxMs, indexer_status: idxStatus }));
process.exit(0);
