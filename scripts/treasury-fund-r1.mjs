#!/usr/bin/env node
/**
 * R1 funding pass (TN10 only): fund snapshot wallets 20700-25699 with (KNS fee for its r1 name + MARGIN) from the treasury,
 * strictly in index order, as far as the budget allows. One pass, then exit (r1-fund-loop.mjs re-runs it every ~10 min).
 * Key: loaded IN-PROCESS ONLY from env KNS_TN10_TREASURY_KEY (user-authorized).
 * NEVER prints/logs/copies the key. Reads no other secret entries.
 * Budget = treasury - FLOOR(20000) - reserve still needed by the tn10-million-test funder ((100000-next_index)*0.5 + 100 while not done)
 *          - a 100 TKAS fee reserve.
 * Refuses to start if another treasury-fund* process or the tn10-million-test funder is running.
 * Logs: snapshot-wallets/desk-fund-r1.jsonl (per batch), desk-fund-r1-status.json (cumulative).
 * Usage: node treasury-fund-r1.mjs [--margin-tkas 1.5] [--per-tx 20] [--floor-tkas 20000] [--dry-run 1]
 */
import fs from "node:fs";
import { otherSpenders } from "./r1-spenders.mjs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);

try { fs.writeFileSync("/proc/self/oom_score_adj", "500"); } catch {}
const NETWORK = "testnet-10";
// Treasury key comes from env KNS_TN10_TREASURY_KEY (hex or mnemonic). Never commit it.
const EXPECTED = "kaspatest:qzffl5xy9np46gkttyuftqnv2w04pr8g3wsp7c3vv8se3txtelx6q7c0v0ldx";
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const NAMES = `${OUT}/r1-names.csv`, OVERRIDES = `${OUT}/r1-name-overrides.jsonl`;
const JSONL = `${OUT}/desk-fund-r1.jsonl`, STATUS = `${OUT}/desk-fund-r1-status.json`;
const MILLION = "/workspace/artifacts/tn10-million-test/fund-status.json";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d; };
const S = (x) => kaspa.kaspaToSompi(String(x));
const tk = (s) => Number(s) / 1e8;
const MARGIN = S(arg("--margin-tkas", "1.5")), SKIP_SLACK = S("0.4");
let PER_TX = Number(arg("--per-tx", "20"));
const FLOOR = S(arg("--floor-tkas", "20000")), FEE_RESERVE = S("100");
const DRY = arg("--dry-run", "0") === "1";
const j = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const log = (o) => console.log(j({ t: new Date().toISOString(), ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const feeFor = (n) => (n <= 2 ? 4200 : n === 3 ? 2100 : n === 4 ? 525 : 35);

const othersActive = () => otherSpenders(process.pid);
function millionReserve() {
  try { const m = JSON.parse(fs.readFileSync(MILLION, "utf8")); if (m.state === "done") return 0n; const left = BigInt(Math.max(0, (m.count || 100000) - (m.next_index || 0))); return left * S("0.5") + S("100"); } catch { return S("52000"); }
}
const busy = othersActive();
if (busy.length && !DRY) { log({ phase: "abort", error: "other_treasury_spender_active", procs: busy }); process.exit(9); }

// --- key (in memory only)
let privateKey;
{
  let v = process.env.KNS_TN10_TREASURY_KEY;
  if (typeof v !== "string" || !v.trim()) { log({ phase: "abort", error: "key_missing" }); process.exit(2); }
  v = v.trim(); const hex = v.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(hex)) privateKey = new kaspa.PrivateKey(hex);
  else privateKey = new kaspa.XPrv(new kaspa.Mnemonic(v.split(/\s+/).join(" ")).toSeed()).derivePath("m/44'/111111'/0'/0/0").toPrivateKey();
  v = null;
}
const treasury = privateKey.toKeypair().toAddress(NETWORK).toString();
if (treasury !== EXPECTED) { log({ phase: "abort", error: "treasury_address_mismatch" }); process.exit(2); }

// --- recipients (index order) with per-wallet target = fee(current name) + margin
const overrides = new Map();
try { for (const l of fs.readFileSync(OVERRIDES, "utf8").split("\n")) { if (!l) continue; const o = JSON.parse(l); overrides.set(o.index, o); } } catch {}
const recips = fs.readFileSync(NAMES, "utf8").trim().split("\n").slice(1).map((l) => { const [i, a, n, len] = l.split(","); const o = overrides.get(+i); const L = o ? o.name.length : +len; return { index: +i, address: a, name: o ? o.name : n, fee: feeFor(L), target: S(feeFor(L)) + MARGIN }; });
if (recips.length !== 5000 || recips.some((r) => !r.address.startsWith("kaspatest:") || r.address === treasury || r.index < 20700 || r.index > 25699)) { log({ phase: "abort", error: "bad_recipient_set" }); process.exit(2); }

const status = fs.existsSync(STATUS) ? JSON.parse(fs.readFileSync(STATUS, "utf8")) : { funded_indices: [], sent_tkas_total: 0, fees_tkas_total: 0, txs_total: 0, passes: 0, runs: [] };
const funded = new Set(status.funded_indices);
const run = { run_id: new Date().toISOString(), pid: process.pid, dry_run: DRY, margin_tkas: tk(MARGIN), floor_tkas: tk(FLOOR), sent_tkas: 0, fees_tkas: 0, txs: 0, batches: 0, funded: 0, already_ok: 0, state: "running" };
const save = () => {
  if (DRY) return;
  status.funded_indices = [...funded].sort((a, b) => a - b); status.funded_total = funded.size;
  status.runs = [...status.runs.filter((r) => r.run_id !== run.run_id), run].slice(-30);
  status.updated_at = new Date().toISOString(); const tmp = STATUS + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(status, null, 2) + "\n"); fs.renameSync(tmp, STATUS);
};

const rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: NETWORK });
await rpc.connect();
const info = await rpc.getServerInfo();
if (!info.isSynced) { log({ phase: "abort", error: "node_not_synced" }); await rpc.disconnect(); process.exit(3); }
log({ phase: "rpc", url: rpc.url });
const balances = async (addrs) => { const m = new Map(); for (let k = 0; k < addrs.length; k += 100) { const r = await rpc.getBalancesByAddresses(addrs.slice(k, k + 100)); for (const e of r.entries) m.set(String(e.address), BigInt(e.balance ?? 0)); } return m; };

// live balances for all not-yet-marked wallets: mark those already >= target - slack as funded
const unmarked = recips.filter((r) => !funded.has(r.index));
const b0 = await balances(unmarked.map((r) => r.address));
for (const r of unmarked) if ((b0.get(r.address) ?? 0n) >= r.target - SKIP_SLACK) { funded.add(r.index); run.already_ok++; }
let todo = recips.filter((r) => !funded.has(r.index));
const tb0 = (await balances([treasury])).get(treasury) ?? 0n;
const reserve = millionReserve();
run.treasury_before_tkas = tk(tb0); run.million_reserve_tkas = tk(reserve);
run.remaining_need_tkas = tk(todo.reduce((s, r) => s + r.target - (b0.get(r.address) ?? 0n), 0n));
log({ phase: "plan", todo: todo.length, treasury_tkas: tk(tb0), million_reserve_tkas: tk(reserve), remaining_need_tkas: run.remaining_need_tkas });
save();
if (!todo.length) { run.state = "all_funded"; status.all_funded = true; save(); await rpc.disconnect(); process.exit(0); }

let mature = [], cursor = 0;
async function loadUtxos() {
  const { entries } = await rpc.getUtxosByAddresses([treasury]);
  const daa = BigInt((await rpc.getServerInfo()).virtualDaaScore);
  mature = entries.filter((e) => !e.isCoinbase || BigInt(e.blockDaaScore) + 3000n < daa).sort((a, b) => (BigInt(a.amount) > BigInt(b.amount) ? -1 : 1)); cursor = 0;
  log({ phase: "utxos", count: entries.length, mature: mature.length, mature_tkas: tk(mature.reduce((s, e) => s + BigInt(e.amount), 0n)) });
}
await loadUtxos();
let fr = 1;
try { const fe = await rpc.getFeeEstimate({}); fr = Math.max(1, Number(fe.estimate.normalBuckets?.[0]?.feerate ?? fe.estimate.priorityBucket.feerate ?? 1)); } catch {}

let consecutiveFail = 0;
while (todo.length) {
  if (fs.existsSync(`${OUT}/r1-FUND-STOP`) || fs.existsSync(`${OUT}/r1-STOP`)) { run.state = "stopped_stopfile"; break; }
  if (!DRY && othersActive().length) { run.state = "yielded_other_spender"; log({ phase: "yield", procs: othersActive() }); break; }
  const tb = (await balances([treasury])).get(treasury) ?? 0n;
  const budget = tb - FLOOR - millionReserve() - FEE_RESERVE;
  const lb = await balances(todo.slice(0, PER_TX).map((r) => r.address));
  const chunk = []; let total = 0n;
  for (const r of todo.slice(0, PER_TX)) {
    const have = lb.get(r.address) ?? 0n;
    if (have >= r.target - SKIP_SLACK) { chunk.push({ r, amount: 0n }); continue; }
    const amt = r.target - have;
    if (total + amt > budget) break;                     // strict index order: stop at the first wallet we cannot afford
    chunk.push({ r, amount: amt }); total += amt;
  }
  const already = chunk.filter((c) => c.amount === 0n);
  for (const c of already) { funded.add(c.r.index); run.already_ok++; }
  const outs = chunk.filter((c) => c.amount > 0n);
  todo = todo.filter((r) => !already.some((c) => c.r === r));
  if (!outs.length) {
    if (already.length) { save(); continue; }
    run.state = "budget_exhausted"; run.next_index = todo[0].index; run.next_need_tkas = tk(todo[0].target - (lb.get(todo[0].address) ?? 0n)); run.budget_tkas = tk(budget);
    log({ phase: "stop", reason: "budget", next_index: run.next_index, next_need_tkas: run.next_need_tkas, budget_tkas: tk(budget), treasury_tkas: tk(tb) }); break;
  }
  const need = total + S("5");
  const sel = []; let acc = 0n; const cur0 = cursor;
  while (acc < need && cursor < mature.length) { const e = mature[cursor++]; sel.push(e); acc += BigInt(e.amount); }
  if (acc < need) { run.state = "stopped_mature_utxos"; log({ phase: "stop", reason: "insufficient_mature_utxos", need_tkas: tk(need) }); cursor = cur0; break; }
  let gen;
  try { gen = await kaspa.createTransactions({ entries: sel, outputs: outs.map((o) => ({ address: o.r.address, amount: o.amount })), priorityFee: 0n, feeRate: fr, changeAddress: treasury, networkId: NETWORK }); }
  catch (e) { log({ phase: "create_error", per_tx: PER_TX, msg: String(e).slice(0, 300) }); cursor = cur0; if (PER_TX > 1) { PER_TX = Math.max(1, Math.floor(PER_TX / 2)); continue; } run.state = "stopped_create_error"; break; }
  const { transactions, summary } = gen; const finalId = summary.finalTransactionId;
  if (DRY) { log({ phase: "dry_batch", indices: outs.map((o) => o.r.index), amount_tkas: tk(total), txs: transactions.length, fees_tkas: tk(summary.fees) }); for (const o of outs) funded.add(o.r.index); todo = todo.filter((r) => !outs.some((o) => o.r === r)); continue; }
  let submitted = 0, err = null;
  for (const p of transactions) { try { p.sign([privateKey]); await p.submit(rpc); submitted++; } catch (e) { err = String(e); break; } }
  run.txs += submitted;
  if (err) {
    log({ phase: "submit_error", submitted, of: transactions.length, msg: err.slice(0, 300) });
    fs.appendFileSync(JSONL, JSON.stringify({ t: new Date().toISOString(), phase: "submit_error", submitted, of: transactions.length, indices: outs.map((o) => o.r.index), msg: err.slice(0, 200) }) + "\n");
    save(); if (++consecutiveFail >= 3) { run.state = "stopped_errors"; break; }
    if (PER_TX > 1) PER_TX = Math.max(1, Math.floor(PER_TX / 2));
    await sleep(15000); await loadUtxos(); continue;   // live re-check skips anything that did land
  }
  consecutiveFail = 0;
  let ok = false, bb;
  for (let w = 0; w < 50 && !ok; w++) { await sleep(3000); bb = await balances(outs.map((o) => o.r.address)); ok = outs.every((o) => (bb.get(o.r.address) ?? 0n) >= o.r.target - SKIP_SLACK); }
  run.batches++; run.sent_tkas += tk(total); run.fees_tkas += tk(summary.fees);
  status.sent_tkas_total = +(status.sent_tkas_total + tk(total)).toFixed(8); status.fees_tkas_total = +(status.fees_tkas_total + tk(summary.fees)).toFixed(8); status.txs_total += submitted;
  const rec = { t: new Date().toISOString(), txid: finalId, batch_txs: transactions.length, indices: outs.map((o) => o.r.index), names: outs.map((o) => o.r.name), amounts_tkas: outs.map((o) => tk(o.amount)), amount_tkas_total: tk(total), fees_tkas: tk(summary.fees), inputs: sel.length, confirmed: ok };
  if (!DRY) fs.appendFileSync(JSONL, JSON.stringify(rec) + "\n");
  log({ phase: "batch", ...rec, names: undefined });
  const landed = outs.filter((o) => (bb.get(o.r.address) ?? 0n) >= o.r.target - SKIP_SLACK);
  for (const o of landed) { funded.add(o.r.index); run.funded++; }
  todo = todo.filter((r) => !outs.some((o) => o.r === r) || !landed.some((o) => o.r === r));
  save();
  if (!ok) { run.state = "stopped_unconfirmed"; log({ phase: "stop", reason: "batch_not_confirmed_150s", txid: finalId }); break; }
}
const ta = (await balances([treasury])).get(treasury) ?? 0n;
run.treasury_after_tkas = tk(ta); if (run.state === "running") run.state = todo.length ? "incomplete" : "all_funded";
if (!todo.length) status.all_funded = true;
run.remaining = todo.length; run.finished_at = new Date().toISOString(); status.passes++; status.treasury_last_tkas = tk(ta);
save();
log({ phase: "done", state: run.state, funded_this_pass: run.funded, funded_total: funded.size, sent_tkas: run.sent_tkas, fees_tkas: run.fees_tkas, txs: run.txs, treasury_after_tkas: tk(ta), remaining: todo.length });
await rpc.disconnect();
process.exit(0);
