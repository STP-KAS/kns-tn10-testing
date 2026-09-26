#!/usr/bin/env node
/**
 * S3 pool: stp-s3-w{05d}-d{n} creates for wallets >= 700, many wallets concurrently IN ONE PROCESS.
 * 3 names for 700-10699, 2 names for 10700-20699. Each lane owns a disjoint contiguous wallet sub-range (one signer per wallet).
 * Create logic = kns-s3-create.mjs: reuse a stranded P2SH commit for the label; otherwise commit, then reveal spending only
 * the P2SH output + the commit's own change output as seen on the SAME rpc node. Waits for reveal acceptance before the next
 * commit. Keys in memory only; never printed/written.
 * Usage: node kns-s3-pool.mjs --wallet-from 700 --wallet-to 20699 --lanes 10 [--delay-ms 12000] [--retries 3]
 * Files: snapshot-wallets/s3-pool-<f>-<t>.jsonl, s3-status-pool-<f>-<t>.json ; artifacts api/smoke-result-<label>.json
 * SIGTERM/SIGINT: lanes finish the in-flight name, then exit.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

try { fs.writeFileSync("/proc/self/oom_score_adj", "500"); } catch {}
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);

const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d; };
const WF = Number(arg("--wallet-from")), WT = Number(arg("--wallet-to"));
const LANES = Number(arg("--lanes", "10"));
const DELAY = Number(arg("--delay-ms", "12000"));
const RETRIES = Number(arg("--retries", "3"));
const ROUNDS = Number(arg("--abort-rounds", "3"));
const PER_NAME = Number(arg("--min-tkas-per-name", "35.05"));
const MIN_AVAIL_MB = Number(arg("--min-avail-mb", "800"));
if (!(WF >= 700) || !(WT >= WF) || WT > 20699) { console.error("bad range (s3 wallets 700-20699)"); process.exit(2); }
const namesFor = (w) => (w <= 10699 ? 3 : 2);

const NET = "testnet-10";
const FEE = "kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru";
const API = "https://api.knsdomains.org/tn10/api/v1";
// KNS_SKIP_INDEXER=1: no per-name indexer calls (our names are deterministic; dedupe = local artifacts + P2SH resume). Ownership verified in one pass after the window.
const SKIP_IDX = process.env.KNS_SKIP_INDEXER === "1";
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const API_DIR = "/workspace/artifacts/kns-tn10/api";
const LOG = path.join(OUT, `s3-pool-${WF}-${WT}.jsonl`);
const STATUS = path.join(OUT, `s3-status-pool-${WF}-${WT}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const out = (o) => console.log(JSON.stringify({ at: now(), ...o }));
const rec = (o) => { const row = { at: now(), ...o }; fs.appendFileSync(LOG, JSON.stringify(row) + "\n"); console.log(JSON.stringify(row)); };
const memAvailMb = () => { try { return Number(fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)[1]) / 1024; } catch { return 1e9; } };

// keys (memory only; parse only lines in range)
const meta = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, "utf8"));
const keys = new Map();
for (const l of fs.readFileSync(meta.privkeys_file, "utf8").split("\n")) {
  if (!l) continue; const m = l.match(/^\{"index":(\d+),/);
  if (m && (+m[1] < WF || +m[1] > WT)) continue;
  const j = JSON.parse(l); if (j.index >= WF && j.index <= WT) keys.set(j.index, { address: j.address, hex: j.private_key_hex });
}
for (let w = WF; w <= WT; w++) if (!keys.has(w)) { console.error(`missing key for wallet ${w}`); process.exit(2); }

// KNS_FEE_MULT (default 1): scale the TOTAL tx fee (priority + network) by this factor; KNS service fee outputs unchanged.
// Build once to learn the network part, then rebuild with priorityFee = M*priority + (M-1)*network.
const FEE_MULT = Math.max(1, Math.round(Number(process.env.KNS_FEE_MULT || "1")));
async function createTxFee(opts) {
  const first = await kaspa.createTransactions(opts);
  if (FEE_MULT === 1) return first;
  const base = BigInt(opts.priorityFee ?? 0n);
  const net = BigInt(first.summary.fees) - base;
  return kaspa.createTransactions({ ...opts, priorityFee: base * BigInt(FEE_MULT) + (net > 0n ? net : 0n) * BigInt(FEE_MULT - 1) });
}
const labelFor = (w, d) => `stp-s3-w${String(w).padStart(5, "0")}-d${d}`;
const artifact = (label) => { try { return JSON.parse(fs.readFileSync(path.join(API_DIR, `smoke-result-${label}.json`), "utf8")); } catch { return null; } };

let rpc = null, rpcConnecting = null;
async function getRpc() {
  if (rpc && rpc.isConnected) return rpc;
  if (rpcConnecting) return rpcConnecting;
  rpcConnecting = (async () => {
    let c;
    try {
      const url = await new kaspa.Resolver().getUrl(kaspa.Encoding.Borsh, NET);
      c = new kaspa.RpcClient({ url, encoding: kaspa.Encoding.Borsh, networkId: NET });
      await c.connect({ timeoutDuration: 10000 });
    } catch {
      c = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: NET });
      await c.connect();
    }
    const info = await c.getServerInfo();
    if (!info.isSynced) throw new Error("rpc_not_synced");
    out({ phase: "rpc_connected", url: c.url });
    rpc = c; return c;
  })();
  try { return await rpcConnecting; } finally { rpcConnecting = null; }
}
async function fetchJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  const t = await r.text();
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: null }; }
}
async function indexerOwner(label) {
  try {
    const { status, json } = await fetchJson(`${API}/${encodeURIComponent(label + ".kas")}/owner`);
    if (status === 200 && json?.data?.owner) return { registered: true, owner: json.data.owner };
    if (status === 404) return { registered: false };
  } catch {}
  return null;
}

class Unavailable extends Error {}
async function createOne(w, label) {
  const k = keys.get(w);
  const privateKey = new kaspa.PrivateKey(k.hex);
  const keypair = privateKey.toKeypair();
  const payer = keypair.toAddress(NET).toString();
  if (payer !== k.address) throw new Error("key_address_mismatch");
  const domain = `${label}.kas`;
  const payload = JSON.stringify({ op: "create", p: "domain", v: label });
  const script = new kaspa.ScriptBuilder()
    .addData(keypair.xOnlyPublicKey).addOp(kaspa.Opcodes.OpCheckSig)
    .addOp(kaspa.Opcodes.OpFalse).addOp(kaspa.Opcodes.OpIf)
    .addData(Buffer.from("kns")).addI64(0n).addData(Buffer.from(payload)).addOp(kaspa.Opcodes.OpEndIf);
  const p2shAddress = kaspa.addressFromScriptPublicKey(script.createPayToScriptHashScript(), NET).toString();

  if (!SKIP_IDX) {
  const chk = await fetchJson(`${API}/domains/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domainNames: [domain], address: payer }) });
  if (!chk.json) throw new Error(`indexer_check_nonjson_http_${chk.status}`);
  const d0 = chk.json?.data?.domains?.[0];
  if (!(d0?.available === true && d0?.isReservedDomain === false)) throw new Unavailable("domain_not_available");
  }

  const c = await getRpc();
  const commitLock = kaspa.kaspaToSompi("1"), priorityCommit = kaspa.kaspaToSompi("0.01");
  const feeSompi = kaspa.kaspaToSompi("35"), priorityReveal = kaspa.kaspaToSompi("0.02");

  let p2shEntry = null, commitId = null, revealEntries = null, reused = false;
  const { entries: pre } = await c.getUtxosByAddresses([p2shAddress]);
  if (pre && pre.length) {
    pre.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1));
    p2shEntry = pre[0]; commitId = p2shEntry.outpoint.transactionId; reused = true;
    await sleep(3000);
    const { entries: fresh } = await c.getUtxosByAddresses([payer]);
    fresh.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1));
    revealEntries = fresh.slice(0, 30);
  } else {
    const { entries } = await c.getUtxosByAddresses([payer]);
    if (!entries.length) throw new Error("no_utxos");
    entries.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1));
    const { transactions } = await createTxFee({ priorityEntries: [], entries: entries.slice(0, 20), outputs: [{ address: p2shAddress, amount: commitLock }], changeAddress: payer, priorityFee: priorityCommit, networkId: NET });
    for (const p of transactions) { p.sign([privateKey]); commitId = await p.submit(c); }
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const { entries: p2 } = await c.getUtxosByAddresses([p2shAddress]);
      const mine = (p2 || []).find((e) => e.outpoint.transactionId === commitId);
      if (mine) p2shEntry = mine;
      if (p2shEntry) {
        const { entries: fresh } = await c.getUtxosByAddresses([payer]);
        const change = (fresh || []).filter((e) => e.outpoint.transactionId === commitId);
        if (change.length) { revealEntries = change; break; }
      }
      await sleep(1500);
    }
    if (!p2shEntry || !revealEntries) throw new Error(`${p2shEntry ? "commit_change_timeout" : "p2sh_utxo_timeout"} commit=${commitId}`);
  }
  const { transactions: revealTxs } = await createTxFee({ priorityEntries: [p2shEntry], entries: revealEntries, outputs: [{ address: FEE, amount: feeSompi }], changeAddress: payer, priorityFee: priorityReveal, networkId: NET });
  let revealId;
  for (const p of revealTxs) {
    p.sign([privateKey], false);
    const idx = p.transaction.inputs.findIndex((i) => !i.signatureScript || i.signatureScript === "");
    if (idx === -1) throw new Error("no_empty_sig_input");
    const sig = await p.createInputSignature(idx, privateKey);
    p.fillInput(idx, script.encodePayToScriptHashSignatureScript(sig));
    try { revealId = await p.submit(c); }
    catch (e) {
      const m = String(e?.message || e);
      if (/Rejected transaction/i.test(m)) throw e; // definitively rejected: safe to retry (P2SH commit gets reused)
      const u = new Error(`reveal_uncertain commit=${commitId} ${m.slice(0, 120)}`); u.revealUncertain = true; throw u;
    }
  }
  fs.writeFileSync(path.join(API_DIR, `smoke-result-${label}.json`), JSON.stringify({ domain, payer, commitId, revealId, inscriptionId: `${revealId}i0`, feeKas: 35, p2shAddress, at: now(), via: "kns-s3-pool" }, null, 2) + "\n");
  // wait until the reveal is accepted (spent P2SH outpoint gone, reveal change visible) before this wallet's next commit
  const op = p2shEntry.outpoint;
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    try {
      const { entries: p2 } = await c.getUtxosByAddresses([p2shAddress]);
      if (!(p2 || []).some((e) => e.outpoint.transactionId === op.transactionId && e.outpoint.index === op.index)) break;
    } catch {}
  }
  return { commitId, revealId, reused };
}

let stopping = false;
const summary = { started_at: now(), walletFrom: WF, walletTo: WT, lanes: LANES, ok: 0, already_owned: 0, taken_other: 0, failed_attempts: 0, skipped: 0, wallets_done: 0, wallet_aborts: [], unfunded_deferred: 0 };
const saveStatus = (extra = {}) => { try { fs.writeFileSync(STATUS, JSON.stringify({ ...summary, updated_at: now(), rss_mb: Math.round(process.memoryUsage().rss / 1048576), ...extra }, null, 2) + "\n"); } catch {} };
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { if (!stopping) out({ phase: "stop_requested", signal: s }); stopping = true; });

async function balanceOf(addr) { try { const c = await getRpc(); const r = await c.getBalancesByAddresses([addr]); return Number(BigInt(r.entries[0]?.balance ?? 0)) / 1e8; } catch { if (rpc && !rpc.isConnected) rpc = null; return null; } }

async function doWallet(id, w) {
  const labels = Array.from({ length: namesFor(w) }, (_, d) => labelFor(w, d));
  const pending = labels.filter((l) => !artifact(l)?.revealId);
  summary.skipped += labels.length - pending.length;
  if (!pending.length) { summary.wallets_done++; return "done"; }
  const bal = await balanceOf(keys.get(w).address);
  if (bal == null) return "retry";
  if (bal < pending.length * PER_NAME + 0.5) {
    // maybe names exist on the indexer without artifacts: check before deferring
    let owned = 0; for (const l of pending) { const o = await indexerOwner(l); if (o?.registered) owned++; }
    if (owned < pending.length) { summary.unfunded_deferred++; rec({ phase: "unfunded_deferred", lane: id, wallet: w, balance: bal, need: pending.length * PER_NAME + 0.5 }); return "unfunded"; }
  }
  for (const label of pending) {
    if (stopping) return "stopped";
    while (memAvailMb() < MIN_AVAIL_MB && !stopping) { out({ phase: "mem_wait", lane: id, avail_mb: Math.round(memAvailMb()) }); await sleep(20000); }
    let ok = false, lastErr = null;
    rounds: for (let round = 1; round <= ROUNDS; round++) {
      if (round > 1) { rec({ phase: "wallet_cooldown", lane: id, wallet: w, label, round }); for (let t = 0; t < 60 * (round - 1) && !stopping; t++) await sleep(1000); if (stopping) break; }
      for (let attempt = 1; attempt <= RETRIES; attempt++) {
        const t0 = Date.now();
        try {
          const r = await createOne(w, label);
          rec({ phase: "created", ok: true, lane: id, wallet: w, label, attempt, round, revealId: r.revealId, commitId: r.commitId, reused: r.reused, ms: Date.now() - t0 });
          summary.ok++; ok = true; break rounds;
        } catch (e) {
            if (e?.revealUncertain) { rec({ phase: "reveal_uncertain", ok: false, lane: id, wallet: w, label, error: String(e.message).slice(0, 200) }); try { fs.appendFileSync(path.join(API_DIR, "..", "snapshot-wallets", "reveal-uncertain-2026-09-26.jsonl"), JSON.stringify({ at: now(), label, wallet: w, error: String(e.message).slice(0, 200) }) + "\n"); } catch {} summary.reveal_uncertain = (summary.reveal_uncertain || 0) + 1; ok = true; break rounds; }
          if (rpc && !rpc.isConnected) rpc = null;
          if (e instanceof Unavailable) {
            const o = await indexerOwner(label);
            if (o?.registered && o.owner === keys.get(w).address) { rec({ phase: "already_owned", ok: true, lane: id, wallet: w, label }); summary.already_owned++; ok = true; break rounds; }
            if (o?.registered) { rec({ phase: "taken_other", lane: id, wallet: w, label, owner: o.owner }); summary.taken_other++; ok = true; break rounds; }
          }
          lastErr = String(e?.message || e).slice(0, 200);
          summary.failed_attempts++;
          rec({ phase: "attempt_failed", ok: false, lane: id, wallet: w, label, attempt, round, error: lastErr, ms: Date.now() - t0 });
          if (stopping) break rounds;
          await sleep((/commit=/.test(lastErr) ? 30000 : 10000) * attempt);
        }
      }
    }
    if (!ok) { if (stopping) return "stopped"; summary.wallet_aborts.push({ wallet: w, label, error: lastErr }); rec({ phase: "wallet_abort", lane: id, wallet: w, label, error: lastErr }); return "aborted"; }
    saveStatus();
    await sleep(DELAY);
  }
  summary.wallets_done++;
  return "done";
}

async function lane(id, a, b) {
  await sleep(id * 1500);
  let todo = []; for (let w = a; w <= b; w++) todo.push(w);
  for (let pass = 1; todo.length && !stopping && pass <= 50; pass++) {
    const next = [];
    for (const w of todo) {
      if (stopping) break;
      const r = await doWallet(id, w);
      if (r === "unfunded" || r === "retry") next.push(w);
    }
    todo = next;
    if (todo.length && !stopping) { out({ phase: "lane_repass", lane: id, deferred: todo.length, pass }); for (let t = 0; t < 120 && !stopping; t++) await sleep(1000); }
  }
  out({ phase: "lane_done", lane: id, range: `${a}-${b}`, stopping, deferred_left: todo.length });
}

// split into LANES contiguous ranges with ~equal REMAINING names (3-name vs 2-name tiers, already-created names excluded)
const pendingOf = (w) => { let p = 0; for (let d = 0; d < namesFor(w); d++) if (!fs.existsSync(path.join(API_DIR, `smoke-result-${labelFor(w, d)}.json`))) p++; return p; };
const pend = []; let totalPending = 0; for (let w = WF; w <= WT; w++) { const p = pendingOf(w); pend.push(p); totalPending += p; }
const target = Math.max(1, totalPending / LANES);
const ranges = []; { let a = WF, acc = 0; for (let w = WF; w <= WT; w++) { acc += pend[w - WF]; if ((acc >= target && ranges.length < LANES - 1) || w === WT) { ranges.push([a, w]); a = w + 1; acc = 0; } } }
out({ phase: "lane_split", total_pending: totalPending, per_lane_target: Math.round(target) });
out({ phase: "pool_start", range: `${WF}-${WT}`, lanes: ranges.map((r) => r.join("-")) });
saveStatus({ lane_ranges: ranges.map((r) => r.join("-")) });
const hb = setInterval(() => saveStatus({ lane_ranges: ranges.map((r) => r.join("-")) }), 30000);
await Promise.all(ranges.map(([a, b], i) => lane(i, a, b)));
clearInterval(hb);
saveStatus({ finished_at: now(), stopped: stopping });
out({ phase: stopping ? "pool_stopped" : "pool_done", ...summary, wallet_aborts: summary.wallet_aborts.length });
try { await rpc?.disconnect(); } catch {}
process.exit(0);
