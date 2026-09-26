#!/usr/bin/env node
/**
 * Phase A pool: stp-snap-w###-d### creates for a wallet range, many wallets concurrently IN ONE PROCESS.
 * Each lane owns a disjoint contiguous wallet sub-range and processes it sequentially (exactly one signer per wallet).
 * Create logic mirrors kns-smoke-create.mjs / kns-snap-create.mjs (commit 1 KAS to P2SH, reveal with 35 KAS fee),
 * incl. resume from a pre-existing P2SH UTXO. Keys are held in memory only, never printed or written.
 *
 * Usage: node kns-snap-pool.mjs --wallet-from 7 --wallet-to 240 --lanes 10 --domain-from 0 --domain-to 99 \
 *          --delay-ms 12000 --broadcast 1 --retries 3
 * Files (snapshot-wallets/): phase-a-pool-<f>-<t>.jsonl, phase-a-status-pool-<f>-<t>.json ; artifacts api/smoke-result-<label>.json
 * SIGTERM/SIGINT: lanes finish their in-flight create, then the process exits.
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
const LANES = Number(arg("--lanes", "8"));
const DF = Number(arg("--domain-from", "0")), DT = Number(arg("--domain-to", "99"));
const DELAY = Number(arg("--delay-ms", "12000"));
const BROADCAST = arg("--broadcast", "1") === "1";
const RETRIES = Number(arg("--retries", "3"));
const ROUNDS = Number(arg("--abort-rounds", "3"));
if (!(WF >= 7) || !(WT >= WF)) { console.error("bad range (must be >= 7)"); process.exit(2); }
if (!BROADCAST) { console.error("pool requires --broadcast 1"); process.exit(2); }

const NET = "testnet-10";
const FEE = "kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru";
const API = "https://api.knsdomains.org/tn10/api/v1";
// KNS_SKIP_INDEXER=1: no per-name indexer calls (our names are deterministic; dedupe = local artifacts + P2SH resume). Ownership verified in one pass after the window.
const SKIP_IDX = process.env.KNS_SKIP_INDEXER === "1";
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const API_DIR = "/workspace/artifacts/kns-tn10/api";
const LOG = path.join(OUT, `phase-a-pool-${WF}-${WT}.jsonl`);
const STATUS = path.join(OUT, `phase-a-status-pool-${WF}-${WT}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const out = (o) => console.log(JSON.stringify({ at: now(), ...o }));
const rec = (o) => { const row = { at: now(), ...o }; fs.appendFileSync(LOG, JSON.stringify(row) + "\n"); console.log(JSON.stringify(row)); };

// keys (memory only)
const meta = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, "utf8"));
const keys = new Map();
for (const l of fs.readFileSync(meta.privkeys_file, "utf8").trim().split("\n")) { const j = JSON.parse(l); if (j.index >= WF && j.index <= WT) keys.set(j.index, j); }
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
const labelFor = (w, d) => `stp-snap-w${String(w).padStart(3, "0")}-d${String(d).padStart(3, "0")}`;
const artifact = (label) => { try { return JSON.parse(fs.readFileSync(path.join(API_DIR, `smoke-result-${label}.json`), "utf8")); } catch { return null; } };

// ---- RPC (shared, auto-reconnect)
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
  try { return { status: r.status, json: JSON.parse(t) }; } catch { return { status: r.status, json: null, nonjson: t.slice(0, 40) }; }
}
async function indexerOwner(label) {
  try {
    const { status, json } = await fetchJson(`${API}/${encodeURIComponent(label + ".kas")}/owner`);
    if (status === 200 && json?.data?.owner) return { registered: true, owner: json.data.owner };
    if (status === 404) return { registered: false };
  } catch {}
  return null;
}

// ---- one create (commit + reveal), mirrors kns-snap-create.mjs
function priceKas(label) { const n = [...label].length; if (n <= 2) return 4200; if (n === 3) return 2100; if (n === 4) return 525; return 35; }
async function createOne(w, label) {
  const k = keys.get(w);
  const privateKey = new kaspa.PrivateKey(k.private_key_hex);
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
  if (!(d0?.available === true && d0?.isReservedDomain === false)) throw new Error("domain_not_available");
  }

  const c = await getRpc();
  const commitLock = kaspa.kaspaToSompi("1"), priorityCommit = kaspa.kaspaToSompi("0.01");
  const feeSompi = kaspa.kaspaToSompi(String(priceKas(label))), priorityReveal = kaspa.kaspaToSompi("0.02");

  let p2shEntry = null, commitId = null, resumed = false;
  const { entries: pre } = await c.getUtxosByAddresses([p2shAddress]);
  if (pre && pre.length) { p2shEntry = pre[0]; commitId = String(p2shEntry.outpoint?.transactionId ?? "") || null; resumed = true; }
  const p2shCountBefore = pre?.length || 0;
  if (!p2shEntry) {
    const { entries } = await c.getUtxosByAddresses([payer]);
    if (!entries.length) throw new Error("no_utxos");
    entries.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1));
    const { transactions } = await createTxFee({ priorityEntries: [], entries: entries.slice(0, 20), outputs: [{ address: p2shAddress, amount: commitLock }], changeAddress: payer, priorityFee: priorityCommit, networkId: NET });
    for (const p of transactions) { p.sign([privateKey]); commitId = await p.submit(c); }
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const { entries: p2 } = await c.getUtxosByAddresses([p2shAddress]);
      if (p2 && p2.length) { p2shEntry = p2[0]; break; }
      await sleep(2000);
    }
    if (!p2shEntry) throw new Error(`p2sh_utxo_timeout commit=${commitId}`);
  }
  const { entries: fresh } = await c.getUtxosByAddresses([payer]);
  fresh.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1));
  const { transactions: revealTxs } = await createTxFee({ priorityEntries: [p2shEntry], entries: fresh.slice(0, 30), outputs: [{ address: FEE, amount: feeSompi }], changeAddress: payer, priorityFee: priorityReveal, networkId: NET });
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
  fs.writeFileSync(path.join(API_DIR, `smoke-result-${label}.json`), JSON.stringify({ domain, payer, commitId, revealId, inscriptionId: `${revealId}i0`, feeKas: priceKas(label), p2shAddress, at: now(), via: "kns-snap-pool" }, null, 2) + "\n");
  // wait until the reveal is accepted (P2SH UTXO consumed) so the next commit never races unconfirmed spends
  const target = (resumed ? p2shCountBefore : 1) - 1;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    try { const { entries: p2 } = await c.getUtxosByAddresses([p2shAddress]); if ((p2?.length || 0) <= target) break; } catch {}
  }
  return { commitId, revealId, resumed };
}

// ---- lanes
let stopping = false;
const summary = { started_at: now(), walletFrom: WF, walletTo: WT, lanes: LANES, ok: 0, failed_attempts: 0, skipped: 0, wallet_aborts: [], inflight: 0 };
const saveStatus = (extra = {}) => { try { fs.writeFileSync(STATUS, JSON.stringify({ ...summary, updated_at: now(), ...extra }, null, 2) + "\n"); } catch {} };
for (const s of ["SIGTERM", "SIGINT"]) process.on(s, () => { if (!stopping) out({ phase: "stop_requested", signal: s, inflight: summary.inflight }); stopping = true; });

async function lane(id, a, b) {
  await sleep(id * 1500);
  for (let w = a; w <= b && !stopping; w++) {
    for (let d = DF; d <= DT && !stopping; d++) {
      const label = labelFor(w, d);
      if (artifact(label)?.revealId) { summary.skipped++; continue; }
      const idx = SKIP_IDX ? null : await indexerOwner(label);
      if (idx?.registered) {
        const mine = idx.owner === keys.get(w).address;
        rec({ phase: mine ? "skip_exists_indexer" : "skip_taken_other", lane: id, wallet: w, domain: d, label, owner: idx.owner });
        summary.skipped++; continue;
      }
      let ok = false, lastErr = null;
      rounds: for (let round = 1; round <= ROUNDS; round++) {
        if (round > 1) { rec({ phase: "wallet_cooldown", lane: id, wallet: w, label, round }); for (let t = 0; t < 60 * (round - 1) && !stopping; t++) await sleep(1000); if (stopping) break; }
        for (let attempt = 1; attempt <= RETRIES; attempt++) {
          const t0 = Date.now();
          summary.inflight++;
          try {
            const r = await createOne(w, label);
            summary.inflight--;
            rec({ phase: "created", ok: true, lane: id, wallet: w, domain: d, label, attempt, round, revealId: r.revealId, commitId: r.commitId, resumed: r.resumed, ms: Date.now() - t0 });
            ok = true; break rounds;
          } catch (e) {
            if (e?.revealUncertain) { rec({ phase: "reveal_uncertain", ok: false, lane: id, wallet: w, label, error: String(e.message).slice(0, 200) }); try { fs.appendFileSync(path.join(API_DIR, "..", "snapshot-wallets", "reveal-uncertain-2026-09-26.jsonl"), JSON.stringify({ at: now(), label, wallet: w, error: String(e.message).slice(0, 200) }) + "\n"); } catch {} summary.reveal_uncertain = (summary.reveal_uncertain || 0) + 1; ok = true; break rounds; }
            summary.inflight--;
            lastErr = String(e?.message || e).slice(0, 200);
            if (rpc && !rpc.isConnected) rpc = null; // shared client dropped: next getRpc() reconnects (never disconnect a live shared client)
            const again = SKIP_IDX ? null : await indexerOwner(label);
            if (again?.registered && again.owner === keys.get(w).address) { rec({ phase: "created", ok: true, lane: id, wallet: w, domain: d, label, attempt, round, note: "registered_per_indexer", ms: Date.now() - t0 }); ok = true; break rounds; }
            summary.failed_attempts++;
            rec({ phase: "attempt_failed", ok: false, lane: id, wallet: w, domain: d, label, attempt, round, error: lastErr, ms: Date.now() - t0 });
            if (stopping) break rounds;
            await sleep(10000 * attempt);
          }
        }
      }
      if (ok) { summary.ok++; saveStatus(); await sleep(DELAY); continue; }
      if (stopping) break;
      summary.wallet_aborts.push({ wallet: w, label, error: lastErr });
      rec({ phase: "wallet_abort", lane: id, wallet: w, label, error: lastErr });
      break; // next wallet
    }
  }
  out({ phase: "lane_done", lane: id, range: `${a}-${b}`, stopping });
}

// split into LANES contiguous ranges with ~equal REMAINING names (fully-done wallets excluded from the weight)
const pend = []; let totalPending = 0;
for (let w = WF; w <= WT; w++) { let p = 0; for (let d = DF; d <= DT; d++) if (!fs.existsSync(path.join(API_DIR, `smoke-result-${labelFor(w, d)}.json`))) p++; pend.push(p); totalPending += p; }
const target = Math.max(1, totalPending / LANES);
const ranges = []; { let a = WF, acc = 0; for (let w = WF; w <= WT; w++) { acc += pend[w - WF]; if ((acc >= target && ranges.length < LANES - 1) || w === WT) { ranges.push([a, w]); a = w + 1; acc = 0; } } }
out({ phase: "lane_split", total_pending: totalPending, per_lane_target: Math.round(target), lanes: ranges.length });
out({ phase: "pool_start", range: `${WF}-${WT}`, lanes: ranges.map((r) => r.join("-")), delayMs: DELAY, retries: RETRIES });
saveStatus({ lane_ranges: ranges.map((r) => r.join("-")) });
const hb = setInterval(() => saveStatus({ lane_ranges: ranges.map((r) => r.join("-")), rss_mb: Math.round(process.memoryUsage().rss / 1048576) }), 30000);
await Promise.all(ranges.map(([a, b], i) => lane(i, a, b)));
clearInterval(hb);
saveStatus({ finished_at: now(), stopped: stopping, rss_mb: Math.round(process.memoryUsage().rss / 1048576) });
out({ phase: stopping ? "pool_stopped" : "pool_done", ...summary });
try { await rpc?.disconnect(); } catch {}
process.exit(0);
