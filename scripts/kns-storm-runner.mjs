#!/usr/bin/env node
/**
 * KNS TN10 storm registration runner (prepared 2026-10-01). TN10 ONLY.
 *
 * - Random labels [a-z0-9], first char a letter, random length LEN_MIN..LEN_MAX (default 5..10 => 35 TKAS tier).
 * - DEFAULT --owner-mode payer: a random snapshot wallet that can afford the name pays the commit and owns/signs the reveal
 *   (attribution path proven 26 Sep). --owner-mode split (opt-in): random owner 0..25699 funded by other wallets. Funding = leftover balances of snapshot
 *   wallets only (tracked locally from utxo-snapshot.json + own event journal). NEVER spends treasury / farm UTXOs.
 * - Commit and reveal are submitted to n0 (ws://127.0.0.1:17210, utxoindex OFF is fine). No UTXO-by-address lookups.
 * - No per-name KNS indexer calls. Optional sparse public REST tx confirmation sample (logged).
 * - Rate param --rate (default 30/min); hard cap 30 names/min (sliding 60 s window). STOP file => graceful drain + exit.
 * - Broadcast requires BOTH `--broadcast 1` AND env KNS_STORM_GO=1. Otherwise only --dry-run N (build+sign, never submit).
 * Never prints keys.
 *
 * Rebuilt 2026-10-02 (box rebuild lost the 1 Oct working copy) from GitHub STP-KAS/kns-tn10-testing@ee3e013, re-adding:
 *   --run-dir <abs|rel> / --run-id / --wallet-meta <meta.json> / --snapshot <utxo view>: separate run folders and wallet sets
 *   live fee: mass * ceil(--feerate-margin (1.2) * live storm feerate from --feerate-file (/tmp/r6-feerate, <120 s old));
 *     if the file is missing/stale: n0 getFeeEstimate, feerate = max(priority, 2 x normal) (storm pays flat 2x) * margin; last resort 4x fee
 *   control.json in the run dir (re-read every 2 s): rate_per_min, max_inflight, wallet_cooldown_ms, max_unconfirmed, busy_wait_ms
 *   --max-unconfirmed (watched txs not yet out of n0 mempool), HARD_CAP 6000/min
 *   --sweep-smalls K (default 0): payer mode recycles up to K smallest UTXOs (reveal change) per commit; wallets with >16 UTXOs stay usable
 *   --busy-wait-ms (default 5000 = previous behaviour): retry wait after "all wallets busy"
 *   --dry-feerate N: offline dry-run uses this live feerate (no network)
 */
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import { pathToFileURL } from "node:url"; import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const BASE_DIR = "/workspace/artifacts/kns-tn10/storm-2026-10-01";
// --mock 1: exercises the LIVE loop against a fake in-process node (no network at all), outputs to <run-dir>/mock-run/, no smoke-result files.
const MOCK = arg("--mock", "0") === "1";
const RUN_DIR = arg("--run-dir", null);
const DIR0 = RUN_DIR ? (path.isAbsolute(RUN_DIR) ? RUN_DIR : path.join(BASE_DIR, RUN_DIR)) : BASE_DIR;
const DIR = MOCK ? path.join(DIR0, "mock-run") : DIR0; fs.mkdirSync(DIR, { recursive: true });
const RUN_ID = arg("--run-id", RUN_DIR ? path.basename(DIR0) : "storm-2026-10-01");
const WALLET_META = arg("--wallet-meta", "/workspace/artifacts/kns-tn10/snapshot-wallets/meta.json");
const SNAP_FILE = arg("--snapshot", fs.existsSync(path.join(DIR0, "utxo-snapshot.json")) ? path.join(DIR0, "utxo-snapshot.json") : path.join(BASE_DIR, "utxo-snapshot.json"));
const CONTROL_FILE = path.join(DIR0, "control.json");
const API_DIR = "/workspace/artifacts/kns-tn10/api";
const NET = "testnet-10";
const N0 = arg("--node", "ws://127.0.0.1:17210");
const HARD_CAP = 6000; // names/min absolute ceiling (control.json cannot exceed it)
let RATE = Math.min(HARD_CAP, Math.max(1, Number(arg("--rate", "30"))));
const LEN_MIN = Math.max(5, Number(arg("--len-min", "5"))), LEN_MAX = Math.max(LEN_MIN, Number(arg("--len-max", "10")));
let MAX_INFLIGHT = Number(arg("--max-inflight", "12"));
let MAX_UNCONFIRMED = Number(arg("--max-unconfirmed", "2000"));
let BUSY_WAIT_MS = Math.max(20, Number(arg("--busy-wait-ms", "5000"))); // retry wait after "all wallets busy" (5000 = previous behaviour)
const MAX_HOURS = Number(arg("--max-hours", "24"));
const MAX_SPEND = Number(arg("--max-spend-tkas", "0")); // 0 = no cap (funds are the cap)
const FEE_MULT = Math.max(1, Math.round(Number(arg("--fee-mult", process.env.KNS_FEE_MULT || "1"))));
const DRY = Number(arg("--dry-run", "0"));
const BROADCAST = arg("--broadcast", "0") === "1";
const CONFIRM_SAMPLE_MIN = Number(arg("--confirm-sample-min", "10")); // public REST sample period, 0 = off
let WALLET_COOLDOWN_MS = Number(arg("--wallet-cooldown-ms", "60000"));
const STOP_FILE = path.join(DIR, "STOP");
const EVENTS = path.join(DIR, DRY ? "dryrun-events.jsonl" : "events.jsonl");
const NAMES = path.join(DIR, DRY ? "dryrun-names.jsonl" : "names.jsonl");
const PUBLIC_CALLS = path.join(DIR, "public-api-calls.jsonl");
const STATUS = path.join(DIR, DRY ? "dryrun-status.json" : "status.json");
const FEE_SINK = "kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru";
const FORBIDDEN = new Set(["kaspatest:qzffl5xy9np46gkttyuftqnv2w04pr8g3wsp7c3vv8se3txtelx6q7c0v0ldx"]); // treasury / storm feeder: never an input
const PRICE_SOMPI = 35n * 100000000n; // 5+ grapheme labels
const LOCK = BigInt(Math.round(Number(arg("--lock-tkas", "36")) * 1e8)); // P2SH lock; reveal change (~0.97) returns to primary payer
const PRIORITY_COMMIT = kaspa.kaspaToSompi("0.01"), PRIORITY_REVEAL = kaspa.kaspaToSompi("0.02");
const MIN_CHANGE = 100000000n; // keep commit change >= 1 TKAS (storage mass)
const MAX_INPUTS = 16;
const SWEEP_SMALLS = Math.max(0, Math.min(MAX_INPUTS - 1, Number(arg("--sweep-smalls", "0"))));
// --owner-mode payer (DEFAULT, proven 26 Sep): one random snapshot wallet that can afford the name pays the commit AND owns/signs the reveal.
// --owner-mode split (opt-in): random owner 0..25699, commit funded by other snapshot wallets (attribution unproven).
const OWNER_MODE = arg("--owner-mode", "payer");
if (!["payer", "split"].includes(OWNER_MODE)) { console.error("--owner-mode must be payer|split"); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const tk = (s) => Number(BigInt(s)) / 1e8;
const ev = (o) => { const row = { at: now(), ...o }; fs.appendFileSync(EVENTS, JSON.stringify(row) + "\n"); return row; };
const pub = (o) => fs.appendFileSync(PUBLIC_CALLS, JSON.stringify({ at: now(), runner: true, ...o }) + "\n");
const out = (o) => console.log(JSON.stringify({ at: now(), ...o }));

if (MOCK && BROADCAST) { console.error("--mock and --broadcast are exclusive"); process.exit(3); }
if (BROADCAST && process.env.KNS_STORM_GO !== "1") { console.error("refusing: --broadcast 1 requires env KNS_STORM_GO=1 (explicit GO)"); process.exit(3); }
if (!BROADCAST && !DRY && !MOCK) { console.error("nothing to do: use --dry-run N (offline) or --broadcast 1 with KNS_STORM_GO=1"); process.exit(3); }
if (Number(arg("--rate", "30")) > HARD_CAP) out({ phase: "rate_clamped", requested: Number(arg("--rate")), rate: RATE });

// ---- keys (memory only)
const meta = JSON.parse(fs.readFileSync(WALLET_META, "utf8"));
const keyByIndex = new Map(), indexByAddr = new Map();
for (const l of fs.readFileSync(meta.privkeys_file, "utf8").split("\n")) { if (!l) continue; const j = JSON.parse(l); keyByIndex.set(j.index, { address: j.address, hex: j.private_key_hex }); indexByAddr.set(j.address, j.index); }
const OWNER_MAX = keyByIndex.size - 1;
const privCache = new Map();
const priv = (i) => { let p = privCache.get(i); if (!p) { p = new kaspa.PrivateKey(keyByIndex.get(i).hex); privCache.set(i, p); if (privCache.size > 5000) privCache.delete(privCache.keys().next().value); } return p; };

// ---- used labels (collision guard): all local smoke-result files + this run's journal
const used = new Set();
for (const f of fs.readdirSync(API_DIR)) if (f.startsWith("smoke-result-") && f.endsWith(".json")) used.add(f.slice(13, -5));
const usedFromSmoke = used.size;

// ---- wallet UTXO tracking: snapshot + replay of own journal
const snap = JSON.parse(fs.readFileSync(SNAP_FILE, "utf8"));
if (MOCK) { const lim = Number(arg("--mock-wallets", "40")); const keep = Object.keys(snap.byAddress).filter((a) => snap.byAddress[a].reduce((x, u) => x + Number(u.amount), 0) > 50e8).slice(0, lim); snap.byAddress = Object.fromEntries(keep.map((a) => [a, snap.byAddress[a]])); }
const wallets = new Map(); // addr -> { index, utxos: Map(key -> utxo), busyUntil, quarantined }
const ukey = (txid, idx) => `${txid}:${idx}`;
for (const [addr, list] of Object.entries(snap.byAddress)) {
  if (FORBIDDEN.has(addr) || !indexByAddr.has(addr)) continue;
  const m = new Map(); for (const u of list) m.set(ukey(u.transactionId, u.index), u);
  wallets.set(addr, { index: indexByAddr.get(addr), utxos: m, busyUntil: 0, quarantined: false });
}
const wal = (addr) => { let w = wallets.get(addr); if (!w) { w = { index: indexByAddr.get(addr), utxos: new Map(), busyUntil: 0, quarantined: false }; wallets.set(addr, w); } return w; };
const pendingReveals = new Map(); // label -> commit info (commit accepted, reveal not yet)
const stats = { names_ok: 0, commit_fail: 0, reveal_fail: 0, uncertain: 0, spend_sompi: 0n, fee_sompi: 0n };
if (!DRY && fs.existsSync(EVENTS)) {
  for (const l of fs.readFileSync(EVENTS, "utf8").split("\n")) {
    if (!l) continue; let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.label) used.add(e.label);
    if (e.phase === "commit_accepted") { for (const s of e.spent) wal(s.addr).utxos.delete(ukey(s.txid, s.index)); for (const c of e.created) wal(c.addr).utxos.set(ukey(c.utxo.transactionId, c.utxo.index), c.utxo); pendingReveals.set(e.label, e); }
    if (e.phase === "reveal_accepted") { pendingReveals.delete(e.label); for (const c of e.created) wal(c.addr).utxos.set(ukey(c.utxo.transactionId, c.utxo.index), c.utxo); stats.names_ok++; stats.spend_sompi += BigInt(e.name_spend_sompi || 0); }
    if (e.phase === "tx_uncertain" || e.phase === "wallet_quarantined") for (const a of e.wallets || []) wal(a).quarantined = true;
  }
}
const spendable = (w) => { let s = 0n; for (const u of w.utxos.values()) s += BigInt(u.amount); return s; };
const fundsSompi = () => { let s = 0n; for (const w of wallets.values()) if (!w.quarantined) s += spendable(w); return s; };

// ---- labels
const ALPHA = "abcdefghijklmnopqrstuvwxyz", ALNUM = ALPHA + "0123456789";
function newLabel() {
  for (;;) {
    const n = LEN_MIN + crypto.randomInt(LEN_MAX - LEN_MIN + 1);
    let s = ALPHA[crypto.randomInt(26)]; for (let i = 1; i < n; i++) s += ALNUM[crypto.randomInt(36)];
    if (!used.has(s)) { used.add(s); return s; }
  }
}

// ---- funding selection (snapshot wallets only)
const addrList = () => [...wallets.entries()].filter(([a, w]) => !w.quarantined && w.busyUntil <= Date.now() && w.utxos.size && !FORBIDDEN.has(a));
// true if some wallet (ignoring busy/cooldown) could still fund a name => shortage is temporary, not exhaustion
function anyCanAfford() {
  const need = LOCK + FEE_HEAD + MIN_CHANGE;
  if (OWNER_MODE === "payer") { for (const [, w] of wallets) if (!w.quarantined && w.utxos.size && (SWEEP_SMALLS || w.utxos.size <= MAX_INPUTS) && spendable(w) >= need && selectInputs(fundEntries([[null, w]]))) return true; return false; }
  return fundsSompi() >= need * 2n;
}
function pickFunding() {
  const avail = addrList(); if (!avail.length) return null;
  if (OWNER_MODE === "payer") {
    const need = LOCK + FEE_HEAD + MIN_CHANGE;
    const rich = avail.filter(([, w]) => (SWEEP_SMALLS || w.utxos.size <= MAX_INPUTS) && spendable(w) >= need);
    for (let tries = 0; tries < 20 && rich.length; tries++) {
      const k = crypto.randomInt(rich.length); const c = rich[k];
      if (selectInputs(fundEntries([c]))) return { primary: c[0], chosen: [c], sum: spendable(c[1]) };
      rich.splice(k, 1);
    }
    return null;
  }
  const need = LOCK + 5000000n + MIN_CHANGE; // lock + fee headroom (0.05) + min change
  for (let tries = 0; tries < 6; tries++) {
    const chosen = []; let sum = 0n; const seen = new Set();
    const primary = avail[crypto.randomInt(avail.length)]; chosen.push(primary); seen.add(primary[0]); sum += spendable(primary[1]);
    let guard = 0;
    while (sum < need && guard++ < 40) {
      // sample a few random wallets, take the richest (random owners/payers, but avoids piling up dust inputs)
      let c = null; for (let k = 0; k < 8; k++) { const x = avail[crypto.randomInt(avail.length)]; if (!seen.has(x[0]) && (!c || spendable(x[1]) > spendable(c[1]))) c = x; }
      if (!c) continue;
      const nIn = chosen.reduce((a, [, w]) => a + w.utxos.size, 0) + c[1].utxos.size; if (nIn > MAX_INPUTS) continue;
      chosen.push(c); seen.add(c[0]); sum += spendable(c[1]);
    }
    // add wallets until an input order exists that yields change >= MIN_CHANGE
    let sel = sum >= need ? selectInputs(fundEntries(chosen)) : null; guard = 0;
    while (!sel && guard++ < 20) {
      const c = avail[crypto.randomInt(avail.length)]; if (seen.has(c[0])) continue;
      if (chosen.reduce((a, [, w]) => a + w.utxos.size, 0) + c[1].utxos.size > MAX_INPUTS) break;
      chosen.push(c); seen.add(c[0]); sum += spendable(c[1]); if (sum >= need) sel = selectInputs(fundEntries(chosen));
    }
    if (sel) return { primary: primary[0], chosen, sum };
  }
  return null;
}
// Choose an ordered input prefix the SDK generator will consume completely: prefix without its last input < LOCK,
// full prefix >= LOCK + fee headroom + MIN_CHANGE => change >= ~1 TKAS (keeps KIP-9 storage mass low).
const FEE_HEAD = 15000000n; // 0.15 TKAS commit-fee headroom (storm feerates)
function selectInputs(entries) {
  const orders = [];
  if (SWEEP_SMALLS && entries.length > 1) { // preferred: k smallest first (sum < LOCK), then the largest UTXO
    const asc = [...entries].sort((a, b) => (a.amount < b.amount ? -1 : 1)); const big = asc[asc.length - 1];
    for (let k = Math.min(SWEEP_SMALLS, asc.length - 1); k >= 0; k--) orders.push([...asc.slice(0, k), big]);
  }
  orders.push([...entries].sort((a, b) => (a.amount < b.amount ? 1 : -1)), [...entries].sort((a, b) => (a.amount < b.amount ? -1 : 1)));
  for (let k = 0; k < 10; k++) { const e = [...entries]; for (let i = e.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [e[i], e[j]] = [e[j], e[i]]; } orders.push(e); }
  for (const ord of orders) { let s = 0n; const pre = []; for (const e of ord) { if (s >= LOCK) break; pre.push(e); s += e.amount; } if (pre.length <= MAX_INPUTS && s - pre[pre.length - 1].amount < LOCK && s >= LOCK + FEE_HEAD + MIN_CHANGE) return pre; }
  return null;
}
const fundEntries = (chosen) => chosen.flatMap(([addr, w]) => [...w.utxos.values()].map((u) => entryOf(addr, u)));
const entryOf = (addr, u) => ({ address: addr, outpoint: { transactionId: u.transactionId, index: u.index }, amount: BigInt(u.amount), scriptPublicKey: u.scriptPublicKey, blockDaaScore: BigInt(u.blockDaaScore || 0), isCoinbase: !!u.isCoinbase });
// ---- fee policy: fee = max(1x fee, mass * ceil(margin * live feerate)); live = /tmp/r6-feerate (<120 s) else n0 getFeeEstimate (cached) else 4x fee
const FEERATE_FILE = arg("--feerate-file", "/tmp/r6-feerate"), FEERATE_MARGIN = Number(arg("--feerate-margin", "1.2")), FALLBACK_MULT = Math.max(4, FEE_MULT);
const DRY_FEERATE = Number(arg("--dry-feerate", "0"));
let n0Est = null; // { feerate, at, priority, normal }
let feeState = { mode: "init", live: null, used: null, at: 0 };
function refreshFeerate() {
  if (Date.now() - feeState.at < 5000) return feeState;
  if (DRY && DRY_FEERATE > 0) return (feeState = { mode: "dry_fixed", live: DRY_FEERATE, used: Math.ceil(DRY_FEERATE * FEERATE_MARGIN), at: Date.now() });
  try { const st = fs.statSync(FEERATE_FILE); const v = Number(fs.readFileSync(FEERATE_FILE, "utf8").trim());
    if (Date.now() - st.mtimeMs < 120000 && v > 0 && v < 1e6) return (feeState = { mode: "live_file", live: v, used: Math.ceil(v * FEERATE_MARGIN), at: Date.now() }); } catch {}
  if (n0Est && Date.now() - n0Est.at < 60000 && n0Est.feerate > 0) return (feeState = { mode: "n0_estimate", live: n0Est.feerate, used: Math.ceil(n0Est.feerate * FEERATE_MARGIN), at: Date.now(), priority: n0Est.priority, normal: n0Est.normal });
  return (feeState = { mode: "fallback_mult", live: null, used: null, mult: FALLBACK_MULT, at: 0 }); // not cached; LIVE loop holds instead of using it
}
async function createTx(opts) {
  const first = await kaspa.createTransactions(opts);
  const fs0 = refreshFeerate(); const base = BigInt(opts.priorityFee ?? 0n); const oneX = BigInt(first.summary.fees);
  let target;
  if (fs0.used) { const mass = BigInt(first.transactions[0].mass); target = mass * BigInt(fs0.used); if (target < oneX) target = oneX; }
  else target = oneX * BigInt(fs0.mult);
  const net = oneX - base; const prio = target - net; if (prio <= base) return first;
  let r = await kaspa.createTransactions({ ...opts, priorityFee: prio });
  if (fs0.used) { // smaller change => larger storage mass: re-price once on the final mass (+2% pad)
    const m2 = BigInt(r.transactions[0].mass); const t2 = (m2 * BigInt(fs0.used) * 102n) / 100n;
    if (BigInt(r.summary.fees) < t2) r = await kaspa.createTransactions({ ...opts, priorityFee: t2 - net });
  }
  return r;
}
const spkHex = (spk) => (typeof spk === "string" ? spk : spk.script ?? spk.toString());
const outUtxo = (txid, i, o) => ({ transactionId: txid, index: i, amount: String(o.value), scriptPublicKey: { version: o.scriptPublicKey.version, script: o.scriptPublicKey.script }, blockDaaScore: "0", isCoinbase: false });

// ---- build commit + reveal (pure, offline)
async function build(label, ownerIndex, fund) {
  const ownerKey = priv(ownerIndex); const kp = ownerKey.toKeypair(); const ownerAddr = kp.toAddress(NET).toString();
  if (ownerAddr !== keyByIndex.get(ownerIndex).address) throw new Error("owner_key_mismatch");
  if (OWNER_MODE === "payer" && (ownerAddr !== fund.primary || fund.chosen.length !== 1)) throw new Error("payer_mode_owner_must_be_payer");
  const payload = JSON.stringify({ op: "create", p: "domain", v: label });
  const script = new kaspa.ScriptBuilder().addData(kp.xOnlyPublicKey).addOp(kaspa.Opcodes.OpCheckSig).addOp(kaspa.Opcodes.OpFalse).addOp(kaspa.Opcodes.OpIf)
    .addData(Buffer.from("kns")).addI64(0n).addData(Buffer.from(payload)).addOp(kaspa.Opcodes.OpEndIf);
  const p2shSpk = script.createPayToScriptHashScript(); const p2shAddr = kaspa.addressFromScriptPublicKey(p2shSpk, NET).toString();
  const keys = [];
  for (const [addr, w] of fund.chosen) { if (FORBIDDEN.has(addr)) throw new Error("forbidden_input"); keys.push(priv(w.index)); }
  const entries = selectInputs(fundEntries(fund.chosen)); if (!entries) throw new Error("no_input_order");
  const { transactions: cts } = await createTx({ priorityEntries: entries, entries: [], outputs: [{ address: p2shAddr, amount: LOCK }], changeAddress: fund.primary, priorityFee: PRIORITY_COMMIT, networkId: NET });
  if (cts.length !== 1) throw new Error(`commit_multi_tx_${cts.length}`);
  const commit = cts[0]; commit.sign(keys);
  const ctx = commit.transaction; const commitId = commit.id;
  const p2shIdx = ctx.outputs.findIndex((o) => spkHex(o.scriptPublicKey) === spkHex(p2shSpk));
  if (p2shIdx < 0) throw new Error("p2sh_output_missing");
  const commitCreated = []; ctx.outputs.forEach((o, i) => { if (i !== p2shIdx) commitCreated.push({ addr: fund.primary, utxo: outUtxo(commitId, i, o) }); });
  const p2shEntry = { address: p2shAddr, outpoint: { transactionId: commitId, index: p2shIdx }, amount: LOCK, scriptPublicKey: p2shSpk, blockDaaScore: 0n, isCoinbase: false };
  const reveal = await buildReveal(p2shEntry, script, ownerKey, fund.primary);
  return { label, ownerIndex, ownerAddr, p2shAddr, script, payload, commit, commitId, p2shIdx, p2shEntry, commitCreated,
    spent: ctx.inputs.map((x) => { const e = entries.find((q) => q.outpoint.transactionId === x.previousOutpoint.transactionId && q.outpoint.index === x.previousOutpoint.index); return { addr: e.address, txid: e.outpoint.transactionId, index: e.outpoint.index }; }), reveal,
    commitFee: BigInt(commit.feeAmount), commitMass: String(commit.mass), wallets: fund.chosen.map(([a]) => a), primary: fund.primary };
}
async function buildReveal(p2shEntry, script, ownerKey, changeAddr) {
  const { transactions: rts } = await createTx({ priorityEntries: [p2shEntry], entries: [], outputs: [{ address: FEE_SINK, amount: PRICE_SOMPI }], changeAddress: changeAddr, priorityFee: PRIORITY_REVEAL, networkId: NET });
  if (rts.length !== 1) throw new Error(`reveal_multi_tx_${rts.length}`);
  const r = rts[0]; r.sign([ownerKey], false);
  const idx = r.transaction.inputs.findIndex((i) => !i.signatureScript || i.signatureScript === "");
  if (idx < 0) throw new Error("reveal_no_empty_sig_input");
  const sig = await r.createInputSignature(idx, ownerKey); r.fillInput(idx, script.encodePayToScriptHashSignatureScript(sig));
  if (r.transaction.outputs[0] && spkHex(r.transaction.outputs[0].scriptPublicKey) !== spkHex(kaspa.payToAddressScript(FEE_SINK))) throw new Error("reveal_output0_not_fee_sink");
  const created = []; r.transaction.outputs.forEach((o, i) => { if (i > 0) created.push({ addr: changeAddr, utxo: outUtxo(r.id, i, o) }); });
  return { tx: r, revealId: r.id, fee: BigInt(r.feeAmount), mass: String(r.mass), created };
}
function applyCommit(b) { for (const s of b.spent) wallets.get(s.addr)?.utxos.delete(ukey(s.txid, s.index)); for (const c of b.commitCreated) wal(c.addr).utxos.set(ukey(c.utxo.transactionId, c.utxo.index), c.utxo); }
function applyReveal(created) { for (const c of created) wal(c.addr).utxos.set(ukey(c.utxo.transactionId, c.utxo.index), c.utxo); }

// ---- DRY RUN (offline: no RPC connection at all)
if (DRY) {
  const t0 = Date.now(); const rows = []; var dryFails = 0;
  for (let i = 0; i < DRY; i++) {
    const label = newLabel(); const fund = pickFunding(); if (!fund) { out({ phase: "dry_no_funds" }); break; }
    const owner = OWNER_MODE === "payer" ? wallets.get(fund.primary).index : crypto.randomInt(OWNER_MAX + 1);
    let b; try { b = await build(label, owner, fund); } catch (e) { out({ phase: "dry_build_failed", label, error: String(e?.message || e).slice(0, 160), stack: String(e?.stack || "").split("\n").slice(1, 3).join(" "), fund_sum_tkas: tk(fund.sum), inputs: fund.chosen.reduce((a, [, w]) => a + w.utxos.size, 0), amounts: fund.chosen.flatMap(([, w]) => [...w.utxos.values()].map((u) => tk(u.amount))) }); dryFails = (dryFails || 0) + 1; if (dryFails > 50) break; continue; }
    applyCommit(b); applyReveal(b.reveal.created);
    const signedAll = b.commit.transaction.inputs.every((x) => x.signatureScript && x.signatureScript.length > 0) && b.reveal.tx.transaction.inputs.every((x) => x.signatureScript && x.signatureScript.length > 0);
    const r = { label, len: label.length, owner_index: owner, owner: b.ownerAddr, payer_wallets: b.wallets.map((a) => indexByAddr.get(a)), commit_inputs: b.spent.length,
      commitId: b.commitId, revealId: b.reveal.revealId, commit_fee_tkas: tk(b.commitFee), reveal_fee_tkas: tk(b.reveal.fee), commit_mass: b.commitMass, reveal_mass: b.reveal.mass,
      price_tkas: 35, name_spend_tkas: tk(b.commitFee + b.reveal.fee + PRICE_SOMPI), all_inputs_signed: signedAll, submitted: false };
    rows.push(r); fs.appendFileSync(NAMES, JSON.stringify({ at: now(), ...r }) + "\n");
  }
  const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / (rows.length || 1);
  const sum = { at: now(), phase: "dry_run_done", owner_mode: OWNER_MODE, owner_eq_payer: rows.filter((r) => r.payer_wallets.length === 1 && r.payer_wallets[0] === r.owner_index).length, built: rows.length, build_failures: dryFails, funds_left_tkas: +tk(fundsSompi()).toFixed(2), all_signed: rows.every((r) => r.all_inputs_signed), avg_commit_fee_tkas: +avg("commit_fee_tkas").toFixed(6), avg_reveal_fee_tkas: +avg("reveal_fee_tkas").toFixed(6),
    avg_name_spend_tkas: +avg("name_spend_tkas").toFixed(6), avg_commit_inputs: +avg("commit_inputs").toFixed(2), lengths: rows.reduce((m, r) => ((m[r.len] = (m[r.len] || 0) + 1), m), {}),
    unique_labels: new Set(rows.map((r) => r.label)).size, collisions_vs_local: rows.filter((r) => false).length, used_labels_loaded: usedFromSmoke, funds_tkas_snapshot: tk(fundsSompi() + BigInt(Math.round(avg("name_spend_tkas") * 1e8)) * BigInt(rows.length)),
    wallets_tracked: wallets.size, ms: Date.now() - t0, broadcast: false };
  fs.writeFileSync(STATUS, JSON.stringify(sum, null, 2) + "\n"); console.log(JSON.stringify(sum, null, 1)); process.exit(0);
}

// ---- LIVE (only with GO)
let rpc = null;
const mockNode = { isConnected: true, getServerInfo: async () => ({ isSynced: true, hasUtxoIndex: false }), getMempoolEntry: async () => { throw new Error("Transaction not found"); }, disconnect: async () => {} };
async function getRpc() {
  if (MOCK) return (rpc = mockNode);
  if (rpc && rpc.isConnected) return rpc;
  const c = new kaspa.RpcClient({ url: N0, encoding: kaspa.Encoding.Borsh, networkId: NET }); await c.connect({ timeoutDuration: 10000 }); rpc = c; return c;
}
// true = in n0 mempool, false = n0 says "not found", null = unknown (RPC trouble)
async function inMempool(txid) { try { const c = await getRpc(); const r = await c.getMempoolEntry({ transactionId: txid, includeOrphanPool: true, filterTransactionPool: false }); return !!r?.mempoolEntry; } catch (e) { if (rpc && !rpc.isConnected) rpc = null; return /not found/i.test(String(e?.message || e)) ? false : null; } }
async function submit(tx) {
  const txid = tx.id; const t = Date.now();
  try { const c = await getRpc(); if (MOCK) { await sleep(20); return { ok: true, txid, ms: Date.now() - t, note: "mock" }; } await tx.submit(c); return { ok: true, txid, ms: Date.now() - t }; }
  catch (e) {
    const m = String(e?.message || e); if (rpc && !rpc.isConnected) rpc = null;
    if (/Rejected transaction|rejected/i.test(m)) return { ok: false, rejected: true, txid, error: m.slice(0, 240), ms: Date.now() - t };
    await sleep(2000); if ((await inMempool(txid)) === true) return { ok: true, txid, ms: Date.now() - t, note: "accepted_after_uncertain_submit" };
    return { ok: false, uncertain: true, txid, error: m.slice(0, 240), ms: Date.now() - t };
  }
}
const watch = new Map(); // txid -> { label, kind, submitted }
const recent = []; let inflight = 0, stopping = false; const startedAt = Date.now();
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { if (!stopping) out({ phase: "stop_requested", signal: s }); stopping = true; });

async function doReveal(label, info, attempt = 1) {
  const ownerKey = priv(info.owner_index);
  const kp = ownerKey.toKeypair(); const payload = JSON.stringify({ op: "create", p: "domain", v: label });
  const script = new kaspa.ScriptBuilder().addData(kp.xOnlyPublicKey).addOp(kaspa.Opcodes.OpCheckSig).addOp(kaspa.Opcodes.OpFalse).addOp(kaspa.Opcodes.OpIf).addData(Buffer.from("kns")).addI64(0n).addData(Buffer.from(payload)).addOp(kaspa.Opcodes.OpEndIf);
  const p2shSpk = script.createPayToScriptHashScript();
  const entry = { address: info.p2sh_addr, outpoint: { transactionId: info.commitId, index: info.p2sh_index }, amount: BigInt(info.lock_sompi), scriptPublicKey: p2shSpk, blockDaaScore: 0n, isCoinbase: false };
  return buildReveal(entry, script, ownerKey, info.primary);
}
async function oneName() {
  const t0 = Date.now(); const label = newLabel();
  const fund = pickFunding(); if (!fund) { used.delete(label); if (anyCanAfford()) { ev({ phase: "funds_wait_busy_wallets" }); return "busy"; } ev({ phase: "funds_exhausted" }); return "nofunds"; }
  const owner = OWNER_MODE === "payer" ? wallets.get(fund.primary).index : crypto.randomInt(OWNER_MAX + 1);
  for (const [, w] of fund.chosen) w.busyUntil = Date.now() + 10 * 60000; // locked until resolved
  let b; try { b = await build(label, owner, fund); } catch (e) { for (const [, w] of fund.chosen) w.busyUntil = 0; stats.commit_fail++; ev({ phase: "build_failed", label, error: String(e?.message || e).slice(0, 200) }); return "fail"; }
  const tc = Date.now(); const cr = await submit(b.commit);
  if (!cr.ok) {
    if (cr.uncertain) { stats.uncertain++; for (const [, w] of fund.chosen) w.quarantined = true; ev({ phase: "tx_uncertain", kind: "commit", label, txid: cr.txid, wallets: b.wallets, error: cr.error }); return "fail"; }
    stats.commit_fail++;
    if (/already spent|missing|orphan|not found/i.test(cr.error)) { for (const [, w] of fund.chosen) w.quarantined = true; ev({ phase: "wallet_quarantined", label, wallets: b.wallets, reason: "stale_utxo" }); }
    else for (const [, w] of fund.chosen) w.busyUntil = Date.now() + 5000;
    ev({ phase: "commit_rejected", label, owner_index: owner, commitId: cr.txid, error: cr.error, ms: cr.ms }); return "fail";
  }
  applyCommit(b);
  const info = { label, owner_index: owner, owner: b.ownerAddr, primary: b.primary, payer_wallets: b.wallets.map((a) => indexByAddr.get(a)), commitId: b.commitId, p2sh_addr: b.p2shAddr, p2sh_index: b.p2shIdx, lock_sompi: String(LOCK),
    commit_fee_sompi: String(b.commitFee), commit_mass: b.commitMass, spent: b.spent, created: b.commitCreated, commit_submit_at: new Date(tc).toISOString(), commit_submit_ms: cr.ms };
  ev({ phase: "commit_accepted", ...info, fee_mode: feeState.mode, feerate_live: feeState.live, feerate_used: feeState.used, note: cr.note }); pendingReveals.set(label, info); watch.set(b.commitId, { label, kind: "commit", at: Date.now() });
  let rv = b.reveal, ok = false, lastErr = null;
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
    if (attempt > 1) { await sleep([0, 2000, 10000, 30000][attempt - 1]); try { rv = await doReveal(label, info); } catch (e) { lastErr = String(e?.message || e); continue; } }
    const tr = Date.now(); const rr = await submit(rv.tx);
    if (rr.ok) {
      ok = true; applyReveal(rv.created); pendingReveals.delete(label);
      const spend = b.commitFee + rv.fee + PRICE_SOMPI; stats.names_ok++; stats.spend_sompi += spend; stats.fee_sompi += b.commitFee + rv.fee;
      ev({ phase: "reveal_accepted", label, revealId: rv.revealId, attempt, reveal_fee_sompi: String(rv.fee), reveal_mass: rv.mass, fee_mode: feeState.mode, feerate_used: feeState.used, created: rv.created, name_spend_sompi: String(spend), reveal_submit_at: new Date(tr).toISOString(), reveal_submit_ms: rr.ms, note: rr.note });
      const row = { at: now(), run_id: RUN_ID, label, domain: `${label}.kas`, len: label.length, owner_index: owner, owner: b.ownerAddr, payer_wallets: info.payer_wallets, commitId: b.commitId, revealId: rv.revealId,
        commit_submit_at: info.commit_submit_at, reveal_submit_at: new Date(tr).toISOString(), accepted_latency_ms: Date.now() - t0, commit_fee_tkas: tk(b.commitFee), reveal_fee_tkas: tk(rv.fee), price_tkas: 35, name_spend_tkas: tk(spend), attempts: attempt };
      fs.appendFileSync(NAMES, JSON.stringify(row) + "\n");
      if (!MOCK) fs.writeFileSync(path.join(API_DIR, `smoke-result-${label}.json`), JSON.stringify({ domain: `${label}.kas`, payer: b.primary, owner: b.ownerAddr, commitId: b.commitId, revealId: rv.revealId, inscriptionId: `${rv.revealId}i0`, feeKas: 35, p2shAddress: b.p2shAddr, at: now(), via: "kns-storm-runner", run_id: RUN_ID }, null, 2) + "\n");
      watch.set(rv.revealId, { label, kind: "reveal", at: Date.now(), t0 });
    } else if (rr.uncertain) { stats.uncertain++; lastErr = rr.error; ev({ phase: "tx_uncertain", kind: "reveal", label, txid: rr.txid, wallets: [b.primary], error: rr.error }); wal(b.primary).quarantined = true; break; }
    else { lastErr = rr.error; ev({ phase: "reveal_rejected", label, revealId: rr.txid, attempt, error: rr.error, ms: rr.ms }); if (/already spent/i.test(rr.error)) break; }
  }
  for (const [, w] of fund.chosen) if (!w.quarantined) w.busyUntil = Date.now() + WALLET_COOLDOWN_MS;
  if (!ok) { stats.reveal_fail++; ev({ phase: "reveal_failed_stranded", label, commitId: b.commitId, p2sh_addr: b.p2shAddr, p2sh_index: b.p2shIdx, owner_index: owner, error: lastErr }); fs.appendFileSync(path.join(DIR, "stranded.jsonl"), JSON.stringify({ at: now(), ...info, error: lastErr }) + "\n"); return "fail"; }
  return "ok";
}
// confirmation watcher (n0 mempool only): left mempool => presumed included
setInterval(async () => {
  for (const [txid, w] of watch) {
    const m = await inMempool(txid); if (m === null) continue;
    if (m) { if (Date.now() - w.at > 30 * 60000) { ev({ phase: "still_in_mempool_30min", label: w.label, kind: w.kind, txid }); watch.delete(txid); } continue; }
    ev({ phase: `${w.kind}_left_mempool`, label: w.label, txid, since_submit_ms: Date.now() - w.at, name_latency_ms: w.t0 ? Date.now() - w.t0 : undefined }); watch.delete(txid);
  }
}, 3000).unref();
// sparse public confirmation sample (Kaspa REST, not KNS API)
let lastSample = 0;
async function sampleConfirm() {
  if (MOCK || !CONFIRM_SAMPLE_MIN || Date.now() - lastSample < CONFIRM_SAMPLE_MIN * 60000) return; lastSample = Date.now();
  const rows = fs.existsSync(NAMES) ? fs.readFileSync(NAMES, "utf8").trim().split("\n").slice(-200, -20) : []; if (!rows.length) return;
  const r = JSON.parse(rows[crypto.randomInt(rows.length)]); const url = `https://api-tn10.kaspa.org/transactions/${r.revealId}?inputs=false&outputs=false&resolve_previous_outpoints=no`; const t = Date.now();
  try { const res = await fetch(url, { signal: AbortSignal.timeout(10000) }); const j = await res.json().catch(() => null); pub({ api: "kaspa-rest.transaction", url, status: res.status, ms: Date.now() - t, is_accepted: j?.is_accepted ?? null });
    ev({ phase: "confirm_sample", label: r.label, revealId: r.revealId, http: res.status, is_accepted: j?.is_accepted ?? null, accepting_block: j?.accepting_block_hash ?? null }); }
  catch (e) { pub({ api: "kaspa-rest.transaction", url, ok: false, error: String(e?.message || e).slice(0, 120) }); }
}
function saveStatus(extra = {}) {
  const el = (Date.now() - startedAt) / 60000; const f = fundsSompi();
  const avg = stats.names_ok ? Number(stats.spend_sompi) / stats.names_ok / 1e8 : 35.035;
  fs.writeFileSync(STATUS, JSON.stringify({ at: now(), pid: process.pid, rate_cap_per_min: RATE, hard_cap: HARD_CAP, started_at: new Date(startedAt).toISOString(), elapsed_min: +el.toFixed(1), ...stats, spend_sompi: undefined, fee_sompi: undefined,
    spend_tkas: tk(stats.spend_sompi), fees_tkas: tk(stats.fee_sompi), inflight, pending_reveals: pendingReveals.size, watching: watch.size, funds_left_tkas: +tk(f).toFixed(2), est_names_left: Math.floor(tk(f) / (avg + 1.1)), est_hours_left_at_cap: +(tk(f) / (avg + 1.1) / RATE / 60).toFixed(2),
    wallets_quarantined: [...wallets.values()].filter((w) => w.quarantined).length, max_inflight: MAX_INFLIGHT, max_unconfirmed: MAX_UNCONFIRMED, wallet_cooldown_ms: WALLET_COOLDOWN_MS, busy_wait_ms: BUSY_WAIT_MS, fee: feeState, stopping, ...extra }, null, 2) + "\n");
}

// startup
const info0 = await (await getRpc()).getServerInfo();
// n0 fee estimate refresher (fallback when the feerate file is missing/stale)
async function refreshN0Est() { try { const c = await getRpc(); const r = await c.getFeeEstimate({}); const e = r.estimate || r; const pr = Number(e.priorityBucket?.feerate || 0), nb = Number(e.normalBuckets?.[0]?.feerate || 0);
  n0Est = { feerate: Math.max(pr, 2 * nb), priority: pr, normal: nb, at: Date.now() }; } catch {} }
await refreshN0Est(); setInterval(refreshN0Est, 10000).unref();
ev({ phase: "runner_start", pid: process.pid, run_id: RUN_ID, run_dir: DIR, wallet_meta: WALLET_META, snapshot_file: SNAP_FILE, sweep_smalls: SWEEP_SMALLS, busy_wait_ms: BUSY_WAIT_MS, wallet_cooldown_ms: WALLET_COOLDOWN_MS, max_inflight: MAX_INFLIGHT, max_unconfirmed: MAX_UNCONFIRMED, feerate_file: FEERATE_FILE, feerate_margin: FEERATE_MARGIN, fee: refreshFeerate(), owner_mode: OWNER_MODE, node: N0, synced: info0.isSynced, utxoindex: info0.hasUtxoIndex, rate: RATE, len: [LEN_MIN, LEN_MAX], fee_mult: FEE_MULT, lock_tkas: tk(LOCK), funds_tkas: tk(fundsSompi()), wallets: wallets.size, used_labels: used.size, pending_reveals_from_journal: pendingReveals.size, snapshot_at: snap.at });
if (!info0.isSynced) { ev({ phase: "abort", reason: "n0_not_synced" }); process.exit(4); }
// recover reveals left pending by a previous run
for (const [label, info] of [...pendingReveals]) {
  try { const rv = await doReveal(label, info); const rr = await submit(rv.tx);
    if (rr.ok) { applyReveal(rv.created); pendingReveals.delete(label); const spend = BigInt(info.commit_fee_sompi) + rv.fee + PRICE_SOMPI; stats.names_ok++; stats.spend_sompi += spend; ev({ phase: "reveal_accepted", label, revealId: rv.revealId, recovered: true, created: rv.created, name_spend_sompi: String(spend), reveal_fee_sompi: String(rv.fee) }); }
    else ev({ phase: "recover_reveal_failed", label, error: rr.error });
  } catch (e) { ev({ phase: "recover_reveal_failed", label, error: String(e?.message || e).slice(0, 200) }); }
}
const replayedOk = stats.names_ok; // names already done in earlier runs (journal replay)
const statusTimer = setInterval(() => saveStatus(), 15000);
let next = Date.now(), noFunds = 0, exitReason = "stopped", lastNoFee = 0;
// control.json (optional) re-read every 2 s
let controlMtime = 0;
function applyControl() { try { const st = fs.statSync(CONTROL_FILE); if (st.mtimeMs === controlMtime) return; controlMtime = st.mtimeMs; const c = JSON.parse(fs.readFileSync(CONTROL_FILE, "utf8"));
  if (c.rate_per_min > 0) RATE = Math.min(HARD_CAP, Math.round(c.rate_per_min)); if (c.max_inflight > 0) MAX_INFLIGHT = Math.round(c.max_inflight); if (c.wallet_cooldown_ms >= 0) WALLET_COOLDOWN_MS = Math.round(c.wallet_cooldown_ms);
  if (c.max_unconfirmed > 0) MAX_UNCONFIRMED = Math.round(c.max_unconfirmed); if (c.busy_wait_ms >= 20) BUSY_WAIT_MS = Math.round(c.busy_wait_ms);
  ev({ phase: "control_applied", rate_per_min: RATE, max_inflight: MAX_INFLIGHT, wallet_cooldown_ms: WALLET_COOLDOWN_MS, max_unconfirmed: MAX_UNCONFIRMED, busy_wait_ms: BUSY_WAIT_MS }); } catch (e) { if (fs.existsSync(CONTROL_FILE)) ev({ phase: "control_invalid", error: String(e?.message || e).slice(0, 120) }); } }
applyControl(); setInterval(applyControl, 2000).unref();

while (!stopping) {
  if (fs.existsSync(STOP_FILE)) { exitReason = "stop_file"; ev({ phase: "stop_file_seen" }); stopping = true; break; }
  if ((Date.now() - startedAt) / 3600000 >= MAX_HOURS) { exitReason = "max_hours"; ev({ phase: "max_hours_reached" }); break; }
  if (MAX_SPEND && tk(stats.spend_sompi) >= MAX_SPEND) { exitReason = "max_spend"; ev({ phase: "max_spend_reached" }); break; }
  while (recent.length && Date.now() - recent[0] > 60000) recent.shift();
  if (!MOCK && !refreshFeerate().used) { if (Date.now() - lastNoFee > 60000) { lastNoFee = Date.now(); ev({ phase: "no_feerate_hold", reason: "feerate file missing/stale and no n0 fee estimate" }); } await sleep(500); continue; }
  if (Date.now() < next || inflight >= MAX_INFLIGHT || recent.length >= RATE || watch.size >= MAX_UNCONFIRMED) { await sleep(20); continue; }
  next = Math.max(next + 60000 / RATE, Date.now()); recent.push(Date.now()); inflight++;
  oneName().then((r) => { if (r === "nofunds") noFunds++; else if (r !== "busy") noFunds = 0; if (r === "busy") next = Date.now() + BUSY_WAIT_MS; }).catch((e) => ev({ phase: "name_crash", error: String(e?.message || e).slice(0, 200) })).finally(() => { inflight--; });
  if (noFunds >= 3 && inflight <= 1) { exitReason = "funds_exhausted"; ev({ phase: "funds_exhausted_stop", reason: "no snapshot wallet can afford a name", funds_left_tkas: +tk(fundsSompi()).toFixed(2) }); break; }
  sampleConfirm().catch(() => {});
}
const drainEnd = Date.now() + 120000; while (inflight > 0 && Date.now() < drainEnd) await sleep(200);
await sleep(5000); clearInterval(statusTimer); saveStatus({ finished_at: now() });
if (stopping && exitReason === "stopped") exitReason = "signal";
// final summary (also written to final-summary.json)
const nm = fs.existsSync(NAMES) ? fs.readFileSync(NAMES, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const lat = nm.map((r) => r.accepted_latency_ms).sort((a, b) => a - b); const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
const elMin = (Date.now() - startedAt) / 60000;
const final = { at: now(), phase: "final_summary", run_id: RUN_ID, exit_reason: exitReason, owner_mode: OWNER_MODE, rate_cap_per_min: RATE, started_at: new Date(startedAt).toISOString(), runtime_min: +elMin.toFixed(1),
  names_ok_this_run: stats.names_ok - replayedOk, names_total_journal: nm.length, avg_names_per_min: +((stats.names_ok - replayedOk) / (elMin || 1)).toFixed(2), commit_fail: stats.commit_fail, reveal_fail: stats.reveal_fail, uncertain: stats.uncertain,
  stranded: fs.existsSync(path.join(DIR, "stranded.jsonl")) ? fs.readFileSync(path.join(DIR, "stranded.jsonl"), "utf8").trim().split("\n").filter(Boolean).length : 0,
  pending_reveals: pendingReveals.size, inflight_left: inflight, spend_tkas_this_run: tk(stats.spend_sompi), fees_tkas_this_run: tk(stats.fee_sompi), spend_tkas_journal: +nm.reduce((a, r) => a + r.name_spend_tkas, 0).toFixed(3),
  accepted_latency_ms_p50: q(0.5), accepted_latency_ms_p90: q(0.9), funds_left_tkas: +tk(fundsSompi()).toFixed(2), wallets_quarantined: [...wallets.values()].filter((w) => w.quarantined).length,
  public_api_calls_by_runner: fs.existsSync(PUBLIC_CALLS) ? fs.readFileSync(PUBLIC_CALLS, "utf8").split("\n").filter((l) => l.includes('"runner":true')).length : 0 };
ev(final); fs.writeFileSync(path.join(DIR, "final-summary.json"), JSON.stringify(final, null, 2) + "\n"); out(final);
ev({ phase: "runner_stop", exit_reason: exitReason, names_ok: stats.names_ok, spend_tkas: tk(stats.spend_sompi), inflight_left: inflight, pending_reveals: pendingReveals.size });
try { await rpc?.disconnect(); } catch {} process.exit(0);
