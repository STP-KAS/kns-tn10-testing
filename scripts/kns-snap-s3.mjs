#!/usr/bin/env node
/**
 * S3: create N KNS names per snapshot wallet, pattern stp-s3-w{index:05d}-d{0..N-1} (TN10 only).
 * Uses kns-s3-create.mjs (copy of kns-smoke-create.mjs + robustness fixes), one child per name.
 * Waits for each wallet to be funded (balance check) before starting it. Skips labels that already have smoke-result artifacts.
 * Never touches wallets < 700, stp-bulk-* or stp-snap-* names. NEVER prints private keys.
 *
 * Usage: node kns-snap-s3.mjs --wallet-from 700 --wallet-to 1199 [--names 3] [--delay-ms 12000] [--retries 3] [--min-tkas-per-name 35.05]
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);

try { fs.writeFileSync("/proc/self/oom_score_adj", "900"); } catch {} // yield to kaspad/miner farm under memory pressure (inherited by children)
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d; };
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const API_DIR = "/workspace/artifacts/kns-tn10/api";
const KNS_API = "https://api.knsdomains.org/tn10/api/v1";
const SMOKE = "/workspace/artifacts/kns-tn10/scripts/kns-s3-create.mjs"; // robust copy of kns-smoke-create.mjs (reuses stranded commits, same-node reveal inputs)
const TMP = `${process.env.KNS_TN10_SNAPSHOT_SECRETS_DIR ?? (() => { throw new Error("set KNS_TN10_SNAPSHOT_SECRETS_DIR (env only, never commit)"); })()}/tmp`;
const walletFrom = Number(arg("--wallet-from", "700"));
const walletTo = Number(arg("--wallet-to", String(walletFrom)));
const NAMES = Number(arg("--names", "3"));
const delayMs = Number(arg("--delay-ms", "12000"));
const retries = Number(arg("--retries", "3"));
const perName = Number(arg("--min-tkas-per-name", "35.05"));
const TAG = `${walletFrom}-${walletTo}`;
const logPath = path.join(OUT, `s3-${TAG}.jsonl`);
const statusPath = path.join(OUT, `s3-status-${TAG}.json`);
if (walletFrom < 700 || walletTo < walletFrom) { console.error("refusing: s3 wallets are >= 700"); process.exit(2); }

const meta = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, "utf8"));
const byIndex = new Map();
for (const l of fs.readFileSync(meta.privkeys_file, "utf8").split("\n")) {
  if (!l) continue;
  const m = l.match(/^\{"index":(\d+),/);
  if (m && (+m[1] < walletFrom || +m[1] > walletTo)) continue;
  const j = JSON.parse(l);
  if (j.index >= walletFrom && j.index <= walletTo) byIndex.set(j.index, j);
}
fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });

const labelFor = (w, d) => `stp-s3-w${String(w).padStart(5, "0")}-d${d}`;
const artifact = (label) => { try { return JSON.parse(fs.readFileSync(path.join(API_DIR, `smoke-result-${label}.json`), "utf8")); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
// memory throttle: never spawn a create child while the box is short on memory (protects the TN10 miner farm)
const MIN_AVAIL_MB = Number(arg("--min-avail-mb", "800"));
const memAvailMb = () => { try { return Number(fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)[1]) / 1024; } catch { return 1e9; } };
async function waitForMemory(label) {
  let n = 0;
  while (memAvailMb() < MIN_AVAIL_MB) { if (n++ % 10 === 0) console.log(JSON.stringify({ t: now(), phase: "mem_wait", label, avail_mb: Math.round(memAvailMb()) })); await sleep(20000 + Math.random() * 10000); }
}
const emit = (o) => { const row = { t: now(), ...o }; fs.appendFileSync(logPath, JSON.stringify(row) + "\n"); console.log(JSON.stringify(row)); };

let rpc = null;
async function getBalance(addr) {
  for (let a = 0; a < 5; a++) {
    try {
      if (!rpc) { rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: "testnet-10" }); await rpc.connect(); }
      const r = await rpc.getBalancesByAddresses([addr]);
      return Number(BigInt(r.entries[0]?.balance ?? 0)) / 1e8;
    } catch (e) { try { await rpc?.disconnect(); } catch {} rpc = null; await sleep(5000 * (a + 1)); }
  }
  return null;
}
async function ownerOf(label) {
  try { const r = await fetch(`${KNS_API}/${encodeURIComponent(label + ".kas")}/owner`); if (r.status !== 200) return null; return await r.json(); } catch { return null; }
}

function runOne(label, privFile) {
  return new Promise((resolve) => {
    const childLog = path.join(API_DIR, `snap-child-${label}.log`);
    const out = fs.createWriteStream(childLog, { flags: "a" });
    const child = spawn(process.execPath, [SMOKE, "--label", label, "--broadcast", "1"], { cwd: "/workspace/artifacts/kns-tn10", env: { ...process.env, BACKUP_PRIVKEY_FILE: privFile } });
    let buf = "";
    const kill = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, 8 * 60000);
    child.stdout.on("data", (d) => { buf += d; out.write(d); });
    child.stderr.on("data", (d) => { buf += d; out.write(d); });
    child.on("close", (code) => {
      clearTimeout(kill); out.end();
      let last = {};
      for (const line of buf.trim().split("\n").reverse()) { try { const j = JSON.parse(line); last = j; if (j.phase === "done" || j.revealId) break; } catch {} }
      const art = artifact(label);
      const ok = !!(art?.revealId || last.revealId || last.phase === "done");
      const notAvail = !ok && (code === 4 || /Domain not available/.test(buf));
      const errLine = (buf.match(/(RpcError|Error|error)[^\n]{0,240}/) || [])[0] || null;
      const committed = /"phase":\s*"commit"/.test(buf);
      resolve({ label, code, ok, notAvail, committed, revealId: art?.revealId || last.revealId || null, commitId: art?.commitId || last.commitId || null, error: ok ? null : (last.error || errLine) });
    });
  });
}

const summary = { started_at: now(), walletFrom, walletTo, names_per_wallet: NAMES, delayMs, retries, ok: 0, failed: 0, skipped: 0, taken: 0, attempts: 0, attempt_errors: 0, wallets_done: 0, wallets_aborted: 0, current_wallet: null, waiting_funds: false };
const saveStatus = (extra = {}) => fs.writeFileSync(statusPath, JSON.stringify({ ...summary, ...extra, updated_at: now() }, null, 2) + "\n");
emit({ phase: "s3_start", range: TAG, pid: process.pid });
saveStatus();

let consecutiveAborts = 0;
for (let w = walletFrom; w <= walletTo; w++) {
  const rec = byIndex.get(w);
  if (!rec) { emit({ phase: "missing_wallet", wallet: w }); continue; }
  summary.current_wallet = w;
  const labels = Array.from({ length: NAMES }, (_, d) => labelFor(w, d));
  const pending = labels.filter((l) => { if (artifact(l)?.revealId) { summary.skipped++; return false; } return true; });
  if (!pending.length) { summary.wallets_done++; saveStatus(); continue; }
  // wait for funding
  const need = pending.length * perName + 0.5;
  let waited = 0;
  for (;;) {
    const bal = await getBalance(rec.address);
    if (bal != null && bal >= need) break;
    if (waited % 10 === 0) emit({ phase: "waiting_funds", wallet: w, balance: bal, need });
    summary.waiting_funds = true; saveStatus();
    waited++; await sleep(60000);
  }
  summary.waiting_funds = false;
  const privFile = path.join(TMP, `s3-w${String(w).padStart(5, "0")}.hex`);
  fs.writeFileSync(privFile, rec.private_key_hex + "\n", { mode: 0o600 }); fs.chmodSync(privFile, 0o600);
  let walletOk = true;
  for (const label of pending) {
    let final = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
      await waitForMemory(label);
      summary.attempts++;
      const r = await runOne(label, privFile);
      final = { ...r, wallet: w, attempt };
      if (!r.ok && r.notAvail) {
        const own = await ownerOf(label);
        const ownerAddr = own?.data?.owner || own?.owner || JSON.stringify(own || {});
        if (String(ownerAddr).includes(rec.address)) { final.ok = true; final.note = "already_owned_by_this_wallet"; }
        else { final.note = "taken_by_other"; }
      }
      emit({ phase: "attempt", ...final });
      if (final.ok || final.note === "taken_by_other") break;
      summary.attempt_errors++;
      // if a commit went out, give the UTXO index/mempool time to settle before re-trying (avoids "already spent" races)
      if (attempt < retries) await sleep((final.committed ? 30000 : 5000) * attempt);
    }
    if (final.ok) summary.ok++;
    else if (final.note === "taken_by_other") summary.taken++;
    else { summary.failed++; walletOk = false; emit({ phase: "wallet_abort", wallet: w, label, error: final.error }); break; }
    saveStatus();
    await sleep(delayMs);
  }
  try { fs.unlinkSync(privFile); } catch {}
  if (walletOk) { summary.wallets_done++; consecutiveAborts = 0; }
  else {
    summary.wallets_aborted++; consecutiveAborts++;
    if (consecutiveAborts >= 3) { emit({ phase: "backoff", reason: "3_consecutive_wallet_aborts", sleep_s: 300 }); saveStatus({ backoff: true }); await sleep(300000); consecutiveAborts = 0; }
  }
  saveStatus();
}
summary.current_wallet = null;
summary.finished_at = now();
saveStatus();
emit({ phase: "s3_done", ...summary });
try { await rpc?.disconnect(); } catch {}
process.exit(0);
