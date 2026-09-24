#!/usr/bin/env node
/**
 * Fund snapshot wallets (TN10) from the treasury mnemonic, batching outputs.
 * NEVER prints/logs mnemonic or private keys.
 *
 * Usage:
 *   node treasury-fund-snapshot.mjs --from 7 --to 199 --amount-tkas 4000 --per-tx 15 [--dry-run 1] [--max-chunks N]
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);

const NETWORK = "testnet-10";
const MNEMONIC_FILE = process.env.KNS_TN10_TREASURY_MNEMONIC_FILE ?? (() => { throw new Error("set KNS_TN10_TREASURY_MNEMONIC_FILE (env only, never commit)"); })();
const EXPECTED = "kaspatest:qzffl5xy9np46gkttyuftqnv2w04pr8g3wsp7c3vv8se3txtelx6q7c0v0ldx";
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const CSV = `${OUT}/addresses.csv`;
const STATUS = `${OUT}/treasury-fund-status.json`;

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d; };
const FROM = Number(arg("--from", "7"));
const TO = Number(arg("--to", "199"));
const AMOUNT = kaspa.kaspaToSompi(arg("--amount-tkas", "4000"));
const PER_TX = Number(arg("--per-tx", "15"));
const DRY = arg("--dry-run", "0") === "1";
const MAX_CHUNKS = Number(arg("--max-chunks", "1000"));
const MIN_TREASURY = kaspa.kaspaToSompi("780000");
const j = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const log = (o) => console.log(j({ t: new Date().toISOString(), ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- key (in memory only)
const phrase = fs.readFileSync(MNEMONIC_FILE, "utf8").trim().split(/\s+/).join(" ");
const xprv = new kaspa.XPrv(new kaspa.Mnemonic(phrase).toSeed());
const privateKey = xprv.derivePath("m/44'/111111'/0'/0/0").toPrivateKey();
const treasury = privateKey.toKeypair().toAddress(NETWORK).toString();
if (treasury !== EXPECTED) { log({ phase: "abort", error: "treasury_address_mismatch" }); process.exit(2); }

// --- recipients
const rows = fs.readFileSync(CSV, "utf8").trim().split("\n").slice(1).map((l) => { const [i, a] = l.split(","); return { index: Number(i), address: a }; });
const recips = rows.filter((r) => r.index >= FROM && r.index <= TO && r.index >= 7);
if (recips.some((r) => !r.address.startsWith("kaspatest:"))) { log({ phase: "abort", error: "non_tn10_recipient" }); process.exit(2); }

const status = fs.existsSync(STATUS) ? JSON.parse(fs.readFileSync(STATUS, "utf8")) : { treasury, amount_tkas: Number(AMOUNT) / 1e8, entries: {} };
const saveStatus = () => { status.updated_at = new Date().toISOString(); fs.writeFileSync(STATUS, JSON.stringify(status, null, 2) + "\n"); };

const rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: NETWORK });
await rpc.connect();
const info = await rpc.getServerInfo();
log({ phase: "rpc", url: rpc.url, isSynced: info.isSynced, daa: info.virtualDaaScore });
if (!info.isSynced) { log({ phase: "abort", error: "node_not_synced" }); process.exit(3); }
status.rpc_url = rpc.url;

const balances = async (addrs) => {
  const m = new Map();
  for (let k = 0; k < addrs.length; k += 50) {
    const r = await rpc.getBalancesByAddresses(addrs.slice(k, k + 50));
    for (const e of r.entries) m.set(String(e.address), BigInt(e.balance ?? 0));
  }
  return m;
};

// --- skip already-funded / already-sent
const bal0 = await balances(recips.map((r) => r.address));
const todo = [];
let skipped = 0;
for (const r of recips) {
  const b = bal0.get(r.address) ?? 0n;
  const prev = status.entries[r.index];
  if (b >= AMOUNT) {
    if (!prev || prev.status !== "confirmed") status.entries[r.index] = { index: r.index, address: r.address, txid: prev?.txid ?? null, status: prev?.txid ? "confirmed" : "skipped_already_funded", balance_tkas: Number(b) / 1e8 };
    skipped += prev?.txid ? 0 : 1;
    continue;
  }
  if (prev && prev.txid && prev.status !== "failed") {
    log({ phase: "abort", error: "prior_tx_recorded_but_balance_low_check_manually", index: r.index, txid: prev.txid });
    process.exit(5);
  }
  todo.push(r);
}
saveStatus();
log({ phase: "plan", recipients: recips.length, todo: todo.length, skipped_now: skipped });

// --- UTXOs
const { entries: allEntries } = await rpc.getUtxosByAddresses([treasury]);
const daa = BigInt(info.virtualDaaScore);
const mature = allEntries.filter((e) => !e.isCoinbase || BigInt(e.blockDaaScore) + 3000n < daa);
mature.sort((a, b) => (BigInt(a.blockDaaScore) < BigInt(b.blockDaaScore) ? -1 : 1));
const treasBal = allEntries.reduce((s, e) => s + BigInt(e.amount), 0n);
log({ phase: "utxos", count: allEntries.length, mature: mature.length, treasury_tkas: Number(treasBal) / 1e8 });
if (treasBal < MIN_TREASURY) { log({ phase: "abort", error: "treasury_below_780k" }); process.exit(4); }

let fr = 1;
try { const fe = await rpc.getFeeEstimate({}); fr = Math.max(1, Number(fe.estimate.normalBuckets?.[0]?.feerate ?? fe.estimate.priorityBucket.feerate ?? 1)); log({ phase: "fee", feeRate: fr }); } catch (e) { log({ phase: "fee", error: String(e) }); }

let cursor = 0;
let chunkNo = 0;
let totalTxs = 0;
const results = { funded: 0, failed: 0, txids: [] };
for (let k = 0; k < todo.length && chunkNo < MAX_CHUNKS; k += PER_TX, chunkNo++) {
  const chunk = todo.slice(k, k + PER_TX);
  const need = AMOUNT * BigInt(chunk.length) + kaspa.kaspaToSompi("100");
  const sel = [];
  let acc = 0n;
  while (acc < need && cursor < mature.length) { const e = mature[cursor++]; sel.push(e); acc += BigInt(e.amount); }
  if (acc < need) { log({ phase: "abort", error: "insufficient_mature_utxos" }); break; }
  let gen;
  try {
    gen = await kaspa.createTransactions({
      entries: sel,
      outputs: chunk.map((r) => ({ address: r.address, amount: AMOUNT })),
      priorityFee: 0n,
      feeRate: fr,
      changeAddress: treasury,
      networkId: NETWORK,
    });
  } catch (e) { log({ phase: "abort", error: "create_failed", chunk: chunkNo, msg: String(e) }); for (const r of chunk) { status.entries[r.index] = { index: r.index, address: r.address, txid: null, status: "failed", error: "create_failed" }; results.failed++; } saveStatus(); break; }
  const { transactions, summary } = gen;
  const finalId = summary.finalTransactionId;
  log({ phase: "chunk_built", chunk: chunkNo, recipients: chunk.map((r) => r.index), inputs: sel.length, txs: transactions.length, fees_tkas: Number(summary.fees) / 1e8, finalId, masses: transactions.slice(-2).map((t) => t.mass) });
  if (DRY) { continue; }
  for (const r of chunk) status.entries[r.index] = { index: r.index, address: r.address, txid: finalId, status: "submitting", chunk: chunkNo };
  saveStatus();
  let submitted = 0;
  let err = null;
  for (const p of transactions) {
    try { p.sign([privateKey]); await p.submit(rpc); submitted++; totalTxs++; }
    catch (e) { err = String(e); break; }
  }
  if (err) {
    const finalSubmitted = submitted === transactions.length;
    log({ phase: "submit_error", chunk: chunkNo, submitted, of: transactions.length, msg: err });
    for (const r of chunk) status.entries[r.index] = { index: r.index, address: r.address, txid: submitted === transactions.length - 1 ? finalId : null, status: submitted === transactions.length - 1 ? "final_submit_error_check_balance" : "failed", error: err.slice(0, 300), chunk: chunkNo, batch_txs_submitted: submitted };
    results.failed += chunk.length; saveStatus();
    break;
  }
  for (const r of chunk) status.entries[r.index].status = "submitted";
  results.txids.push(finalId); saveStatus();
  log({ phase: "chunk_submitted", chunk: chunkNo, txs: transactions.length, finalId });
  // wait for recipient balance to reflect (confirmation), up to 120s
  let ok = false;
  for (let w = 0; w < 40 && !ok; w++) {
    await sleep(3000);
    const b = await balances(chunk.map((r) => r.address));
    ok = chunk.every((r) => (b.get(r.address) ?? 0n) >= AMOUNT);
    if (ok) for (const r of chunk) { status.entries[r.index].status = "confirmed"; status.entries[r.index].balance_tkas = Number(b.get(r.address)) / 1e8; }
  }
  if (!ok) { log({ phase: "abort", error: "chunk_not_confirmed_120s", chunk: chunkNo, finalId }); saveStatus(); break; }
  results.funded += chunk.length; saveStatus();
}
const after = await rpc.getBalancesByAddresses([treasury]);
status.summary = { funded_this_run: results.funded, failed_this_run: results.failed, total_txs_submitted: totalTxs, final_txids: results.txids, treasury_after_tkas: Number(BigInt(after.entries[0].balance)) / 1e8, dry_run: DRY };
if (!DRY) saveStatus();
log({ phase: "done", ...status.summary });
await rpc.disconnect();
