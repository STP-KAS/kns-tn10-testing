// Verify a top-up tx and write its outputs that pay funded-2026-10-02 wallets into topups.json (merge, no duplicates).
// Verification on n0 only via light calls: getMempoolEntry(txid); if not in mempool, the block hash from the public TN10 REST API (1 call)
// and n0 getBlock(hash, includeTransactions) to read the tx outputs from n0 itself. Outputs to any address outside the funded set are ignored
// and never written. Usage: node tools/topup-lookup.mjs <txid> [--expect-sompi 25000000000]
import fs from "node:fs"; import { pathToFileURL } from "node:url"; import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json"); globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);
const D = "/workspace/artifacts/kns-tn10/trickle-2026-10-02", NET = "testnet-10", txid = process.argv[2]; const ei = process.argv.indexOf("--expect-sompi"); const EXPECT = ei > 0 ? BigInt(process.argv[ei + 1]) : null;
if (!/^[0-9a-f]{64}$/.test(txid || "")) { console.error("usage: topup-lookup.mjs <txid>"); process.exit(2); }
const set = new Map(); for (const l of fs.readFileSync("/workspace/artifacts/kns-tn10/funded-2026-10-02/addresses.csv", "utf8").split("\n").slice(1)) { const [i, a] = l.split(","); if (a?.startsWith("kaspatest:")) set.set(a.trim(), Number(i)); }
const c = new kaspa.RpcClient({ url: "ws://127.0.0.1:17210", encoding: kaspa.Encoding.Borsh, networkId: NET }); await c.connect({ timeoutDuration: 10000 });
const si = await c.getServerInfo(); let outs = null, via = null, accepted = null;
try { const r = await c.getMempoolEntry({ transactionId: txid, includeOrphanPool: false, filterTransactionPool: false }); if (r?.mempoolEntry) { outs = r.mempoolEntry.transaction.outputs; via = "n0_mempool"; } } catch {}
if (!outs) { const j = await (await fetch(`https://api-tn10.kaspa.org/transactions/${txid}?inputs=false&outputs=false&resolve_previous_outpoints=no`, { headers: { "user-agent": "kns-tn10-trickle" } })).json(); accepted = j.is_accepted;
  for (const h of j.block_hash || []) { const b = await c.getBlock({ hash: h, includeTransactions: true }); const tx = b.block.transactions.find((t) => t.verboseData?.transactionId === txid); if (tx) { outs = tx.outputs; via = `n0_getBlock:${h}`; break; } } }
await c.disconnect(); if (!outs) { console.log(JSON.stringify({ txid, error: "not found on n0 (mempool or block)", n0_synced: si.isSynced })); process.exit(1); }
const mine = []; outs.forEach((o, i) => { const a = kaspa.addressFromScriptPublicKey(o.scriptPublicKey, NET).toString(); if (!set.has(a)) return; const amt = BigInt(o.value);
  if (EXPECT !== null && amt !== EXPECT) { console.log(JSON.stringify({ txid, index: i, warning: "amount differs from expected", amount_sompi: String(amt) })); return; }
  mine.push({ txid, index: i, amount_sompi: String(amt), address: a, wallet_index: set.get(a), verified_by: via, verified_at: new Date().toISOString() }); });
const F = `${D}/topups.json`; const cur = fs.existsSync(F) ? JSON.parse(fs.readFileSync(F, "utf8")) : []; const have = new Set(cur.map((t) => `${t.txid}:${t.index}`));
const add = mine.filter((t) => !have.has(`${t.txid}:${t.index}`)); fs.writeFileSync(F + ".tmp", JSON.stringify([...cur, ...add], null, 1) + "\n"); fs.renameSync(F + ".tmp", F);
console.log(JSON.stringify({ txid, via, api_is_accepted: accepted, outputs_total: outs.length, to_funded_set: mine.length, funded_tkas: Number(mine.reduce((s, t) => s + BigInt(t.amount_sompi), 0n)) / 1e8, indexes: mine.map((t) => t.index), wallets: [...new Set(mine.map((t) => t.wallet_index))], added: add.length }));
