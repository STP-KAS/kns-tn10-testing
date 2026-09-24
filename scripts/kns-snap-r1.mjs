#!/usr/bin/env node
/**
 * R1 worker (TN10 only), SINGLE PROCESS: creates exactly ONE KNS name per snapshot wallet 20700-25699 using N concurrent
 * async lanes in-process (each lane handles one wallet at a time; one wallet signs at a time). Memory-light by design
 * (box was hitting the OOM killer): no child processes, one wasm SDK instance, shared public-resolver RPC connection(s).
 *
 * Create logic = in-process port of scripts/kns-s3-create.mjs (the FIXED create script):
 *  - reuses an existing P2SH commit UTXO for the label (stranded by an earlier failed attempt) instead of committing again;
 *  - the reveal spends only the commit's own change output seen on the SAME rpc connection + the P2SH UTXO
 *    (avoids the stale-UTXO "already spent" retry double-spend bug).
 * Coin data: public TN10 resolver (same as s3). Local TN10 kaspads (16210/16220) are the miner farm and run without
 * --utxoindex, so they cannot serve UTXO/balance queries and are never used.
 *
 * Wallet source: funded indices from desk-fund-r1-status.json (written after on-chain confirmation by treasury-fund-r1.mjs),
 * index order. Names from r1-names.csv (+ r1-name-overrides.jsonl). "Name taken" -> fresh seeded random name, same length.
 * Concurrency: starts at r1-start-workers (10), auto-scales up to r1-max-workers (15) when the rolling 30-min error rate < 2%;
 * > 5% or >= 3 rate-limit/timeout events -> -2 lanes (min 3) and a 5-min pause. Lanes pause while MemAvailable < 1000 MB.
 * Stop: snapshot-wallets/r1-STOP -> lanes finish their current wallet, then the process exits.
 * NEVER prints private keys.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);
try { fs.writeFileSync("/proc/self/oom_score_adj", "500"); } catch {}

const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets", API_DIR = "/workspace/artifacts/kns-tn10/api";
const KNS_API = "https://api.knsdomains.org/tn10/api/v1";
const FEE_ADDR = "kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru";
const NETWORK = "testnet-10";
const DONE = `${OUT}/r1-done`, FAILED = `${OUT}/r1-failed`;
const NAMES = `${OUT}/r1-names.csv`, OVERRIDES = `${OUT}/r1-name-overrides.jsonl`, FUND = `${OUT}/desk-fund-r1-status.json`;
const STOP = `${OUT}/r1-STOP`, STATE = `${OUT}/r1-worker-state.json`, LOG = `${OUT}/r1-worker.jsonl`;
const FROM = 20700, TO = 25699, RETRIES = 3, MAX_FAIL_PASSES = 3, FAIL_COOLDOWN_MS = 15 * 60000, LANE_DELAY_MS = 12000, MIN_AVAIL_MB = 1000;
for (const d of [DONE, FAILED]) fs.mkdirSync(d, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const readJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const readN = (p, d) => { try { const n = Number(fs.readFileSync(p, "utf8").trim()); return Number.isFinite(n) && n > 0 ? n : d; } catch { return d; } };
const emit = (o) => { const row = JSON.stringify({ t: now(), ...o }); fs.appendFileSync(LOG, row + "\n"); console.log(row); };
const feeFor = (n) => (n <= 2 ? 4200 : n === 3 ? 2100 : n === 4 ? 525 : 35);
const memAvailMb = () => { try { return Number(fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)[1]) / 1024; } catch { return 1e9; } };
const free = (...xs) => { for (const x of xs) { try { x?.free?.(); } catch {} } };

// ---- data (keys in memory only)
const meta = readJ(`${OUT}/meta.json`, {});
const keys = new Map();
for (const l of fs.readFileSync(meta.privkeys_file, "utf8").split("\n")) {
  const m = l.match(/^\{"index":(\d+),/); if (!m || +m[1] < FROM || +m[1] > TO) continue;
  const j = JSON.parse(l); keys.set(j.index, { address: j.address, hex: j.private_key_hex });
}
const plan = new Map();
for (const l of fs.readFileSync(NAMES, "utf8").trim().split("\n").slice(1)) { const [i, a, n] = l.split(","); plan.set(+i, { address: a, name: n }); }
const overrides = new Map(); const usedNames = new Set([...plan.values()].map((p) => p.name));
try { for (const l of fs.readFileSync(OVERRIDES, "utf8").split("\n")) { if (!l) continue; const o = JSON.parse(l); overrides.set(o.index, o.name); usedNames.add(o.name); } } catch {}
const currentName = (i) => overrides.get(i) || plan.get(i).name;
const isDone = (i) => fs.existsSync(`${DONE}/w${i}`);

// ---- stats / state
const st = { pid: process.pid, started_at: now(), lanes_target: readN(`${OUT}/r1-start-workers`, 10), lanes_running: 0, ok: 0, failed: 0, taken_renamed: 0, attempts: 0, attempt_errors: 0, rate_limited: 0, indexer_errors: 0, rpc_reconnects: 0, active: {}, events: [], recent: [] };
let lastScale = Date.now(), backoffUntil = 0;
const record = (ok, rl) => { st.recent.push({ t: Date.now(), ok, rl: !!rl }); if (st.recent.length > 300) st.recent.shift(); };
const window30 = () => { const c = Date.now() - 30 * 60000; let a = 0, e = 0, rl = 0; for (const r of st.recent) if (r.t >= c) { a++; if (!r.ok) e++; if (r.rl) rl++; } return { attempts: a, errors: e, rate: a ? +(e / a).toFixed(4) : 0, rate_limited: rl }; };
const saveState = () => { st.updated_at = now(); st.window = window30(); st.avail_mb = Math.round(memAvailMb()); st.rss_mb = Math.round(process.memoryUsage().rss / 1048576); st.ceiling = Math.min(20, readN(`${OUT}/r1-max-workers`, 15)); st.backoff_until = backoffUntil ? new Date(backoffUntil).toISOString() : null; st.stop_file = fs.existsSync(STOP); const { recent, ...o } = st; fs.writeFileSync(STATE + ".tmp", JSON.stringify(o, null, 2) + "\n"); fs.renameSync(STATE + ".tmp", STATE); };

// ---- shared RPC (public resolver, like s3). A lane keeps the same client object for a whole create.
let rpc = null, rpcConnecting = null;
async function getRpc() {
  if (rpc && rpc.isConnected) return rpc;
  if (rpcConnecting) return rpcConnecting;
  rpcConnecting = (async () => {
    for (let a = 0; ; a++) {
      try { const c = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: NETWORK }); await c.connect(); const info = await c.getServerInfo(); if (!info.isSynced) { await c.disconnect(); throw new Error("not synced"); } if (rpc) st.rpc_reconnects++; rpc = c; st.rpc_url = c.url; emit({ phase: "rpc", url: c.url }); return c; }
      catch (e) { await sleep(Math.min(60000, 5000 * (a + 1))); }
    }
  })();
  try { return await rpcConnecting; } finally { rpcConnecting = null; }
}
const RL_RE = /\b429\b|Too Many Requests|timed? ?out|ETIMEDOUT|ECONNRESET|socket hang up|WebSocket|not connected|disconnected/i;

async function indexerFetch(url, opts) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) }); if (r.status === 429) { st.rate_limited++; await sleep(10000 * (a + 1)); continue; } return r; }
    catch { st.indexer_errors++; await sleep(3000 * (a + 1)); }
  }
  return null;
}
async function checkAvail(names, addr) {
  const r = await indexerFetch(`${KNS_API}/domains/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domainNames: names.map((n) => n + ".kas"), address: addr }) });
  if (!r) return null; try { const j = await r.json(); const m = new Map(); for (const d of j.data.domains) m.set(d.domain.replace(/\.kas$/, ""), d.available === true && d.isReservedDomain === false); return m; } catch { return null; }
}
async function ownerOf(label) { const r = await indexerFetch(`${KNS_API}/${encodeURIComponent(label + ".kas")}/owner`); if (!r || r.status !== 200) return null; try { return await r.json(); } catch { return null; } }

// ---- create one name (port of kns-s3-create.mjs)
async function createName(label, privHex) {
  const domain = `${label}.kas`; const feeKas = feeFor([...label].length);
  const privateKey = new kaspa.PrivateKey(privHex); const keypair = privateKey.toKeypair();
  const payer = keypair.toAddress(NETWORK).toString();
  const payload = JSON.stringify({ op: "create", p: "domain", v: label });
  const script = new kaspa.ScriptBuilder().addData(keypair.xOnlyPublicKey).addOp(kaspa.Opcodes.OpCheckSig).addOp(kaspa.Opcodes.OpFalse).addOp(kaspa.Opcodes.OpIf)
    .addData(Buffer.from("kns")).addI64(0n).addData(Buffer.from(payload)).addOp(kaspa.Opcodes.OpEndIf);
  const p2shAddress = kaspa.addressFromScriptPublicKey(script.createPayToScriptHashScript(), NETWORK).toString();
  const res = { label, payer, p2shAddress, committed: false, commitId: null, revealId: null };
  try {
    const av = await checkAvail([label], payer);
    if (!av) return { ...res, error: "indexer_check_failed", rateLimited: true };
    if (av.get(label) !== true) return { ...res, notAvail: true, error: "Domain not available" };
    const c = await getRpc();
    let p2shEntry = null, revealEntries = null;
    { const { entries: p2 } = await c.getUtxosByAddresses([p2shAddress]); if (p2?.length) { p2.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1)); p2shEntry = p2[0]; res.commitId = p2shEntry.outpoint.transactionId; res.reused_commit = true; } }
    if (!p2shEntry) {
      const { entries } = await c.getUtxosByAddresses([payer]);
      if (!entries.length) return { ...res, error: "No UTXOs for payer" };
      entries.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1));
      const { transactions } = await kaspa.createTransactions({ priorityEntries: [], entries: entries.slice(0, 20), outputs: [{ address: p2shAddress, amount: kaspa.kaspaToSompi("1") }], changeAddress: payer, priorityFee: kaspa.kaspaToSompi("0.01"), networkId: NETWORK });
      for (const p of transactions) { p.sign([privateKey]); res.commitId = await p.submit(c); res.committed = true; free(p); }
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const { entries: p2 } = await c.getUtxosByAddresses([p2shAddress]);
        const mine = (p2 || []).find((e) => e.outpoint.transactionId === res.commitId); if (mine) p2shEntry = mine;
        if (p2shEntry) { const { entries: fresh } = await c.getUtxosByAddresses([payer]); const ch = (fresh || []).filter((e) => e.outpoint.transactionId === res.commitId); if (ch.length) { revealEntries = ch; break; } }
        await sleep(2000);
      }
      if (!p2shEntry || !revealEntries) return { ...res, error: p2shEntry ? "commit_change_timeout" : "p2sh_utxo_timeout" };
    } else {
      await sleep(3000);
      const { entries: fresh } = await c.getUtxosByAddresses([payer]); fresh.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1)); revealEntries = fresh.slice(0, 30);
    }
    const { transactions: revealTxs } = await kaspa.createTransactions({ priorityEntries: [p2shEntry], entries: revealEntries, outputs: [{ address: FEE_ADDR, amount: kaspa.kaspaToSompi(String(feeKas)) }], changeAddress: payer, priorityFee: kaspa.kaspaToSompi("0.02"), networkId: NETWORK });
    for (const p of revealTxs) {
      p.sign([privateKey], false);
      const idx = p.transaction.inputs.findIndex((inp) => !inp.signatureScript || inp.signatureScript === "");
      if (idx === -1) return { ...res, error: "No empty signatureScript input for P2SH" };
      const sig = await p.createInputSignature(idx, privateKey);
      p.fillInput(idx, script.encodePayToScriptHashSignatureScript(sig));
      res.revealId = await p.submit(c); free(p);
    }
    fs.writeFileSync(path.join(API_DIR, `smoke-result-${label}.json`), JSON.stringify({ domain, payer, commitId: res.commitId, revealId: res.revealId, inscriptionId: `${res.revealId}i0`, feeKas, p2shAddress, at: now(), run: "r1" }, null, 2) + "\n");
    return { ...res, ok: true };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    if (RL_RE.test(msg)) { try { await rpc?.disconnect(); } catch {} rpc = null; }
    return { ...res, error: msg, rateLimited: RL_RE.test(msg) };
  } finally { free(script, keypair, privateKey); }
}

// ---- replacement names (seeded per wallet; same rules as gen-r1-names.mjs)
function rng(seed) { let h = 1779033703 ^ seed.length; for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; }; }
const END = "abcdefghijklmnopqrstuvwxyz0123456789", MID = END + "-";
function randName(r, len) { for (;;) { let s = END[Math.floor(r() * 36)]; for (let k = 1; k < len - 1; k++) s += MID[Math.floor(r() * 37)]; s += END[Math.floor(r() * 36)]; if (!s.includes("--") && !s.startsWith("stp-")) return s; } }
async function replaceName(i, old) {
  const r = rng(`r1-retake-${i}-${old}`);
  for (let round = 0; round < 10; round++) {
    const cands = []; while (cands.length < 20) { const n = randName(r, old.length); if (!usedNames.has(n) && !cands.includes(n)) cands.push(n); }
    const m = await checkAvail(cands, plan.get(i).address); if (!m) return null;
    const ok = cands.find((n) => m.get(n) === true);
    if (ok) { usedNames.add(ok); overrides.set(i, ok); fs.appendFileSync(OVERRIDES, JSON.stringify({ t: now(), index: i, old, name: ok, length: ok.length, fee: feeFor(ok.length), reason: "taken_by_other" }) + "\n"); return ok; }
  }
  return null;
}

// ---- wallet queue
const claimed = new Set();
function nextWallet() {
  const funded = readJ(FUND, {}).funded_indices || [];
  for (const i of funded) {
    if (i < FROM || i > TO || claimed.has(i) || isDone(i)) continue;
    const f = readJ(`${FAILED}/w${i}`, null);
    if (f && (f.passes >= MAX_FAIL_PASSES || Date.now() - Date.parse(f.t) < FAIL_COOLDOWN_MS)) continue;
    claimed.add(i); return i;
  }
  return null;
}
async function processWallet(lane, i) {
  const k = keys.get(i);
  if (!k || k.address !== plan.get(i).address) { fs.writeFileSync(`${FAILED}/w${i}`, JSON.stringify({ t: now(), passes: 99, error: "key_mismatch" })); emit({ phase: "key_mismatch", wallet: i }); return; }
  let label = currentName(i), final = null, renames = 0;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    while (memAvailMb() < MIN_AVAIL_MB) { st.mem_paused_at = now(); await sleep(15000 + Math.random() * 10000); }
    st.attempts++; st.active[lane] = { wallet: i, label, attempt, since: now() };
    const r = await createName(label, k.hex);
    final = { ...r, wallet: i, attempt, lane };
    if (!r.ok && r.notAvail) {
      const own = await ownerOf(label); const ownerAddr = own?.data?.owner || own?.owner || JSON.stringify(own || {});
      if (String(ownerAddr).includes(k.address)) { final.ok = true; final.note = "already_owned_by_this_wallet"; }
      else if (renames < 5) { const nn = await replaceName(i, label); emit({ phase: "taken_renamed", wallet: i, old: label, name: nn }); if (nn) { renames++; st.taken_renamed++; label = nn; attempt--; st.attempts--; continue; } }
    }
    delete final.payer; delete final.p2shAddress;
    emit({ phase: "attempt", ...final }); record(!!final.ok, final.rateLimited); if (final.rateLimited) st.rate_limited++;
    if (final.ok) break;
    st.attempt_errors++;
    if (attempt < RETRIES) await sleep((final.committed ? 30000 : 8000) * attempt * (final.rateLimited ? 2 : 1));
  }
  delete st.active[lane];
  if (final?.ok) { st.ok++; fs.writeFileSync(`${DONE}/w${i}`, JSON.stringify({ t: now(), index: i, address: k.address, name: label, length: label.length, fee: feeFor(label.length), revealId: final.revealId, commitId: final.commitId, note: final.note || null }) + "\n"); try { fs.unlinkSync(`${FAILED}/w${i}`); } catch {} }
  else { st.failed++; const f = readJ(`${FAILED}/w${i}`, { passes: 0 }); fs.writeFileSync(`${FAILED}/w${i}`, JSON.stringify({ t: now(), passes: f.passes + 1, name: label, error: final?.error || null }) + "\n"); emit({ phase: "wallet_failed", wallet: i, label, passes: f.passes + 1, error: final?.error }); }
}

const allFinished = () => { for (const i of plan.keys()) { if (isDone(i)) continue; const f = readJ(`${FAILED}/w${i}`, null); if (!f || f.passes < MAX_FAIL_PASSES) return false; } return true; };
async function lane(id) {
  st.lanes_running++; emit({ phase: "lane_start", lane: id });
  try {
    for (;;) {
      if (fs.existsSync(STOP)) return;
      if (id > st.lanes_target) return;                                  // scaled down
      if (Date.now() < backoffUntil) { await sleep(20000); continue; }
      const i = nextWallet();
      if (i == null) { await sleep(60000); if (allFinished()) return; continue; }
      try { await processWallet(id, i); } finally { claimed.delete(i); }
      saveState(); await sleep(LANE_DELAY_MS);
    }
  } finally { st.lanes_running--; delete st.active[id]; emit({ phase: "lane_exit", lane: id }); }
}

fs.writeFileSync(`${OUT}/r1-worker.pid`, `${process.pid}\n`);
emit({ phase: "r1_start", pid: process.pid, lanes_target: st.lanes_target, wallets: plan.size, keys: keys.size });
const lanes = new Map();
const ensureLanes = async () => {
  for (let id = 1; id <= st.lanes_target; id++) {
    if (lanes.has(id) || fs.existsSync(STOP)) continue;
    if (memAvailMb() < MIN_AVAIL_MB) break;
    lanes.set(id, lane(id).finally(() => lanes.delete(id)));
    await sleep(3000);                                                    // stagger
  }
};
for (;;) {
  const ceiling = Math.min(20, readN(`${OUT}/r1-max-workers`, 15));
  const w = window30(); const since = Date.now() - lastScale;
  const backlog = (readJ(FUND, {}).funded_indices || []).filter((i) => i >= FROM && i <= TO && !claimed.has(i) && !isDone(i)).length;
  if ((w.attempts >= 20 && w.rate > 0.05) || w.rate_limited >= 3) {
    if (since > 10 * 60000) { const to = Math.max(3, st.lanes_target - 2); st.events.push({ t: now(), phase: "scale_down", from: st.lanes_target, to, ...w }); emit({ phase: "scale_down", from: st.lanes_target, to, ...w }); st.lanes_target = to; lastScale = Date.now(); backoffUntil = Date.now() + 5 * 60000; }
  } else if (w.attempts >= 40 && w.rate < 0.02 && backlog > st.lanes_target && st.lanes_target < ceiling && since > 15 * 60000 && memAvailMb() > 1500) {
    st.events.push({ t: now(), phase: "scale_up", from: st.lanes_target, to: st.lanes_target + 1, ...w }); emit({ phase: "scale_up", from: st.lanes_target, to: st.lanes_target + 1, ...w }); st.lanes_target++; lastScale = Date.now();
  }
  if (st.lanes_target > ceiling) st.lanes_target = ceiling;
  st.events = st.events.slice(-30); st.backlog = backlog;
  await ensureLanes();
  saveState();
  if (fs.existsSync(STOP) && lanes.size === 0) { emit({ phase: "exit", reason: "stop_file" }); break; }
  if (allFinished()) { emit({ phase: "exit", reason: "all_done" }); break; }
  await sleep(30000);
}
try { await rpc?.disconnect(); } catch {}
st.finished_at = now(); saveState();
process.exit(0);
