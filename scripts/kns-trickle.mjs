#!/usr/bin/env node
/**
 * KNS TN10 trickle (2026-10-02 overnight storm): random KNS domain TRANSFERS between the 100 funded-2026-10-02 wallets, one op every
 * random 2-6 s, paid from the wallets' leftover dust. TN10 only. Never prints keys. Never touches the treasury (qzffl5...), n0 config or miners.
 *
 * Op (official KNS docs, Inscriptions > Operations > Transfer): {"op":"transfer","p":"domain","id":"<revealId>i0","to":"<recipient>"}
 * Envelope: <sender xonly pubkey> OP_CHECKSIG OP_FALSE OP_IF "kns" 0 <payload> OP_ENDIF (same as create). Sender must be the current owner.
 * No protocol fee for transfer (fee model only prices create + text). Cost = network fees only.
 * Commit: ONE sender UTXO -> P2SH(envelope), all value (no change). Reveal: P2SH -> back to the sender (no change). The dust UTXO cycles;
 * each transfer costs only commit+reveal fees. 1-in/1-out keeps KIP-9 storage mass ~0.
 * Fee: mass * ceil(--feerate-margin (1.0) * live storm feerate /tmp/r6-feerate (<120 s)); else n0 getFeeEstimate max(priority, 2 x normal); else hold.
 * Stops on: own STOP file, /workspace/artifacts/stress-tests/STOP, n0 isSynced=false, --until time, --max-ops, funds exhausted, error storm.
 * Ownership state: funded-2026-10-02/names.jsonl (creates) + this folder's transfers.jsonl (accepted transfers). UTXO state: dust-view.json + events.jsonl.
 * Broadcast requires --broadcast 1 AND env KNS_TRICKLE_GO=1. --dry-run N builds+signs offline only (no RPC, nothing written but dryrun-status.json).
 */
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto"; import { pathToFileURL } from "node:url"; import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const D = "/workspace/artifacts/kns-tn10/trickle-2026-10-02", F = "/workspace/artifacts/kns-tn10/funded-2026-10-02", NET = "testnet-10";
const N0 = arg("--node", "ws://127.0.0.1:17210"), RUN_ID = arg("--run-id", "trickle-2026-10-02");
const TREASURY = "kaspatest:qzffl5xy9np46gkttyuftqnv2w04pr8g3wsp7c3vv8se3txtelx6q7c0v0ldx", STORM_STOP = "/workspace/artifacts/stress-tests/STOP", OWN_STOP = path.join(D, "STOP");
const DRY = Number(arg("--dry-run", "0")), BROADCAST = arg("--broadcast", "0") === "1";
const MIN_IV = Number(arg("--min-interval-ms", "2000")), MAX_IV = Number(arg("--max-interval-ms", "6000"));
let MARGIN = Number(arg("--feerate-margin", "1.0")); const MARGIN0 = MARGIN; const MAX_OPS = Number(arg("--max-ops", "0")), MAX_UNCONF = Number(arg("--max-unconfirmed", "40"));
const UNTIL = Date.parse(arg("--until", "2026-10-03T09:00:00+02:00")), MIN_UTXO = BigInt(Math.round(Number(arg("--min-utxo-tkas", "0.3")) * 1e8));
const MAX_ERR_10MIN = Number(arg("--max-errors-10min", "20"));
// control.json (written by tools/watchdog.py): {"rate_scale": 0.0625..1, "feerate_margin": x}. Re-read every 5 s; rate_scale divides the interval.
const CONTROL = path.join(D, "control.json"); let rateScale = 1, ctlAt = 0;
function readControl() { if (Date.now() - ctlAt < 5000) return; ctlAt = Date.now(); let c; try { c = JSON.parse(fs.readFileSync(CONTROL, "utf8")); } catch { return; }
  const sc = Math.min(1, Math.max(0.0625, Number(c.rate_scale) || 1)), m = Number(c.feerate_margin); const nm = m >= 1 && m <= 5 ? m : MARGIN;
  if (sc !== rateScale || nm !== MARGIN) { ev({ phase: "control_change", rate_scale: sc, feerate_margin: nm, prev: { rate_scale: rateScale, feerate_margin: MARGIN }, reason: c.reason }); rateScale = sc; MARGIN = nm; } }
const WATCH_SAMPLE = Number(arg("--watch-sample", "1")); // fraction of transfers whose commit+reveal are tracked to mempool exit (lower = fewer RPC polls + smaller events.jsonl at high rates)
const NAME_COOLDOWN_MS = Number(arg("--name-cooldown-min", "30")) * 60000, NEW_NAMES_PER_MIN = Number(arg("--new-names-per-min", "0"));
if (NEW_NAMES_PER_MIN > 0) { console.error("refusing: new names are disabled in this build (transfers only; stp 21:55)"); process.exit(2); }
if (BROADCAST && process.env.KNS_TRICKLE_GO !== "1") { console.error("refusing: --broadcast 1 needs env KNS_TRICKLE_GO=1"); process.exit(3); }
if (!BROADCAST && !DRY) { console.error("nothing to do: --dry-run N or --broadcast 1"); process.exit(3); }
const EVENTS = path.join(D, "events.jsonl"), TRANSFERS = path.join(D, "transfers.jsonl"), STATUS = path.join(D, DRY ? "dryrun-status.json" : "status.json");
const now = () => new Date().toISOString(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), tk = (s) => Number(BigInt(s)) / 1e8;
const ev = (o) => { if (DRY) return o; const r = { at: now(), ...o }; fs.appendFileSync(EVENTS, JSON.stringify(r) + "\n"); return r; };
const out = (o) => console.log(JSON.stringify({ at: now(), ...o }));
// ---- keys + addresses (memory only)
const meta = JSON.parse(fs.readFileSync(`${F}/wallet-meta.json`, "utf8")); const keyByIndex = new Map(), indexByAddr = new Map();
for (const l of fs.readFileSync(meta.privkeys_file, "utf8").split("\n")) { if (!l) continue; const j = JSON.parse(l); if (j.address === TREASURY) throw new Error("treasury in set"); keyByIndex.set(j.index, { address: j.address, hex: j.private_key_hex }); indexByAddr.set(j.address, j.index); }
const privCache = new Map(); const priv = (i) => { let p = privCache.get(i); if (!p) { p = new kaspa.PrivateKey(keyByIndex.get(i).hex); privCache.set(i, p); } return p; };
const addrOf = (i) => keyByIndex.get(i).address;
// ---- ownership: creates + accepted transfers
const names = new Map(); // domain -> { assetId, owner, lastMoved }
for (const l of fs.readFileSync(`${F}/names.jsonl`, "utf8").split("\n")) { if (!l) continue; const n = JSON.parse(l); names.set(n.domain, { assetId: `${n.revealId}i0`, owner: n.owner_index, lastMoved: 0 }); }
if (fs.existsSync(TRANSFERS)) for (const l of fs.readFileSync(TRANSFERS, "utf8").split("\n")) { if (!l) continue; const t = JSON.parse(l); const n = names.get(t.domain); if (n && n.owner === t.from_index) { n.owner = t.to_index; n.lastMoved = Date.parse(t.reveal_submit_at); } }
const byOwner = () => { const m = new Map(); for (const [d, n] of names) { if (!m.has(n.owner)) m.set(n.owner, []); m.get(n.owner).push(d); } return m; };
// ---- UTXOs: dust-view + journal replay
const ukey = (t, i) => `${t}:${i}`; const wallets = new Map(); // index -> Map(ukey -> utxo)
const wal = (i) => { if (!wallets.has(i)) wallets.set(i, new Map()); return wallets.get(i); };
const view = JSON.parse(fs.readFileSync(path.join(D, "dust-view.json"), "utf8"));
for (const [a, l] of Object.entries(view.byAddress)) { if (a === TREASURY || !indexByAddr.has(a)) continue; for (const u of l) wal(indexByAddr.get(a)).set(ukey(u.transactionId, u.index), u); }
const TOPUPS = path.join(D, "topups.json"); const topupDone = new Set(), topupRetry = new Map(); let topupUncertain = null;
const pending = new Map(); const stats = { transfers_ok: 0, commit_fail: 0, reveal_fail: 0, uncertain: 0, fee_sompi: 0n };
if (!DRY && fs.existsSync(EVENTS)) for (const l of fs.readFileSync(EVENTS, "utf8").split("\n")) { if (!l) continue; let e; try { e = JSON.parse(l); } catch { continue; }
  if (e.phase === "commit_accepted") { wal(e.from_index).delete(ukey(e.spent.txid, e.spent.index)); pending.set(e.commitId, e); }
  if (e.phase === "reveal_accepted") { pending.delete(e.commitId); wal(e.from_index).set(ukey(e.created.transactionId, e.created.index), e.created); stats.transfers_ok++; stats.fee_sompi += BigInt(e.total_fee_sompi || 0); }
  if (e.phase === "utxo_dropped") wal(e.from_index).delete(e.key);
  if (e.phase === "topup_fanout_accepted") { for (const k of e.spent_keys) topupDone.add(k); for (const c of e.created) wal(c.index).set(ukey(c.utxo.transactionId, c.utxo.index), c.utxo); }
  if (e.phase === "topup_skipped") topupDone.add(e.key); }
const funds = () => { let s = 0n; for (const m of wallets.values()) for (const u of m.values()) s += BigInt(u.amount); return s; };
// ---- fee
const DRY_FR = Number(arg("--dry-feerate", "0")); let n0Est = null, feeState = { mode: "init" };
function refreshFee() {
  if (DRY) return (feeState = { mode: "dry_fixed", live: DRY_FR || 200, used: Math.ceil((DRY_FR || 200) * MARGIN) });
  try { const st = fs.statSync("/tmp/r6-feerate"); const v = Number(fs.readFileSync("/tmp/r6-feerate", "utf8").trim()); if (Date.now() - st.mtimeMs < 120000 && v > 0 && v < 1e6) return (feeState = { mode: "live_file", live: v, used: Math.ceil(v * MARGIN) }); } catch {}
  if (n0Est && Date.now() - n0Est.at < 60000) return (feeState = { mode: "n0_estimate", live: n0Est.feerate, used: Math.ceil(n0Est.feerate * MARGIN) });
  return (feeState = { mode: "none", used: null }); }
async function createTx(opts) { // fee = max(1x, mass * used) with one re-price on the final mass (+2%)
  const first = await kaspa.createTransactions(opts); const f = feeState; const oneX = BigInt(first.summary.fees);
  let target = BigInt(first.transactions[0].mass) * BigInt(f.used); if (target <= oneX) return first;
  let r = await kaspa.createTransactions({ ...opts, priorityFee: target - oneX });
  const t2 = (BigInt(r.transactions[0].mass) * BigInt(f.used) * 102n) / 100n; if (BigInt(r.summary.fees) < t2) r = await kaspa.createTransactions({ ...opts, priorityFee: t2 - oneX });
  return r; }
const spkHex = (spk) => (typeof spk === "string" ? spk : spk.script ?? spk.toString());
const entryOf = (addr, u) => ({ address: addr, outpoint: { transactionId: u.transactionId, index: u.index }, amount: BigInt(u.amount), scriptPublicKey: u.scriptPublicKey, blockDaaScore: BigInt(u.blockDaaScore || 0), isCoinbase: false });
const outUtxo = (txid, i, o) => ({ transactionId: txid, index: i, amount: String(o.value), scriptPublicKey: { version: o.scriptPublicKey.version, script: o.scriptPublicKey.script }, blockDaaScore: "0", isCoinbase: false });
function envelope(fromIndex, payloadObj) { const k = priv(fromIndex); const kp = k.toKeypair(); const payload = JSON.stringify(payloadObj);
  const script = new kaspa.ScriptBuilder().addData(kp.xOnlyPublicKey).addOp(kaspa.Opcodes.OpCheckSig).addOp(kaspa.Opcodes.OpFalse).addOp(kaspa.Opcodes.OpIf).addData(Buffer.from("kns")).addI64(0n).addData(Buffer.from(payload)).addOp(kaspa.Opcodes.OpEndIf);
  const spk = script.createPayToScriptHashScript(); return { key: k, script, spk, p2shAddr: kaspa.addressFromScriptPublicKey(spk, NET).toString(), payload }; }
async function buildCommit(fromIndex, utxo, env) {
  const from = addrOf(fromIndex); if (from === TREASURY) throw new Error("forbidden");
  const { transactions: t } = await createTx({ priorityEntries: [entryOf(from, utxo)], entries: [], outputs: [], changeAddress: env.p2shAddr, priorityFee: 0n, networkId: NET });
  if (t.length !== 1) throw new Error("commit_multi_tx"); const c = t[0]; c.sign([env.key]);
  const tx = c.transaction; if (tx.inputs.length !== 1 || tx.outputs.length !== 1 || spkHex(tx.outputs[0].scriptPublicKey) !== spkHex(env.spk)) throw new Error("commit_shape");
  return { pt: c, id: c.id, fee: BigInt(c.feeAmount), mass: String(c.mass), lock: BigInt(tx.outputs[0].value) }; }
async function buildReveal(fromIndex, commitId, lock, env) {
  const from = addrOf(fromIndex); const p2shEntry = { address: env.p2shAddr, outpoint: { transactionId: commitId, index: 0 }, amount: lock, scriptPublicKey: env.spk, blockDaaScore: 0n, isCoinbase: false };
  const { transactions: t } = await createTx({ priorityEntries: [p2shEntry], entries: [], outputs: [], changeAddress: from, priorityFee: 0n, networkId: NET });
  if (t.length !== 1) throw new Error("reveal_multi_tx"); const r = t[0]; r.sign([env.key], false);
  const idx = r.transaction.inputs.findIndex((i) => !i.signatureScript || i.signatureScript === ""); if (idx < 0) throw new Error("reveal_no_empty_sig_input");
  r.fillInput(idx, env.script.encodePayToScriptHashSignatureScript(await r.createInputSignature(idx, env.key)));
  const tx = r.transaction; if (tx.outputs.length !== 1 || kaspa.addressFromScriptPublicKey(tx.outputs[0].scriptPublicKey, NET).toString() !== from) throw new Error("reveal_shape");
  return { pt: r, id: r.id, fee: BigInt(r.feeAmount), mass: String(r.mass), created: outUtxo(r.id, 0, tx.outputs[0]) }; }
// ---- top-ups: externally funded UTXOs listed in topups.json (written by tools/topup-lookup.mjs, which verifies them on n0 / public TN10 API).
// Each entry {txid,index,amount_sompi,address,verified_by}. The runner fans ALL new entries out to the 100 wallets (equal split, one tx per group,
// mass <= 90,000) between transfers. n0 accepting the fan-out is the binding check: the signature commits to each input's amount and script, and a
// missing outpoint is rejected (nothing is added to the view unless n0 accepts). Rejected entries are retried every 2 min, max 15 times.
const spkOf = (addr) => { const s = kaspa.payToAddressScript(addr); return { version: s.version, script: s.script }; };
async function buildFanout(fresh, G) {
  const targets = [...keyByIndex.keys()].sort((a, b) => a - b); const ins = [...fresh].sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0));
  const groups = Array.from({ length: G }, () => []); ins.forEach((x, i) => groups[i % G].push(x)); const per = Math.ceil(targets.length / G); const res = [];
  for (let g = 0; g < G; g++) { const tg = targets.slice(g * per, (g + 1) * per); const gi = groups[g]; if (!tg.length || !gi.length) return null;
    const sum = gi.reduce((s, x) => s + x.amt, 0n); const A = sum / BigInt(tg.length); if (A < 100000000n) return null;
    const entries = gi.map((x) => entryOf(x.address, { transactionId: x.txid, index: x.index, amount: String(x.amt), scriptPublicKey: spkOf(x.address), blockDaaScore: "0" }));
    const outputs = tg.slice(0, -1).map((i) => ({ address: addrOf(i), amount: A }));
    const { transactions: t } = await createTx({ priorityEntries: entries, entries: [], outputs, changeAddress: addrOf(tg.at(-1)), priorityFee: 0n, networkId: NET });
    if (t.length !== 1 || Number(t[0].mass) > 90000) return null; const c = t[0]; c.sign([...new Set(gi.map((x) => x.fromIndex))].map(priv));
    const tx = c.transaction; const created = tx.outputs.map((o, j) => ({ index: indexByAddr.get(kaspa.addressFromScriptPublicKey(o.scriptPublicKey, NET).toString()), utxo: outUtxo(c.id, j, o) }));
    if (created.some((x) => x.index === undefined)) throw new Error("fanout_output_outside_set");
    res.push({ pt: c, id: c.id, fee: BigInt(c.feeAmount), mass: String(c.mass), keys: gi.map((x) => x.k), sum, created }); }
  return res; }
function readTopups() { let list; try { list = JSON.parse(fs.readFileSync(TOPUPS, "utf8")); } catch (e) { if (e.code !== "ENOENT") ev({ phase: "topups_parse_error", error: String(e.message).slice(0, 120) }); return []; }
  const fresh = []; for (const t of Array.isArray(list) ? list : list.utxos || []) { const k = ukey(t.txid, t.index); if (topupDone.has(k)) continue; const r = topupRetry.get(k); if (r && (r.n >= 15 || Date.now() < r.next)) continue;
    let bad = null; let amt = 0n; try { amt = BigInt(t.amount_sompi); } catch { bad = "bad_amount"; }
    if (!/^[0-9a-f]{64}$/.test(t.txid || "") || !Number.isInteger(t.index)) bad = "bad_outpoint"; else if (t.address === TREASURY || !indexByAddr.has(t.address)) bad = "address_not_in_funded_set"; else if (amt <= 0n) bad = bad || "bad_amount"; else if (!t.verified_by && !t.force) bad = "unverified";
    if (bad) { ev({ phase: "topup_skipped", key: k, reason: bad }); topupDone.add(k); continue; }
    fresh.push({ ...t, k, amt, fromIndex: indexByAddr.get(t.address) }); }
  return fresh; }
// ---- selection
const busy = new Set(); // wallet indexes with an op in progress
function pick() {
  const own = byOwner(); const t = Date.now(); const cands = [];
  for (const [i, m] of wallets) { if (busy.has(i)) continue; const us = [...m.values()].filter((u) => BigInt(u.amount) >= MIN_UTXO); if (!us.length) continue;
    const ds = (own.get(i) || []).filter((d) => t - names.get(d).lastMoved >= NAME_COOLDOWN_MS); if (ds.length) cands.push({ i, us, ds }); }
  if (!cands.length) return null; const c = cands[crypto.randomInt(cands.length)];
  let to; do { to = crypto.randomInt(keyByIndex.size); } while (to === c.i);
  return { from: c.i, to, utxo: c.us[crypto.randomInt(c.us.length)], domain: c.ds[crypto.randomInt(c.ds.length)] }; }
// ---- DRY RUN: build+sign transfers offline at the given feerate, apply to an in-memory view, report masses and costs
if (DRY && arg("--dry-topups", null)) { refreshFee(); const fake = JSON.parse(fs.readFileSync(arg("--dry-topups"), "utf8"));
  const fresh = fake.map((t) => ({ ...t, k: ukey(t.txid, t.index), amt: BigInt(t.amount_sompi), fromIndex: indexByAddr.get(t.address) }));
  for (let G = 1; G <= 8; G *= 2) { const r = await buildFanout(fresh, G); if (!r) continue;
    console.log(JSON.stringify({ phase: "dry_fanout", groups: G, feerate_used: feeState.used, txs: r.map((x) => ({ inputs: x.keys.length, outputs: x.created.length, mass: +x.mass, fee_tkas: tk(x.fee), in_tkas: tk(x.sum),
      per_wallet_tkas: [...new Set(x.created.map((c) => tk(c.utxo.amount)))].slice(0, 3), signed: x.pt.transaction.inputs.every((i) => i.signatureScript?.length) })) })); break; }
  process.exit(0); }
if (DRY) {
  refreshFee(); const rows = [];
  for (let k = 0; k < DRY; k++) { const p = pick(); if (!p) break; const n = names.get(p.domain);
    const env = envelope(p.from, { op: "transfer", p: "domain", id: n.assetId, to: addrOf(p.to) });
    const c = await buildCommit(p.from, p.utxo, env); const r = await buildReveal(p.from, c.id, c.lock, env);
    const signed = c.pt.transaction.inputs.every((x) => x.signatureScript?.length) && r.pt.transaction.inputs.every((x) => x.signatureScript?.length);
    wal(p.from).delete(ukey(p.utxo.transactionId, p.utxo.index)); wal(p.from).set(ukey(r.created.transactionId, 0), r.created); n.owner = p.to; n.lastMoved = Date.now();
    rows.push({ commit_mass: +c.mass, reveal_mass: +r.mass, fee: Number(c.fee + r.fee) / 1e8, signed, payload_len: env.payload.length }); }
  const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / (rows.length || 1);
  const s = { at: now(), phase: "dry_run_done", feerate_live: feeState.live, feerate_used: feeState.used, built: rows.length, all_signed: rows.every((r) => r.signed), avg_commit_mass: avg("commit_mass"), avg_reveal_mass: avg("reveal_mass"),
    avg_fee_per_transfer_tkas: +avg("fee").toFixed(8), max_payload_len: Math.max(...rows.map((r) => r.payload_len)), dust_tkas_start: tk(view.byAddress ? Object.values(view.byAddress).flat().reduce((s, u) => s + BigInt(u.amount), 0n) : 0n), dust_tkas_left: tk(funds()),
    est_transfers_from_dust: Math.floor(tk(funds()) / (avg("fee") || 1)) };
  fs.writeFileSync(STATUS, JSON.stringify(s, null, 1) + "\n"); console.log(JSON.stringify(s)); process.exit(0);
}
// ---- LIVE
let rpc = null;
async function getRpc() { if (rpc && rpc.isConnected) return rpc; const c = new kaspa.RpcClient({ url: N0, encoding: kaspa.Encoding.Borsh, networkId: NET }); await c.connect({ timeoutDuration: 10000 }); return (rpc = c); }
async function inMempool(id) { try { const r = await (await getRpc()).getMempoolEntry({ transactionId: id, includeOrphanPool: true, filterTransactionPool: false }); return !!r?.mempoolEntry; } catch (e) { if (rpc && !rpc.isConnected) rpc = null; return /not found/i.test(String(e?.message || e)) ? false : null; } }
async function submit(pt) { const id = pt.id, t = Date.now(); try { await pt.submit(await getRpc()); return { ok: true, id, ms: Date.now() - t }; }
  catch (e) { const m = String(e?.message || e); if (rpc && !rpc.isConnected) rpc = null; if (/reject/i.test(m)) return { ok: false, rejected: true, id, error: m.slice(0, 240) };
    await sleep(2000); if ((await inMempool(id)) === true) return { ok: true, id, ms: Date.now() - t, note: "accepted_after_uncertain_submit" }; return { ok: false, uncertain: true, id, error: m.slice(0, 240) }; } }
async function refreshN0() { try { const c = await getRpc(); const r = await c.getFeeEstimate({}); const e = r.estimate || r; const pr = Number(e.priorityBucket?.feerate || 0), nb = Number(e.normalBuckets?.[0]?.feerate || 0); n0Est = { feerate: Math.max(pr, 2 * nb), at: Date.now() }; } catch {} }
const watch = new Map(); const startedAt = Date.now(); let stopping = false, exitReason = "stopped", opsThisRun = 0, errStreak = 0; const errTimes = [];
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { stopping = true; exitReason = "signal"; });
setInterval(async () => { for (const [id, w] of watch) { const m = await inMempool(id); if (m === null) continue; if (m) { if (Date.now() - w.at > 30 * 60000) { ev({ phase: "still_in_mempool_30min", txid: id, kind: w.kind }); watch.delete(id); } continue; }
  ev({ phase: `${w.kind}_left_mempool`, txid: id, domain: w.domain, since_submit_ms: Date.now() - w.at }); watch.delete(id); } }, 3000).unref();
function saveStatus(extra = {}) { fs.writeFileSync(STATUS, JSON.stringify({ at: now(), pid: process.pid, run_id: RUN_ID, started_at: new Date(startedAt).toISOString(), ops_this_run: opsThisRun, ...stats, fee_sompi: undefined, fees_tkas: tk(stats.fee_sompi), dust_left_tkas: tk(funds()), watching: watch.size, fee: feeState, rate_scale: rateScale, feerate_margin: MARGIN, stopping, ...extra }, null, 1) + "\n"); }
async function doReveal(info, env) { for (let a = 1; a <= 4; a++) { if (a > 1) await sleep([0, 2000, 10000, 30000][a - 1]);
    let r; try { refreshFee(); r = await buildReveal(info.from_index, info.commitId, BigInt(info.lock_sompi), env); } catch (e) { ev({ phase: "reveal_build_failed", commitId: info.commitId, error: String(e?.message || e).slice(0, 160) }); continue; }
    const tr = Date.now(); const rr = await submit(r.pt); if (rr.ok) return { r, rr, tr, attempt: a };
    if (rr.uncertain) { stats.uncertain++; ev({ phase: "tx_uncertain", kind: "reveal", commitId: info.commitId, revealId: rr.id, error: rr.error }); return null; }
    ev({ phase: "reveal_rejected", commitId: info.commitId, revealId: rr.id, attempt: a, error: rr.error }); if (/already spent/i.test(rr.error)) return null; } return null; }
async function applyTopups() {
  if (topupUncertain) { const m = await inMempool(topupUncertain.id); if (m === true) { const u = topupUncertain; topupUncertain = null; for (const k of u.keys) topupDone.add(k); for (const c of u.created) wal(c.index).set(ukey(c.utxo.transactionId, c.utxo.index), c.utxo);
      ev({ phase: "topup_fanout_accepted", txid: u.id, note: "found in mempool after uncertain submit", spent_keys: u.keys, created: u.created, fee_sompi: String(u.fee), mass: u.mass }); } else return; }
  const fresh = readTopups(); if (!fresh.length) return; if (!refreshFee().used) return;
  let built = null; for (let G = 1; G <= Math.min(16, fresh.length); G *= 2) { try { built = await buildFanout(fresh, G); } catch (e) { built = null; ev({ phase: "topup_build_retry_groups", groups: G, error: String(e?.message || e).slice(0, 160) }); } if (built) break; }
  if (!built) { ev({ phase: "topup_build_failed", error: "no mass-safe grouping", entries: fresh.length }); for (const x of fresh) topupRetry.set(x.k, { n: 99, next: 0 }); return; }
  for (const b of built) { const r = await submit(b.pt);
    if (r.ok) { for (const k of b.keys) topupDone.add(k); for (const c of b.created) wal(c.index).set(ukey(c.utxo.transactionId, c.utxo.index), c.utxo);
      ev({ phase: "topup_fanout_accepted", txid: b.id, spent_keys: b.keys, in_tkas: tk(b.sum), outputs: b.created.length, created: b.created, fee_sompi: String(b.fee), mass: b.mass, feerate_used: feeState.used, dust_tkas_after: tk(funds()) }); watch.set(b.id, { kind: "topup_fanout", at: Date.now() }); }
    else if (r.uncertain) { topupUncertain = b; ev({ phase: "tx_uncertain", kind: "topup_fanout", txid: b.id, error: r.error }); return; }
    else { for (const k of b.keys) { const o = topupRetry.get(k) || { n: 0 }; topupRetry.set(k, { n: o.n + 1, next: Date.now() + 120000 }); } ev({ phase: "topup_fanout_rejected", txid: b.id, keys: b.keys, error: r.error, retry_in_s: 120 }); } } }
async function oneTransfer() {
  if (!refreshFee().used) { ev({ phase: "no_feerate_hold" }); return "hold"; }
  const p = pick(); if (!p) return "nofunds"; const n = names.get(p.domain); busy.add(p.from); const t0 = Date.now();
  try {
    const payloadObj = { op: "transfer", p: "domain", id: n.assetId, to: addrOf(p.to) }; const env = envelope(p.from, payloadObj);
    const c = await buildCommit(p.from, p.utxo, env); const tc = Date.now(); const cr = await submit(c.pt);
    if (!cr.ok) { stats[cr.uncertain ? "uncertain" : "commit_fail"]++; const k = ukey(p.utxo.transactionId, p.utxo.index);
      if (cr.uncertain || /already spent|missing|orphan|not found/i.test(cr.error)) { wal(p.from).delete(k); ev({ phase: "utxo_dropped", from_index: p.from, key: k, reason: cr.uncertain ? "uncertain_commit" : "stale_utxo" }); }
      ev({ phase: cr.uncertain ? "tx_uncertain" : "commit_rejected", kind: "commit", domain: p.domain, commitId: cr.id, error: cr.error }); return "fail"; }
    wal(p.from).delete(ukey(p.utxo.transactionId, p.utxo.index));
    const info = { domain: p.domain, assetId: n.assetId, from_index: p.from, to_index: p.to, commitId: c.id, lock_sompi: String(c.lock), commit_fee_sompi: String(c.fee), commit_mass: c.mass, payload: env.payload, spent: { txid: p.utxo.transactionId, index: p.utxo.index } };
    ev({ phase: "commit_accepted", ...info, commit_submit_at: new Date(tc).toISOString(), fee_mode: feeState.mode, feerate_live: feeState.live, feerate_used: feeState.used }); pending.set(c.id, info); watch.set(c.id, { kind: "commit", at: Date.now(), domain: p.domain });
    const sampled = Math.random() < WATCH_SAMPLE; if (!sampled) watch.delete(c.id);
    const rv = await doReveal(info, env);
    if (!rv) { stats.reveal_fail++; ev({ phase: "reveal_failed_pending", ...info, note: "P2SH holds the funds; reveal can be rebuilt on restart; name NOT transferred, not burned" }); return "fail"; }
    pending.delete(c.id); wal(p.from).set(ukey(rv.r.created.transactionId, 0), rv.r.created); n.owner = p.to; n.lastMoved = Date.now();
    const fee = c.fee + rv.r.fee; stats.transfers_ok++; stats.fee_sompi += fee; opsThisRun++;
    ev({ phase: "reveal_accepted", commitId: c.id, revealId: rv.r.id, domain: p.domain, from_index: p.from, to_index: p.to, created: rv.r.created, reveal_fee_sompi: String(rv.r.fee), reveal_mass: rv.r.mass, total_fee_sompi: String(fee), attempt: rv.attempt, note: rv.rr.note });
    fs.appendFileSync(TRANSFERS, JSON.stringify({ at: now(), run_id: RUN_ID, domain: p.domain, assetId: n.assetId, from_index: p.from, from: addrOf(p.from), to_index: p.to, to: addrOf(p.to), commitId: c.id, revealId: rv.r.id,
      commit_submit_at: new Date(tc).toISOString(), reveal_submit_at: new Date(rv.tr).toISOString(), accepted_latency_ms: Date.now() - t0, commit_fee_tkas: tk(c.fee), reveal_fee_tkas: tk(rv.r.fee), fee_tkas: tk(fee), feerate_used: feeState.used, fee_mode: feeState.mode, attempts: rv.attempt }) + "\n");
    if (sampled) watch.set(rv.r.id, { kind: "reveal", at: Date.now(), domain: p.domain }); return "ok";
  } catch (e) { stats.commit_fail++; ev({ phase: "build_failed", domain: p.domain, error: String(e?.message || e).slice(0, 200) }); return "fail"; }
  finally { busy.delete(p.from); } }
// startup
const si = await (await getRpc()).getServerInfo(); await refreshN0(); setInterval(refreshN0, 15000).unref();
ev({ phase: "runner_start", pid: process.pid, run_id: RUN_ID, node: N0, synced: si.isSynced, dust_tkas: tk(funds()), wallets: wallets.size, names: names.size, transfers_journal: stats.transfers_ok, pending_reveals: pending.size, fee: refreshFee(), interval_ms: [MIN_IV, MAX_IV], until: new Date(UNTIL).toISOString(), max_ops: MAX_OPS });
if (!si.isSynced) { exitReason = "n0_not_synced"; ev({ phase: "abort", reason: exitReason }); process.exit(4); }
for (const [cid, info] of [...pending]) { const env = envelope(info.from_index, JSON.parse(info.payload)); const rv = await doReveal(info, env);
  if (rv) { pending.delete(cid); wal(info.from_index).set(ukey(rv.r.created.transactionId, 0), rv.r.created); const n = names.get(info.domain); n.owner = info.to_index; n.lastMoved = Date.now(); stats.transfers_ok++;
    ev({ phase: "reveal_accepted", recovered: true, commitId: cid, revealId: rv.r.id, domain: info.domain, from_index: info.from_index, to_index: info.to_index, created: rv.r.created, total_fee_sompi: String(BigInt(info.commit_fee_sompi) + rv.r.fee) });
    fs.appendFileSync(TRANSFERS, JSON.stringify({ at: now(), run_id: RUN_ID, domain: info.domain, assetId: info.assetId, from_index: info.from_index, from: addrOf(info.from_index), to_index: info.to_index, to: addrOf(info.to_index), commitId: cid, revealId: rv.r.id, reveal_submit_at: new Date(rv.tr).toISOString(), recovered: true }) + "\n"); } }
const statusTimer = setInterval(() => saveStatus(), 15000); let lastSync = Date.now(), lastTopup = 0;
while (!stopping) {
  if (fs.existsSync(OWN_STOP)) { exitReason = "stop_file"; break; }
  if (fs.existsSync(STORM_STOP)) { exitReason = "storm_stop_file"; break; }
  if (Date.now() >= UNTIL) { exitReason = "until_reached"; break; }
  if (MAX_OPS && opsThisRun >= MAX_OPS) { exitReason = "max_ops_reached"; break; }
  if (Date.now() - lastSync > 30000) { lastSync = Date.now(); try { const s2 = await (await getRpc()).getServerInfo(); if (!s2.isSynced) { exitReason = "n0_not_synced"; break; } } catch (e) { ev({ phase: "n0_info_error", error: String(e?.message || e).slice(0, 120) }); } }
  if (Date.now() - lastTopup > 20000) { lastTopup = Date.now(); try { await applyTopups(); } catch (e) { ev({ phase: "topup_error", error: String(e?.message || e).slice(0, 160) }); } }
  if (watch.size >= MAX_UNCONF) { await sleep(1000); continue; }
  const r = await oneTransfer();
  if (r === "nofunds") { exitReason = "funds_exhausted"; break; }
  if (r === "fail") { errStreak++; errTimes.push(Date.now()); while (errTimes.length && Date.now() - errTimes[0] > 600000) errTimes.shift();
    if (errTimes.length >= MAX_ERR_10MIN) { exitReason = "too_many_errors"; break; } if (errStreak >= 5) { ev({ phase: "error_backoff", streak: errStreak }); await sleep(60000); } } else if (r === "ok") errStreak = 0;
  readControl(); await sleep(r === "hold" ? 5000 : (MIN_IV + crypto.randomInt(Math.max(1, MAX_IV - MIN_IV))) / rateScale);
}
ev({ phase: "stopping", reason: exitReason }); const dEnd = Date.now() + 60000; while (watch.size && Date.now() < dEnd) await sleep(1000);
clearInterval(statusTimer); saveStatus({ finished_at: now(), exit_reason: exitReason });
// summary
const T = fs.existsSync(TRANSFERS) ? fs.readFileSync(TRANSFERS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const E = fs.readFileSync(EVENTS, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); const q = (a, p) => { a = [...a].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null; };
const ex = E.filter((e) => /_left_mempool$/.test(e.phase)).map((e) => e.since_submit_ms); const ts = T.map((t) => Date.parse(t.reveal_submit_at)).filter(Boolean).sort((a, b) => a - b);
const summary = { at: now(), run_id: RUN_ID, exit_reason: exitReason, started_at: new Date(startedAt).toISOString(), transfers_total_journal: T.length, transfers_this_run: opsThisRun,
  avg_interval_s: ts.length > 1 ? +((ts.at(-1) - ts[0]) / 1000 / (ts.length - 1)).toFixed(2) : null, commit_fail: stats.commit_fail, reveal_fail: stats.reveal_fail, uncertain: stats.uncertain, pending_reveals: pending.size,
  accepted_latency_ms: { p50: q(T.map((t) => t.accepted_latency_ms).filter(Boolean), 0.5), p90: q(T.map((t) => t.accepted_latency_ms).filter(Boolean), 0.9) }, mempool_exit_ms: { p50: q(ex, 0.5), p90: q(ex, 0.9), n: ex.length },
  fees_tkas: +T.reduce((s, t) => s + (t.fee_tkas || 0), 0).toFixed(8), dust_left_tkas: tk(funds()), first: T[0] && { at: T[0].reveal_submit_at, domain: T[0].domain, commitId: T[0].commitId, revealId: T[0].revealId }, last: T.at(-1) && { at: T.at(-1).reveal_submit_at, domain: T.at(-1).domain, commitId: T.at(-1).commitId, revealId: T.at(-1).revealId } };
fs.writeFileSync(path.join(D, "summary.json"), JSON.stringify(summary, null, 1) + "\n"); ev({ phase: "runner_stop", ...summary }); out(summary);
try { await rpc?.disconnect(); } catch {} process.exit(0);
