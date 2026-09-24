#!/usr/bin/env node
/**
 * Fund snapshot wallets via sixpack.wtf faucet HTTP API (no captcha).
 * Cap: 30_000 tKAS per IP and per address per 24h; drip default 30_000.
 *
 * Usage:
 *   node faucet-fund-snapshot.mjs [--from 0] [--to 4] [--amount 150] [--delay-ms 2500]
 */
import fs from "node:fs";
import path from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

const API =
  process.env.FAUCET_API ||
  (() => { throw new Error("set FAUCET_API (env only, never commit)"); })();
const outDir = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const addressesCsv = path.join(outDir, "addresses.csv");
const logPath = path.join(outDir, "faucet-fund-log.jsonl");
const statusPath = path.join(outDir, "faucet-fund-status.json");

const from = Number(arg("--from", "0"));
const to = Number(arg("--to", "4"));
const amount = String(arg("--amount", "150"));
const delayMs = Number(arg("--delay-ms", "2500"));
const jobTimeoutMs = Number(arg("--job-timeout-ms", "180000"));

const lines = fs.readFileSync(addressesCsv, "utf8").trim().split("\n").slice(1);
const rows = lines.map((l) => {
  const [index, address] = l.split(",");
  return { index: Number(index), address };
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJson(res) {
  const text = await res.text();
  const trimmed = (text || "").trim();
  if (!trimmed || trimmed.charAt(0) === "<") {
    return { html: true, status: res.status, ok: false, text: trimmed.slice(0, 200) };
  }
  try {
    const j = JSON.parse(trimmed);
    j.status = res.status;
    j.httpOk = res.ok;
    return j;
  } catch (err) {
    return { html: true, status: res.status, ok: false, parseError: String(err) };
  }
}

const hdr = {
  "Bypass-Tunnel-Reminder": "true",
  Accept: "application/json",
  "content-type": "application/json",
};

async function claim(address) {
  const res = await fetch(`${API}/api/faucet`, {
    method: "POST",
    headers: hdr,
    body: JSON.stringify({ address, amount }),
  });
  let j = await readJson(res);
  if (j.pending && j.job) {
    const started = Date.now();
    while (Date.now() - started < jobTimeoutMs) {
      await sleep(1200);
      const poll = await fetch(
        `${API}/api/faucet?job=${encodeURIComponent(j.job)}`,
        { headers: { "Bypass-Tunnel-Reminder": "true", Accept: "application/json" } }
      );
      const cur = await readJson(poll);
      if (cur.html) continue;
      if (cur.ok || cur.txid || cur.error || cur.done || cur.success) {
        j = { ...j, ...cur, polled: true };
        break;
      }
      if (cur.pending) continue;
      j = { ...j, ...cur, polled: true };
      break;
    }
  }
  return j;
}

// Probe API
const probeRes = await fetch(`${API}/api/faucet`, {
  headers: { "Bypass-Tunnel-Reminder": "true", Accept: "application/json" },
});
const probe = await readJson(probeRes);
if (probe.html || probe.network !== "testnet-10") {
  console.log(JSON.stringify({ ok: false, phase: "probe_failed", probe }));
  process.exit(2);
}
console.log(
  JSON.stringify({
    phase: "probe_ok",
    dripTkas: probe.dripTkas,
    capTkas: probe.capTkas,
    faucetBalanceTkas: probe.faucetBalanceTkas,
    amount,
    from,
    to,
  })
);

const summary = {
  started_at: new Date().toISOString(),
  amount_tkas: amount,
  from,
  to,
  funded: 0,
  failed: 0,
  skipped: 0,
  results: [],
  blocker: null,
};

for (const row of rows) {
  if (row.index < from || row.index > to) continue;
  const started = new Date().toISOString();
  let result;
  try {
    const j = await claim(row.address);
    const ok = !!(j.ok || j.txid || j.success) && !j.error;
    result = {
      index: row.index,
      address: row.address,
      amount,
      ok,
      txid: j.txid || j.transactionId || null,
      error: j.error || j.message || null,
      remainingTkas: j.remainingTkas ?? null,
      remainingAddrTkas: j.remainingAddrTkas ?? null,
      remainingIpTkas: j.remainingIpTkas ?? null,
      raw_keys: Object.keys(j),
      started,
      finished: new Date().toISOString(),
    };
    if (ok) summary.funded += 1;
    else {
      summary.failed += 1;
      const err = String(j.error || j.message || "");
      if (/ip|rate|cap|limit|24/i.test(err) || j.remainingIpTkas === "0" || j.remainingIpTkas === 0) {
        summary.blocker = err || "ip_or_rate_limit";
        fs.appendFileSync(logPath, JSON.stringify(result) + "\n");
        summary.results.push(result);
        console.log(JSON.stringify({ phase: "blocked", ...result }));
        break;
      }
    }
  } catch (err) {
    summary.failed += 1;
    result = {
      index: row.index,
      address: row.address,
      amount,
      ok: false,
      error: String(err),
      started,
      finished: new Date().toISOString(),
    };
  }
  fs.appendFileSync(logPath, JSON.stringify(result) + "\n");
  summary.results.push(result);
  console.log(JSON.stringify({ phase: "claim", ...result }));
  if (row.index < to) await sleep(delayMs);
}

summary.finished_at = new Date().toISOString();
fs.writeFileSync(statusPath, JSON.stringify(summary, null, 2) + "\n");
console.log(
  JSON.stringify({
    phase: "done",
    funded: summary.funded,
    failed: summary.failed,
    blocker: summary.blocker,
    status: statusPath,
    log: logPath,
  })
);
