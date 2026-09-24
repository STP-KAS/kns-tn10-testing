#!/usr/bin/env node
/**
 * S3 funding: top up NEW snapshot wallets 700-20699 (TN10): 700-10699 to TARGET (3 names + margin), >= --tier2-from to TIER2 target (2 names + margin) from the treasury.
 * Key: loaded IN-PROCESS ONLY from env KNS_TN10_TREASURY_KEY (user-authorized).
 * NEVER prints/logs/copies the key. Reads no other secret entries.
 *
 * - Waits for the desk-fund-200-699 funder to finish (pid gone or "phase":"done" in its log) before touching UTXOs.
 * - Rounds of up to --rounds batches, each batch = one createTransactions() with up to --per-tx outputs;
 *   batches in a round use disjoint input sets; waits for all recipients to show balance before the next round.
 * - Live balance re-check before each round (skip >= SKIP_AT). Treasury floor (--floor-tkas): funds as many as fit, in index order.
 *
 * --topup-wait-min N: when floor-limited, sleep N minutes and retry (treasury is refilled by the TN10 farm miner).
 * Usage: node treasury-fund-s3.mjs --from 700 --to 20699 --target-tkas 120 --skip-at-tkas 110 --per-tx 30 --rounds 3 --floor-tkas 100000
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);

// Under memory pressure, let the kernel OOM-kill this process before the TN10 miner farm's kaspad.
try { fs.writeFileSync("/proc/self/oom_score_adj", "1000"); } catch {}
const NETWORK = "testnet-10";
// Treasury key comes from env KNS_TN10_TREASURY_KEY (hex or mnemonic). Never commit it.
const EXPECTED = "kaspatest:qzffl5xy9np46gkttyuftqnv2w04pr8g3wsp7c3vv8se3txtelx6q7c0v0ldx";
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const CSV = `${OUT}/addresses.csv`;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d; };
const FROM = Number(arg("--from", "700")), TO = Number(arg("--to", "10699"));
const TAG = `${FROM}-${TO}`;
const JSONL = `${OUT}/desk-fund-${TAG}.jsonl`;
const STATUS = `${OUT}/desk-fund-${TAG}-status.json`;
const S = (x) => kaspa.kaspaToSompi(String(x));
const TARGET = S(arg("--target-tkas", "120")), SKIP_AT = S(arg("--skip-at-tkas", "110"));
// tier 2 (2-name wallets): index >= TIER2_FROM funded to TIER2_TARGET, skip at TIER2_SKIP_AT
const TIER2_FROM = Number(arg("--tier2-from", "1000000000"));
const TIER2_TARGET = S(arg("--tier2-target-tkas", "85")), TIER2_SKIP_AT = S(arg("--tier2-skip-at-tkas", "78"));
const tgt = (i) => (i >= TIER2_FROM ? TIER2_TARGET : TARGET);
const skipAt = (i) => (i >= TIER2_FROM ? TIER2_SKIP_AT : SKIP_AT);
// a wallet whose s3 worker already inscribed a name was funded before (balance dropped by spending) -> never re-fund
const API_DIR = "/workspace/artifacts/kns-tn10/api";
const startedByWorker = (i) => { const w = String(i).padStart(5, "0"); return fs.existsSync(`${API_DIR}/smoke-result-stp-s3-w${w}-d0.json`) || fs.existsSync(`${API_DIR}/snap-child-stp-s3-w${w}-d0.log`); };
const isFunded = (r, bal) => (bal ?? 0n) >= skipAt(r.index) || startedByWorker(r.index);
let PER_TX = Number(arg("--per-tx", "30"));
const ROUNDS = Number(arg("--rounds", "3"));
const FLOOR = S(arg("--floor-tkas", "100000"));
const WAIT_PID = Number(arg("--wait-pid", "0"));
const WAIT_LOG = arg("--wait-log", "");
const DRY = arg("--dry-run", "0") === "1";
const TOPUP_WAIT_MIN = Number(arg("--topup-wait-min", "0")); // >0: when floor-limited, wait and retry as mining refills the treasury
process.on("unhandledRejection", (e) => { console.log(JSON.stringify({ t: new Date().toISOString(), phase: "unhandled_rejection", msg: String(e).slice(0, 200) })); });
const j = (o) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const log = (o) => console.log(j({ t: new Date().toISOString(), ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tk = (s) => Number(s) / 1e8;
if (FROM < 700) { log({ phase: "abort", error: "from_below_700_refused (0-699 owned by another worker)" }); process.exit(2); }

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
if (treasury !== EXPECTED) { log({ phase: "abort", error: "treasury_address_mismatch" }); process.exit(2); }
log({ phase: "key_ok", treasury });

// --- wait for the other funder to finish (never spend the same UTXOs concurrently)
if (WAIT_PID || WAIT_LOG) {
  const alive = () => { if (!WAIT_PID) return false; try { process.kill(WAIT_PID, 0); return true; } catch { return false; } };
  const doneInLog = () => { try { return WAIT_LOG && fs.readFileSync(WAIT_LOG, "utf8").includes('"phase":"done"'); } catch { return false; } };
  let n = 0;
  while (alive() && !doneInLog()) { if (n++ % 6 === 0) log({ phase: "wait_other_funder", pid: WAIT_PID }); await sleep(10000); }
  log({ phase: "other_funder_finished", pid_alive: alive(), done_line: doneInLog() });
  await sleep(15000); // let its last tx settle into the UTXO index
}

const rowsMap = new Map();
for (const l of fs.readFileSync(CSV, "utf8").trim().split("\n").slice(1)) { const [i, a] = l.split(","); if (a) rowsMap.set(Number(i), a.trim()); }
const recips = [];
for (let i = FROM; i <= TO; i++) { const a = rowsMap.get(i); if (a) recips.push({ index: i, address: a }); }
const uniq = new Set(recips.map((r) => r.address));
if (recips.some((r) => !r.address.startsWith("kaspatest:")) || uniq.size !== recips.length || recips.some((r) => r.address === treasury)) { log({ phase: "abort", error: "bad_recipient_set" }); process.exit(2); }
log({ phase: "recipients", count: recips.length, missing: TO - FROM + 1 - recips.length });

const status = fs.existsSync(STATUS) ? JSON.parse(fs.readFileSync(STATUS, "utf8")) : {};
status.runs = status.runs || [];
const run = { run_id: new Date().toISOString(), range: TAG, target_tkas: tk(TARGET), skip_at_tkas: tk(SKIP_AT), tier2_from: TIER2_FROM, tier2_target_tkas: tk(TIER2_TARGET), tier2_skip_at_tkas: tk(TIER2_SKIP_AT), floor_tkas: tk(FLOOR), per_tx: PER_TX, rounds: ROUNDS, dry_run: DRY, sent_tkas: 0, fees_tkas: 0, txs: 0, batches: 0, funded_count: 0, skipped_count: 0, funded_max_index: null, failed: [], state: "running" };
status.runs.push(run);
const funded = new Set(status.funded_indices || []);
const save = () => { status.updated_at = new Date().toISOString(); status.funded_indices = [...funded].sort((a, b) => a - b); status.funded_total = funded.size; fs.writeFileSync(STATUS, JSON.stringify(status, null, 2) + "\n"); };

let rpc;
const connect = async () => {
  rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: NETWORK });
  await rpc.connect();
  const info = await rpc.getServerInfo();
  log({ phase: "rpc", url: rpc.url, isSynced: info.isSynced });
  if (!info.isSynced) throw new Error("node_not_synced");
};
await connect();
const withRpc = async (fn, what) => {
  for (let a = 0; ; a++) {
    try { return await fn(); }
    catch (e) {
      log({ phase: "rpc_retry", what, attempt: a + 1, msg: String(e).slice(0, 160) });
      if (a >= 8) throw e;
      await sleep(5000 * Math.min(a + 1, 6));
      try { await rpc.disconnect(); } catch {}
      try { await connect(); } catch (e2) { log({ phase: "rpc_reconnect_failed", msg: String(e2).slice(0, 160) }); }
    }
  }
};
const balances = async (addrs) => { const m = new Map(); for (let k = 0; k < addrs.length; k += 100) { const r = await withRpc(() => rpc.getBalancesByAddresses(addrs.slice(k, k + 100)), "balances"); for (const e of r.entries) m.set(String(e.address), BigInt(e.balance ?? 0)); } return m; };
const treasuryBal = async () => (await balances([treasury])).get(treasury) ?? 0n;

const tb0 = await treasuryBal();
run.treasury_before_tkas = tk(tb0);
log({ phase: "treasury", before_tkas: tk(tb0) });

// initial skip pass
const b0 = await balances(recips.map((r) => r.address));
let todo = recips.filter((r) => { if (isFunded(r, b0.get(r.address))) { funded.add(r.index); run.skipped_count++; return false; } return true; });
log({ phase: "plan", todo: todo.length, skipped_already: run.skipped_count, est_tkas: todo.reduce((a, r) => a + tk(tgt(r.index)), 0) });
save();

let mature = [], cursor = 0;
const loadUtxos = async () => {
  mature = [];
  const { entries } = await withRpc(() => rpc.getUtxosByAddresses([treasury]), "utxos");
  const daa = BigInt((await withRpc(() => rpc.getServerInfo(), "info")).virtualDaaScore);
  mature = entries.filter((e) => !e.isCoinbase || BigInt(e.blockDaaScore) + 3000n < daa).sort((a, b) => (BigInt(a.blockDaaScore) < BigInt(b.blockDaaScore) ? -1 : 1));
  cursor = 0;
  log({ phase: "utxos", count: entries.length, mature: mature.length });
};
await loadUtxos();
let fr = 1;
try { const fe = await rpc.getFeeEstimate({}); fr = Math.max(1, Number(fe.estimate.normalBuckets?.[0]?.feerate ?? fe.estimate.priorityBucket.feerate ?? 1)); } catch {}
log({ phase: "fee", feeRate: fr });

let sent = 0n, fees = 0n, consecutiveFail = 0;
const FEE_RESERVE_PER_BATCH = S(25);
outer: while (todo.length) {
  // live re-check for the next round's candidates
  let cand = todo.slice(0, PER_TX * ROUNDS);
  const lb = await balances(cand.map((r) => r.address));
  const skipNow = cand.filter((r) => isFunded(r, lb.get(r.address)));
  for (const r of skipNow) { funded.add(r.index); run.skipped_count++; }
  const skipSet = new Set(skipNow.map((r) => r.index));
  todo = todo.filter((r) => !skipSet.has(r.index));
  cand = cand.filter((r) => !skipSet.has(r.index));
  if (!cand.length) { save(); continue; }
  // floor: fund as many as fit, index order
  const tb = await treasuryBal();
  const nBatches = Math.ceil(cand.length / PER_TX);
  const avail = tb - FLOOR - FEE_RESERVE_PER_BATCH * BigInt(nBatches);
  let fit = 0, acc0 = 0n;
  for (const r of cand) { const amt = tgt(r.index) - (lb.get(r.address) ?? 0n); if (acc0 + amt > avail) break; acc0 += amt; fit++; }
  if (fit < cand.length) { cand = cand.slice(0, fit); log({ phase: "floor_limit", treasury_tkas: tk(tb), fit }); }
  if (!cand.length) {
    if (TOPUP_WAIT_MIN > 0) {
      run.state = "waiting_treasury_refill"; run.funded_count = funded.size; save();
      log({ phase: "floor_wait", treasury_tkas: tk(tb), funded_total: funded.size, remaining: todo.length, next_check_min: TOPUP_WAIT_MIN });
      await sleep(TOPUP_WAIT_MIN * 60000);
      try { await loadUtxos(); } catch (e2) { log({ phase: "rpc_error", msg: String(e2).slice(0, 200) }); try { await rpc.disconnect(); } catch {} await connect(); await loadUtxos(); }
      run.state = "running"; continue;
    }
    log({ phase: "stop", reason: "treasury_floor", treasury_tkas: tk(tb) }); run.state = "stopped_floor"; break;
  }
  const roundBatches = [];
  let roundErr = null;
  // build one batch: select inputs from the cursor; on generator mass edge cases, perturb the input set (add inputs / skip ahead)
  const build = async (outs, total) => {
    const need = total + FEE_RESERVE_PER_BATCH;
    for (let win = 0; win < 4; win++) {
      const cur0 = cursor; const sel = []; let acc = 0n;
      while (acc < need && cursor < mature.length) { const e = mature[cursor++]; sel.push(e); acc += BigInt(e.amount); }
      if (acc < need) { cursor = cur0; return { exhausted: true }; }
      for (let extra = 0; extra < 6; extra++) {
        try {
          const gen = await kaspa.createTransactions({ entries: sel, outputs: outs.map((o) => ({ address: o.r.address, amount: o.amount })), priorityFee: 0n, feeRate: fr, changeAddress: treasury, networkId: NETWORK });
          return { gen, sel };
        } catch (e) {
          log({ phase: "create_retry", win, extra, inputs: sel.length, msg: String(e).slice(0, 160) });
          if (cursor >= mature.length) break;
          const e2 = mature[cursor++]; sel.push(e2); acc += BigInt(e2.amount);
        }
      }
      cursor = Math.min(mature.length, cursor + 7); // abandon this window's inputs for this snapshot, shift alignment
    }
    return { error: "create_failed_after_retries" };
  };
  for (let k = 0; k < cand.length; k += PER_TX) {
    const chunk = cand.slice(k, k + PER_TX);
    const outs = chunk.map((r) => ({ r, amount: tgt(r.index) - (lb.get(r.address) ?? 0n) }));
    const total = outs.reduce((s, o) => s + o.amount, 0n);
    let b = await build(outs, total);
    if (b.exhausted) { log({ phase: "utxo_refresh", reason: "snapshot_exhausted" }); if (roundBatches.length) break; await loadUtxos(); b = await build(outs, total); if (b.exhausted) { roundErr = "no_utxos"; break; } }
    if (b.error) { log({ phase: "create_error", msg: b.error }); roundErr = b.error; break; }
    const { transactions, summary } = b.gen; const sel = b.sel;
    if (DRY) { log({ phase: "dry_batch", indices: chunk.map((r) => r.index), txs: transactions.length, fees_tkas: tk(summary.fees) }); roundBatches.push({ chunk, outs, total, summary, txs: transactions.length, sel, dry: true }); continue; }
    let submitted = 0, err = null;
    for (const p of transactions) { try { p.sign([privateKey]); await p.submit(rpc); submitted++; } catch (e) { err = String(e); break; } }
    run.txs += submitted;
    if (err) {
      log({ phase: "submit_error", submitted, of: transactions.length, from: chunk[0].index, to: chunk.at(-1).index, msg: err.slice(0, 300) });
      if (submitted === transactions.length) roundBatches.push({ chunk, outs, total, summary, txs: transactions.length, sel, finalId: summary.finalTransactionId });
      roundErr = "submit_error"; break;
    }
    roundBatches.push({ chunk, outs, total, summary, txs: transactions.length, sel, finalId: summary.finalTransactionId });
  }
  if (roundErr && !roundBatches.length) {
    if (++consecutiveFail >= 8) { run.state = "stopped_errors"; break outer; }
    await sleep(15000);
    try { await loadUtxos(); } catch (e2) { log({ phase: "rpc_error", msg: String(e2).slice(0, 200) }); try { await rpc.disconnect(); } catch {} await connect(); await loadUtxos(); }
    continue outer; // live re-check will skip any that did land
  }
  if (DRY) { todo = todo.slice(cand.length); if (run.batches++ > 2) break; continue; }
  if (!roundBatches.length) continue;
  const roundRecips = roundBatches.flatMap((b) => b.chunk);
  let ok = false, bb;
  for (let w = 0; w < 60 && !ok; w++) { await sleep(3000); bb = await balances(roundRecips.map((r) => r.address)); ok = roundRecips.every((r) => (bb.get(r.address) ?? 0n) >= skipAt(r.index)); }
  for (const b of roundBatches) {
    sent += b.total; fees += BigInt(b.summary.fees); run.batches++;
    const conf = b.chunk.every((r) => (bb.get(r.address) ?? 0n) >= skipAt(r.index));
    const rec = { t: new Date().toISOString(), run: "desk-" + TAG, txid: b.finalId, batch_txs: b.txs, indices: b.chunk.map((r) => r.index), amounts_tkas: b.outs.map((o) => tk(o.amount)), amount_tkas_total: tk(b.total), fees_tkas: tk(b.summary.fees), inputs: b.sel.length, confirmed: conf };
    fs.appendFileSync(JSONL, JSON.stringify(rec) + "\n");
    log({ phase: "batch", txid: rec.txid, batch_txs: rec.batch_txs, from: rec.indices[0], to: rec.indices.at(-1), n: rec.indices.length, amount_tkas_total: rec.amount_tkas_total, fees_tkas: rec.fees_tkas, inputs: rec.inputs, confirmed: conf });
    for (const r of b.chunk) if ((bb.get(r.address) ?? 0n) >= skipAt(r.index)) funded.add(r.index);
  }
  if (!roundErr) consecutiveFail = 0;
  const done = new Set(roundRecips.map((r) => r.index));
  // fully-submitted batches: confirmed -> funded; not yet visible -> re-verify once after 60s, else retry via live re-check
  const unconf = roundRecips.filter((r) => !funded.has(r.index));
  if (unconf.length) {
    await sleep(60000);
    const ub = await balances(unconf.map((r) => r.address));
    for (const r of unconf) if (isFunded(r, ub.get(r.address))) funded.add(r.index);
    log({ phase: "unconfirmed_recheck", count: unconf.length, now_funded: unconf.filter((r) => funded.has(r.index)).length });
  }
  todo = todo.filter((r) => !done.has(r.index) || !funded.has(r.index));
  run.sent_tkas = tk(sent); run.fees_tkas = tk(fees); run.funded_count = funded.size; run.funded_max_index = Math.max(...funded);
  save();
  if (roundErr) { consecutiveFail++; await sleep(10000); try { await loadUtxos(); } catch (e2) { try { await rpc.disconnect(); } catch {} await connect(); await loadUtxos(); } }
  if (!ok) { log({ phase: "warn", reason: "round_not_fully_confirmed_180s" }); await sleep(10000); await loadUtxos(); }
}
const ta = await treasuryBal();
run.treasury_after_tkas = tk(ta); run.sent_tkas = tk(sent); run.fees_tkas = tk(fees); run.funded_count = funded.size;
if (run.state === "running") run.state = todo.length ? "incomplete" : "done";
run.remaining_count = todo.length; run.remaining_first = todo[0]?.index ?? null;
run.finished_at = new Date().toISOString();
save();
log({ phase: "done", state: run.state, funded_total: funded.size, skipped_already: run.skipped_count, remaining: todo.length, sent_tkas: run.sent_tkas, fees_tkas: run.fees_tkas, txs: run.txs, batches: run.batches, treasury_after_tkas: run.treasury_after_tkas });
await rpc.disconnect();
process.exit(0);
