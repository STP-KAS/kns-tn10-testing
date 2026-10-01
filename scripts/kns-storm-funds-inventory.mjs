// Read-only funds inventory for KNS storm runner. TN10 only. No keys are loaded.
// 1) ONE getBalancesByAddresses batch (all 25,700 snapshot wallets) via public resolver RPC.
// 2) getUtxosByAddresses for wallets with balance >= --min-tkas (chunked), saved as the runner's local UTXO snapshot.
// Every public call is logged to ../public-api-calls.jsonl.
import fs from "node:fs"; import { pathToFileURL } from "node:url"; import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);
const DIR = "/workspace/artifacts/kns-tn10/storm-2026-10-01";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const MIN = Number(arg("--min-tkas", "36"));
const CHUNK = Number(arg("--utxo-chunk", "2000"));
const NET = "testnet-10";
const calls = (o) => fs.appendFileSync(`${DIR}/public-api-calls.jsonl`, JSON.stringify({ at: new Date().toISOString(), ...o }) + "\n");
const rows = fs.readFileSync("/workspace/artifacts/kns-tn10/snapshot-wallets/addresses.csv", "utf8").trim().split("\n").slice(1).map((l) => { const [i, a] = l.split(","); return { index: +i, address: a }; });
const url = await new kaspa.Resolver().getUrl(kaspa.Encoding.Borsh, NET);
const c = new kaspa.RpcClient({ url, encoding: kaspa.Encoding.Borsh, networkId: NET });
await c.connect();
const info = await c.getServerInfo();
calls({ api: "rpc.getServerInfo", url, ok: true, synced: info.isSynced, utxoindex: info.hasUtxoIndex });
const bal = new Map(); let t0 = Date.now();
async function balances(list) {
  const t = Date.now(); const r = await c.getBalancesByAddresses(list.map((x) => x.address));
  calls({ api: "rpc.getBalancesByAddresses", url, n: list.length, ms: Date.now() - t, ok: true });
  for (const e of r.entries) bal.set(e.address.toString(), BigInt(e.balance ?? 0));
}
try { await balances(rows); }
catch (e) { calls({ api: "rpc.getBalancesByAddresses", url, n: rows.length, ok: false, error: String(e?.message || e).slice(0, 160) }); for (let i = 0; i < rows.length; i += 5000) await balances(rows.slice(i, i + 5000)); }
const out = rows.map((r) => ({ ...r, sompi: String(bal.get(r.address) ?? 0n) }));
const tk = (s) => Number(BigInt(s)) / 1e8;
const total = out.reduce((a, r) => a + tk(r.sompi), 0);
const groups = [["0-6", 0, 6], ["phaseA 7-699", 7, 699], ["s3 700-20699", 700, 20699], ["r1 20700-25699", 20700, 25699]].map(([g, a, b]) => {
  const s = out.filter((r) => r.index >= a && r.index <= b); const t = s.reduce((x, r) => x + tk(r.sompi), 0);
  return { group: g, wallets: s.length, total_tkas: +t.toFixed(2), wallets_ge_min: s.filter((r) => tk(r.sompi) >= MIN).length, usable_names: s.reduce((x, r) => x + Math.floor(Math.max(0, tk(r.sompi) - 1.2) / 35.04), 0) };
});
const funded = out.filter((r) => tk(r.sompi) >= MIN);
// UTXO snapshot for funded wallets
const utxos = {}; let nUtxo = 0;
for (let i = 0; i < funded.length; i += CHUNK) {
  const part = funded.slice(i, i + CHUNK); const t = Date.now();
  const r = await c.getUtxosByAddresses(part.map((x) => x.address));
  calls({ api: "rpc.getUtxosByAddresses", url, n: part.length, ms: Date.now() - t, ok: true, entries: r.entries.length });
  for (const e of r.entries) {
    const a = e.address.toString();
    (utxos[a] ||= []).push({ transactionId: e.outpoint.transactionId, index: e.outpoint.index, amount: String(e.amount), scriptPublicKey: { version: e.scriptPublicKey.version, script: e.scriptPublicKey.script }, blockDaaScore: String(e.blockDaaScore), isCoinbase: !!e.isCoinbase });
    nUtxo++;
  }
}
const dag = await c.getBlockDagInfo(); calls({ api: "rpc.getBlockDagInfo", url, ok: true });
await c.disconnect();
const stamp = new Date().toISOString();
fs.writeFileSync(`${DIR}/funds-balances-snapshot.json`, JSON.stringify({ at: stamp, url, virtualDaaScore: String(dag.virtualDaaScore), wallets: out }) + "\n");
fs.writeFileSync(`${DIR}/utxo-snapshot.json`, JSON.stringify({ at: stamp, url, virtualDaaScore: String(dag.virtualDaaScore), min_tkas: MIN, wallets: funded.length, utxos: nUtxo, byAddress: utxos }) + "\n");
const summary = { at: stamp, total_tkas: +total.toFixed(2), wallets: out.length, funded_wallets_ge_min: funded.length, utxos: nUtxo, usable_names_35: groups.reduce((a, g) => a + g.usable_names, 0), groups, elapsed_ms: Date.now() - t0 };
fs.writeFileSync(`${DIR}/funds-summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 1)); process.exit(0);
