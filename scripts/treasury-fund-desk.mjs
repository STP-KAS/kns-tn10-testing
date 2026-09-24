#!/usr/bin/env node
/**
 * Desk funding: top up snapshot wallets (TN10) to ~TARGET TKAS from the treasury.
 * Key: loaded IN-PROCESS ONLY from env KNS_TN10_TREASURY_KEY (user-authorized 21:11/21:14).
 * NEVER prints/logs/copies the key or derived private keys. Reads no other secret entries.
 *
 * Safety: re-checks live recipient balances before every batch (skip >= SKIP_AT), per-run cap (--cap-tkas),
 * global treasury floor (--floor-tkas), waits for each batch to be reflected on-chain before the next,
 * halves batch size on create/mass/submit errors.
 *
 * Usage: node treasury-fund-desk.mjs --from 200 --to 699 [--target-tkas 4000] [--skip-at-tkas 3900] [--per-tx 15]
 *        [--cap-tkas 2050000] [--floor-tkas 1000000] [--wait-rows 700] [--wait-min 25] [--dry-run 1]
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);

const NETWORK = "testnet-10";
// Treasury key comes from env KNS_TN10_TREASURY_KEY (hex or mnemonic). Never commit it.
const EXPECTED = "kaspatest:qzffl5xy9np46gkttyuftqnv2w04pr8g3wsp7c3vv8se3txtelx6q7c0v0ldx";
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const CSV = `${OUT}/addresses.csv`;
const DATE = new Date().toISOString().slice(0, 10);
const JSONL = `${OUT}/desk-fund-${DATE}.jsonl`;
const STATUS = `${OUT}/desk-fund-status.json`;

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d; };
const FROM = Number(arg("--from", "200")), TO = Number(arg("--to", "699"));
const S = (x) => kaspa.kaspaToSompi(String(x));
const TARGET = S(arg("--target-tkas", "4000")), SKIP_AT = S(arg("--skip-at-tkas", "3900"));
let PER_TX = Number(arg("--per-tx", "15"));
const CAP = S(arg("--cap-tkas", "2050000")), FLOOR = S(arg("--floor-tkas", "1000000"));
const WAIT_ROWS = Number(arg("--wait-rows", "0")), WAIT_MIN = Number(arg("--wait-min", "25"));
const DRY = arg("--dry-run", "0") === "1";
const j = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const log = (o) => console.log(j({ t: new Date().toISOString(), ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tk = (s) => Number(s) / 1e8;
if (FROM < 7) { log({ phase: "abort", error: "from_below_7_refused" }); process.exit(2); }

// --- key (in memory only)
let privateKey;
{
  let v = process.env.KNS_TN10_TREASURY_KEY;
  if (typeof v !== "string" || !v.trim()) { log({ phase: "abort", error: "key_missing" }); process.exit(2); }
  v = v.trim();
  const hex = v.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) privateKey = new kaspa.PrivateKey(hex);
  else privateKey = new kaspa.XPrv(new kaspa.Mnemonic(v.split(/\s+/).join(" ")).toSeed()).derivePath("m/44'/111111'/0'/0/0").toPrivateKey();
  v = null;
}
const treasury = privateKey.toKeypair().toAddress(NETWORK).toString();
if (treasury !== EXPECTED) { log({ phase: "abort", error: "treasury_address_mismatch", derived: treasury }); process.exit(2); }
log({ phase: "key_ok", treasury });

// --- wait for rows
const readRows = () => {
  const m = new Map();
  for (const l of fs.readFileSync(CSV, "utf8").trim().split("\n").slice(1)) { const [i, a] = l.split(","); if (a) m.set(Number(i), a.trim()); }
  return m;
};
let rowsMap = readRows();
if (WAIT_ROWS) {
  const until = Date.now() + WAIT_MIN * 60000;
  while (rowsMap.size < WAIT_ROWS && Date.now() < until) { await sleep(20000); rowsMap = readRows(); log({ phase: "wait_rows", have: rowsMap.size, want: WAIT_ROWS }); }
  if (rowsMap.size < WAIT_ROWS) { log({ phase: "abort", error: "rows_not_ready", have: rowsMap.size }); process.exit(6); }
}
const recips = [];
for (let i = FROM; i <= TO; i++) { const a = rowsMap.get(i); if (a) recips.push({ index: i, address: a }); }
const uniq = new Set(recips.map((r) => r.address));
if (recips.some((r) => !r.address.startsWith("kaspatest:")) || uniq.size !== recips.length || recips.some((r) => r.address === treasury)) { log({ phase: "abort", error: "bad_recipient_set" }); process.exit(2); }
log({ phase: "recipients", count: recips.length, missing: TO - FROM + 1 - recips.length });

const status = fs.existsSync(STATUS) ? JSON.parse(fs.readFileSync(STATUS, "utf8")) : {};
status.runs = status.runs || [];
const run = { run_id: new Date().toISOString(), range: `${FROM}-${TO}`, target_tkas: tk(TARGET), cap_tkas: tk(CAP), floor_tkas: tk(FLOOR), dry_run: DRY, sent_tkas: 0, fees_tkas: 0, txs: 0, batches: 0, funded: [], skipped_already: [], failed: [], state: "running" };
status.runs.push(run);
const save = () => { status.updated_at = new Date().toISOString(); fs.writeFileSync(STATUS, JSON.stringify(status, null, 2) + "\n"); };

const rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: NETWORK });
await rpc.connect();
const info = await rpc.getServerInfo();
log({ phase: "rpc", url: rpc.url, isSynced: info.isSynced });
if (!info.isSynced) { log({ phase: "abort", error: "node_not_synced" }); process.exit(3); }
const balances = async (addrs) => { const m = new Map(); for (let k = 0; k < addrs.length; k += 50) { const r = await rpc.getBalancesByAddresses(addrs.slice(k, k + 50)); for (const e of r.entries) m.set(String(e.address), BigInt(e.balance ?? 0)); } return m; };

const tb0 = (await balances([treasury])).get(treasury) ?? 0n;
run.treasury_before_tkas = tk(tb0);
log({ phase: "treasury", before_tkas: tk(tb0) });

// initial skip pass
const b0 = await balances(recips.map((r) => r.address));
let todo = recips.filter((r) => { const b = b0.get(r.address) ?? 0n; if (b >= SKIP_AT) { run.skipped_already.push(r.index); return false; } return true; });
log({ phase: "plan", todo: todo.length, skipped_already: run.skipped_already.length, est_tkas: todo.length * tk(TARGET) });
save();

const { entries: allEntries } = await rpc.getUtxosByAddresses([treasury]);
const daa = BigInt((await rpc.getServerInfo()).virtualDaaScore);
const mature = allEntries.filter((e) => !e.isCoinbase || BigInt(e.blockDaaScore) + 3000n < daa).sort((a, b) => (BigInt(a.blockDaaScore) < BigInt(b.blockDaaScore) ? -1 : 1));
log({ phase: "utxos", count: allEntries.length, mature: mature.length });
let fr = 1;
try { const fe = await rpc.getFeeEstimate({}); fr = Math.max(1, Number(fe.estimate.normalBuckets?.[0]?.feerate ?? fe.estimate.priorityBucket.feerate ?? 1)); } catch {}
log({ phase: "fee", feeRate: fr });

let cursor = 0, sent = 0n, fees = 0n, consecutiveFail = 0;
while (todo.length) {
  let chunk = todo.slice(0, PER_TX);
  // live re-check right before batch
  const lb = await balances(chunk.map((r) => r.address));
  const skipNow = chunk.filter((r) => (lb.get(r.address) ?? 0n) >= SKIP_AT);
  for (const r of skipNow) run.skipped_already.push(r.index);
  todo = todo.filter((r) => !skipNow.includes(r));
  chunk = chunk.filter((r) => !skipNow.includes(r));
  if (!chunk.length) { save(); continue; }
  const outs = chunk.map((r) => ({ r, amount: TARGET - (lb.get(r.address) ?? 0n) }));
  const total = outs.reduce((s, o) => s + o.amount, 0n);
  const feeReserve = S(100);
  if (sent + total + fees + feeReserve > CAP) { log({ phase: "stop", reason: "run_cap_reached", sent_tkas: tk(sent) }); run.state = "stopped_cap"; break; }
  const tb = (await balances([treasury])).get(treasury) ?? 0n;
  if (tb - total - feeReserve < FLOOR) { log({ phase: "stop", reason: "treasury_floor", treasury_tkas: tk(tb) }); run.state = "stopped_floor"; break; }
  const need = total + feeReserve;
  const sel = []; let acc = 0n; const cur0 = cursor;
  while (acc < need && cursor < mature.length) { const e = mature[cursor++]; sel.push(e); acc += BigInt(e.amount); }
  if (acc < need) { log({ phase: "stop", reason: "insufficient_mature_utxos" }); run.state = "stopped_utxos"; break; }
  let gen;
  try {
    gen = await kaspa.createTransactions({ entries: sel, outputs: outs.map((o) => ({ address: o.r.address, amount: o.amount })), priorityFee: 0n, feeRate: fr, changeAddress: treasury, networkId: NETWORK });
  } catch (e) {
    log({ phase: "create_error", per_tx: PER_TX, msg: String(e).slice(0, 300) });
    cursor = cur0; // inputs unused
    if (PER_TX > 1) { PER_TX = Math.max(1, Math.floor(PER_TX / 2)); continue; }
    for (const o of outs) run.failed.push({ index: o.r.index, error: "create_failed" }); todo = todo.slice(chunk.length); save(); if (++consecutiveFail >= 3) break; continue;
  }
  const { transactions, summary } = gen;
  const finalId = summary.finalTransactionId;
  if (DRY) { log({ phase: "dry_batch", indices: chunk.map((r) => r.index), txs: transactions.length, fees_tkas: tk(summary.fees) }); todo = todo.slice(chunk.length); continue; }
  let submitted = 0, err = null;
  for (const p of transactions) { try { p.sign([privateKey]); await p.submit(rpc); submitted++; } catch (e) { err = String(e); break; } }
  run.txs += submitted;
  if (err) {
    log({ phase: "submit_error", submitted, of: transactions.length, msg: err.slice(0, 300) });
    // conservatively count full amount against cap if the final tx may have gone out
    if (submitted === transactions.length) { sent += total; fees += BigInt(summary.fees); }
    save();
    if (++consecutiveFail >= 3) { run.state = "stopped_errors"; break; }
    if (PER_TX > 1) PER_TX = Math.max(1, Math.floor(PER_TX / 2));
    await sleep(10000);
    // refetch utxos (used inputs may now be spent)
    const { entries: ne } = await rpc.getUtxosByAddresses([treasury]);
    const d2 = BigInt((await rpc.getServerInfo()).virtualDaaScore);
    mature.length = 0; mature.push(...ne.filter((e) => !e.isCoinbase || BigInt(e.blockDaaScore) + 3000n < d2).sort((a, b) => (BigInt(a.blockDaaScore) < BigInt(b.blockDaaScore) ? -1 : 1))); cursor = 0;
    continue; // live re-check will skip any that did land
  }
  consecutiveFail = 0;
  sent += total; fees += BigInt(summary.fees); run.batches++;
  run.sent_tkas = tk(sent); run.fees_tkas = tk(fees);
  // wait for acceptance
  let ok = false, bb;
  for (let w = 0; w < 40 && !ok; w++) { await sleep(3000); bb = await balances(chunk.map((r) => r.address)); ok = chunk.every((r) => (bb.get(r.address) ?? 0n) >= SKIP_AT); }
  const rec = { t: new Date().toISOString(), run: "desk-" + run.range, txid: finalId, batch_txs: transactions.length, indices: chunk.map((r) => r.index), amounts_tkas: outs.map((o) => tk(o.amount)), amount_tkas_total: tk(total), fees_tkas: tk(summary.fees), inputs: sel.length, confirmed: ok };
  fs.appendFileSync(JSONL, JSON.stringify(rec) + "\n");
  log({ phase: "batch", ...rec });
  for (const r of chunk) run.funded.push(r.index);
  todo = todo.slice(chunk.length);
  save();
  if (!ok) { log({ phase: "stop", reason: "batch_not_confirmed_120s", txid: finalId }); run.state = "stopped_unconfirmed"; break; }
}
const ta = (await balances([treasury])).get(treasury) ?? 0n;
run.treasury_after_tkas = tk(ta); run.sent_tkas = tk(sent); run.fees_tkas = tk(fees);
if (run.state === "running") run.state = todo.length ? "incomplete" : "done";
run.remaining = todo.map((r) => r.index);
run.finished_at = new Date().toISOString();
save();
log({ phase: "done", state: run.state, funded: run.funded.length, skipped_already: run.skipped_already.length, failed: run.failed.length, sent_tkas: run.sent_tkas, fees_tkas: run.fees_tkas, txs: run.txs, batches: run.batches, treasury_after_tkas: run.treasury_after_tkas });
await rpc.disconnect();
