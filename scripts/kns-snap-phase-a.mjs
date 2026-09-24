#!/usr/bin/env node
/**
 * Phase A: stp-snap-w###-d### creates across snapshot wallets.
 * Skips labels that already have smoke-result artifacts with revealId.
 * Does not touch stp-bulk-* chain.
 *
 * Usage:
 *   node kns-snap-phase-a.mjs --wallet-from 0 --wallet-to 6 --domain-from 0 --domain-to 99 \
 *     --delay-ms 12000 --broadcast 1 --retries 3
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const API_DIR = "/workspace/artifacts/kns-tn10/api";
const smoke = process.argv.includes("--fast-connect") && process.argv[process.argv.indexOf("--fast-connect") + 1] === "1"
  ? "/workspace/artifacts/kns-tn10/scripts/kns-snap-create.mjs"
  : "/workspace/artifacts/kns-tn10/scripts/kns-smoke-create.mjs";
const meta = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, "utf8"));
const privLines = fs.readFileSync(meta.privkeys_file, "utf8").trim().split("\n");
const byIndex = new Map(privLines.map((l) => {
  const j = JSON.parse(l);
  return [j.index, j];
}));

const walletFrom = Number(arg("--wallet-from", "0"));
const walletTo = Number(arg("--wallet-to", "6"));
const domainFrom = Number(arg("--domain-from", "0"));
const domainTo = Number(arg("--domain-to", "99"));
const delayMs = Number(arg("--delay-ms", "12000"));
const broadcast = arg("--broadcast", "1");
const retries = Number(arg("--retries", "3"));
// Output paths: defaults stay compatible with the original 0-6 job (phase-a-status.json);
// any other wallet range gets range-suffixed status file. Override with --log-path / --status-path.
const logPath = arg("--log-path", path.join(OUT, `phase-a-${walletFrom}-${walletTo}.jsonl`));
const statusPath = arg(
  "--status-path",
  path.join(OUT, walletFrom === 0 && walletTo === 6 ? `phase-a-status.json` : `phase-a-status-${walletFrom}-${walletTo}.json`)
);
if (!(walletFrom === 0 && walletTo === 6) && (path.basename(statusPath) === "phase-a-status.json" || path.basename(logPath) === "phase-a-0-6.jsonl")) {
  console.error("refusing to write to the 0-6 job's files"); process.exit(2);
}

fs.mkdirSync(`${process.env.KNS_TN10_SNAPSHOT_SECRETS_DIR ?? (() => { throw new Error("set KNS_TN10_SNAPSHOT_SECRETS_DIR (env only, never commit)"); })()}/tmp`, {
  recursive: true,
  mode: 0o700,
});
fs.mkdirSync(API_DIR, { recursive: true });

function labelFor(w, d) {
  return `stp-snap-w${String(w).padStart(3, "0")}-d${String(d).padStart(3, "0")}`;
}

const API = "https://api.knsdomains.org/tn10/api/v1";
// Returns {registered:true, owner} | {registered:false} | null (unknown / indexer error)
async function indexerOwner(label) {
  try {
    const ctl = AbortSignal.timeout(15000);
    const r = await fetch(`${API}/${encodeURIComponent(label + ".kas")}/owner`, { signal: ctl });
    if (r.status === 200) {
      const j = await r.json();
      const owner = j?.data?.owner ?? null;
      return owner ? { registered: true, owner } : null;
    }
    if (r.status === 404) return { registered: false };
    return null;
  } catch {
    return null;
  }
}

// Graceful stop: SIGTERM/SIGINT finishes the in-flight create (commit+reveal) then exits.
let stopping = false;
let inFlight = false;
function writeStatusAndExit(reason) {
  try {
    fs.writeFileSync(statusPath, JSON.stringify({ ...summary, stopped_at: new Date().toISOString(), stop_reason: reason }, null, 2) + "\n");
  } catch {}
  console.log(JSON.stringify({ phase: "stopped", reason, at: new Date().toISOString() }));
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    stopping = true;
    console.log(JSON.stringify({ phase: "stop_requested", signal: sig, inFlight, at: new Date().toISOString() }));
    if (!inFlight) writeStatusAndExit(sig);
  });
}

function artifact(label) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(API_DIR, `smoke-result-${label}.json`), "utf8")
    );
  } catch {
    return null;
  }
}

function ensurePrivFile(w) {
  const rec = byIndex.get(w);
  if (!rec) throw new Error(`missing wallet ${w}`);
  const p = `${process.env.KNS_TN10_SNAPSHOT_SECRETS_DIR ?? (() => { throw new Error("set KNS_TN10_SNAPSHOT_SECRETS_DIR (env only, never commit)"); })()}/tmp/w${String(w).padStart(3, "0")}.hex`;
  fs.writeFileSync(p, rec.private_key_hex + "\n", { mode: 0o600 });
  fs.chmodSync(p, 0o600);
  return { path: p, address: rec.address };
}

function runOne(label, privFile) {
  return new Promise((resolve) => {
    const childLog = path.join(API_DIR, `snap-child-${label}.log`);
    const out = fs.createWriteStream(childLog, { flags: "a" }); // keep earlier attempts for diagnosis
    out.write(`\n--- attempt start ${new Date().toISOString()}\n`);
    const child = spawn(
      process.execPath,
      [smoke, "--label", label, "--broadcast", broadcast],
      {
        cwd: "/workspace/artifacts/kns-tn10",
        env: { ...process.env, BACKUP_PRIVKEY_FILE: privFile },
      }
    );
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      out.write(d);
    });
    child.stderr.on("data", (d) => {
      buf += d;
      out.write(d);
    });
    child.on("close", (code) => {
      out.end();
      let last = {};
      for (const line of buf.trim().split("\n").reverse()) {
        try {
          const j = JSON.parse(line);
          last = j;
          if (j.phase === "done" || j.revealId) break;
        } catch {}
      }
      const art = artifact(label);
      const ok = !!(art?.revealId || last.revealId || last.phase === "done");
      resolve({
        label,
        code: ok ? 0 : code,
        ok,
        revealId: art?.revealId || last.revealId || null,
        commitId: art?.commitId || last.commitId || null,
        childLog,
        error: ok ? null : last.error || last.message || null,
      });
    });
  });
}

const summary = {
  started_at: new Date().toISOString(),
  walletFrom,
  walletTo,
  domainFrom,
  domainTo,
  delayMs,
  broadcast,
  ok: 0,
  failed: 0,
  skipped: 0,
  last: null,
};

console.log(JSON.stringify({ phase: "phase_a_start", ...summary, privkeys: undefined }));

outer: for (let w = walletFrom; w <= walletTo; w++) {
  const { path: privFile, address } = ensurePrivFile(w);
  for (let d = domainFrom; d <= domainTo; d++) {
    const label = labelFor(w, d);
    const existing = artifact(label);
    if (existing?.revealId) {
      summary.skipped += 1;
      const row = {
        phase: "skip_exists",
        wallet: w,
        domain: d,
        label,
        revealId: existing.revealId,
        at: new Date().toISOString(),
      };
      fs.appendFileSync(logPath, JSON.stringify(row) + "\n");
      console.log(JSON.stringify(row));
      summary.last = row;
      continue;
    }
    // Resume safety: name may already be registered (e.g. artifact lost). Skip instead of failing the wallet.
    const idx = await indexerOwner(label);
    if (idx?.registered) {
      const mine = idx.owner === address;
      const row = { phase: mine ? "skip_exists_indexer" : "skip_taken_other", wallet: w, domain: d, label, owner: idx.owner, at: new Date().toISOString() };
      if (mine) summary.skipped += 1; else summary.taken_other = (summary.taken_other || 0) + 1;
      fs.appendFileSync(logPath, JSON.stringify(row) + "\n");
      console.log(JSON.stringify(row));
      summary.last = row;
      if (stopping) writeStatusAndExit("signal");
      continue;
    }
    let final = null;
    // transient indexer/RPC blips: up to 3 rounds of `retries` attempts, with growing backoff and a cooldown between rounds
    const rounds = Number(arg("--abort-rounds", "3"));
    roundLoop: for (let round = 1; round <= rounds; round++) {
    if (round > 1) {
      const cool = 60000 * (round - 1);
      console.log(JSON.stringify({ phase: "wallet_cooldown", wallet: w, label, round, ms: cool, at: new Date().toISOString() }));
      await new Promise((res) => setTimeout(res, cool));
      if (stopping) writeStatusAndExit("signal");
    }
    for (let attempt = 1; attempt <= retries; attempt++) {
      console.log(
        JSON.stringify({
          phase: "start",
          wallet: w,
          domain: d,
          label,
          attempt,
          payer: address,
        })
      );
      inFlight = true;
      let r = await runOne(label, privFile);
      inFlight = false;
      if (!r.ok) {
        // a failed attempt may still have registered the name (e.g. indexer poll / exit after reveal)
        const again = await indexerOwner(label);
        if (again?.registered && again.owner === address) r = { ...r, ok: true, code: 0, note: "registered_per_indexer" };
      }
      final = { ...r, wallet: w, domain: d, attempt, round, at: new Date().toISOString() };
      fs.appendFileSync(logPath, JSON.stringify(final) + "\n");
      console.log(
        JSON.stringify({
          phase: "attempt_done",
          label,
          attempt,
          ok: r.ok,
          revealId: r.revealId,
          error: r.error,
        })
      );
      if (r.ok) break roundLoop;
      if (stopping) break roundLoop;
      if (attempt < retries) await new Promise((res) => setTimeout(res, 10000 * attempt));
    }
    }
    if (final?.ok) summary.ok += 1;
    else if (stopping) writeStatusAndExit("signal");
    else {
      summary.failed += 1;
      summary.last = final;
      // stop this wallet on persistent failure (likely funds)
      console.log(
        JSON.stringify({
          phase: "wallet_abort",
          wallet: w,
          label,
          error: final?.error,
        })
      );
      fs.writeFileSync(statusPath, JSON.stringify({ ...summary, finished_at: new Date().toISOString() }, null, 2) + "\n");
      // continue other wallets
      break;
    }
    summary.last = final;
    fs.writeFileSync(
      statusPath,
      JSON.stringify({ ...summary, updated_at: new Date().toISOString() }, null, 2) + "\n"
    );
    if (stopping) writeStatusAndExit("signal");
    await new Promise((res) => setTimeout(res, delayMs));
  }
}

summary.finished_at = new Date().toISOString();
fs.writeFileSync(statusPath, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ phase: "phase_a_done", ...summary }));
