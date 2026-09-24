#!/usr/bin/env node
/**
 * KNS TN10 snapshot smoke: create domains as stp-snap-W###-D### from a snapshot wallet.
 * Does NOT touch stp-bulk-* naming or the bulk chain.
 *
 * Usage:
 *   node kns-snap-smoke.mjs --wallet 0 --domain-from 0 --domain-to 1 [--broadcast 0|1]
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import path from "node:path";

const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;

const SDK =
  "/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js";
const FEE =
  "kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru";
const API = "https://api.knsdomains.org/tn10/api/v1";
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const API_DIR = "/workspace/artifacts/kns-tn10/api";
const NETWORK = "testnet-10";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

function visualLen(s) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return (
      [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)]
        .length || s.length
    );
  }
  return [...s].filter((c) => c !== "\u200d" && c !== "\ufe0f").length || s.length;
}

function priceKas(label) {
  const n = visualLen(label);
  if (n <= 2) return 4200;
  if (n === 3) return 2100;
  if (n === 4) return 525;
  return 35;
}

const walletIndex = Number(arg("--wallet", "0"));
const domainFrom = Number(arg("--domain-from", "0"));
const domainTo = Number(arg("--domain-to", "1"));
const broadcast = arg("--broadcast", "0") === "1";
const delayMs = Number(arg("--delay-ms", "8000"));

const meta = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, "utf8"));
const privLines = fs.readFileSync(meta.privkeys_file, "utf8").trim().split("\n");
const w = privLines.map((l) => JSON.parse(l)).find((x) => x.index === walletIndex);
if (!w) throw new Error(`wallet ${walletIndex} not found`);

// Write a temp privkey file (600) for isolation — never log contents
fs.mkdirSync(`${process.env.KNS_TN10_SNAPSHOT_SECRETS_DIR ?? (() => { throw new Error("set KNS_TN10_SNAPSHOT_SECRETS_DIR (env only, never commit)"); })()}/tmp`, { recursive: true, mode: 0o700 });
const tmpPriv = `${process.env.KNS_TN10_SNAPSHOT_SECRETS_DIR ?? (() => { throw new Error("set KNS_TN10_SNAPSHOT_SECRETS_DIR (env only, never commit)"); })()}/tmp/w${String(walletIndex).padStart(3, "0")}.hex`;
fs.writeFileSync(tmpPriv, w.private_key_hex + "\n", { mode: 0o600 });
fs.chmodSync(tmpPriv, 0o600);

const kaspa = await import(pathToFileURL(SDK).href);
kaspa.initConsolePanicHook?.();

async function createOne(label) {
  const domain = `${label}.kas`;
  const feeKas = priceKas(label);
  const privateKey = new kaspa.PrivateKey(w.private_key_hex);
  const keypair = privateKey.toKeypair();
  const payer = keypair.toAddress(NETWORK).toString();

  const payload = JSON.stringify({ op: "create", p: "domain", v: label });
  const script = new kaspa.ScriptBuilder()
    .addData(keypair.xOnlyPublicKey)
    .addOp(kaspa.Opcodes.OpCheckSig)
    .addOp(kaspa.Opcodes.OpFalse)
    .addOp(kaspa.Opcodes.OpIf)
    .addData(Buffer.from("kns"))
    .addI64(0n)
    .addData(Buffer.from(payload))
    .addOp(kaspa.Opcodes.OpEndIf);

  const p2shSpk = script.createPayToScriptHashScript();
  const p2shAddress = kaspa.addressFromScriptPublicKey(p2shSpk, NETWORK).toString();

  const plan = {
    phase: "plan",
    label,
    domain,
    feeKas,
    payer,
    p2shAddress,
    walletIndex,
    broadcast,
  };
  console.log(JSON.stringify(plan));
  if (!broadcast) {
    return { ...plan, ok: true, dry: true };
  }

  const rpc = new kaspa.RpcClient({
    resolver: new kaspa.Resolver(),
    encoding: kaspa.Encoding.Borsh,
    networkId: NETWORK,
  });
  await rpc.connect();
  try {
    const info = await rpc.getServerInfo();
    console.log(JSON.stringify({ phase: "rpc", isSynced: info.isSynced, label }));

    const commitLock = kaspa.kaspaToSompi("1");
    const priorityCommit = kaspa.kaspaToSompi("0.01");
    const feeSompi = kaspa.kaspaToSompi(String(feeKas));
    const priorityReveal = kaspa.kaspaToSompi("0.02");

    let { entries } = await rpc.getUtxosByAddresses([payer]);
    if (!entries.length) {
      return { ok: false, label, error: "no_utxos", payer };
    }

    const { transactions: commitTxs } = await kaspa.createTransactions({
      entries,
      outputs: [
        { address: p2shAddress, amount: commitLock },
        { address: FEE, amount: feeSompi },
      ],
      priorityFee: priorityCommit,
      changeAddress: payer,
      networkId: NETWORK,
      payload: Array.from(new TextEncoder().encode("kns-snap-commit")),
    });
    let commitId = null;
    for (const pending of commitTxs) {
      pending.sign([privateKey]);
      commitId = await pending.submit(rpc);
    }
    console.log(JSON.stringify({ phase: "commit", label, commitId }));

    // wait for p2sh utxo
    let p2 = [];
    for (let t = 0; t < 30; t++) {
      await new Promise((r) => setTimeout(r, 2000));
      ({ entries: p2 } = await rpc.getUtxosByAddresses([p2shAddress]));
      if (p2.length) break;
    }
    if (!p2.length) {
      return { ok: false, label, error: "p2sh_utxo_timeout", commitId };
    }

    ({ entries } = await rpc.getUtxosByAddresses([payer]));
    const { transactions: revealTxs } = await kaspa.createTransactions({
      entries: [...p2, ...entries].slice(0, 8),
      outputs: [],
      priorityFee: priorityReveal,
      changeAddress: payer,
      networkId: NETWORK,
      payload: script.encodePayToScriptHashSignatureScript
        ? undefined
        : undefined,
    });
    // Prefer same pattern as kns-smoke-create for reveal
    // Fall back: rebuild via smoke script logic by importing approach from file
    // Actually use the proven smoke script with env override for reliability.
    throw new Error("use_smoke_subprocess");
  } finally {
    await rpc.disconnect().catch(() => {});
  }
}

// Use proven kns-smoke-create.mjs with BACKUP_PRIVKEY_FILE override + snap labels
async function runViaSmoke(label) {
  const smoke = "/workspace/artifacts/kns-tn10/scripts/kns-smoke-create.mjs";
  const childLog = path.join(API_DIR, `snap-child-${label}.log`);
  fs.mkdirSync(API_DIR, { recursive: true });
  return new Promise((resolve) => {
    const out = fs.createWriteStream(childLog);
    const child = spawn(
      process.execPath,
      [smoke, "--label", label, "--broadcast", broadcast ? "1" : "0"],
      {
        cwd: "/workspace/artifacts/kns-tn10",
        env: { ...process.env, BACKUP_PRIVKEY_FILE: tmpPriv },
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
      const artPath = path.join(API_DIR, `smoke-result-${label}.json`);
      let art = null;
      try {
        art = JSON.parse(fs.readFileSync(artPath, "utf8"));
      } catch {}
      resolve({
        label,
        code,
        childLog,
        revealId: art?.revealId || last.revealId || null,
        commitId: art?.commitId || last.commitId || null,
        ok: !!(art?.revealId || last.revealId || last.phase === "done"),
        last,
      });
    });
  });
}

const summary = {
  walletIndex,
  payer: w.address,
  domainFrom,
  domainTo,
  broadcast,
  results: [],
  started_at: new Date().toISOString(),
};

for (let d = domainFrom; d <= domainTo; d++) {
  const label = `stp-snap-w${String(walletIndex).padStart(3, "0")}-d${String(d).padStart(3, "0")}`;
  console.log(JSON.stringify({ phase: "start", label, walletIndex }));
  const r = await runViaSmoke(label);
  summary.results.push(r);
  console.log(JSON.stringify({ phase: "attempt_done", ...r, last: undefined }));
  if (d < domainTo) await new Promise((res) => setTimeout(res, delayMs));
}

summary.finished_at = new Date().toISOString();
summary.ok_count = summary.results.filter((x) => x.ok).length;
const statusPath = `${OUT}/snap-smoke-w${String(walletIndex).padStart(3, "0")}.json`;
fs.writeFileSync(statusPath, JSON.stringify(summary, null, 2) + "\n");
console.log(
  JSON.stringify({
    phase: "done",
    ok_count: summary.ok_count,
    total: summary.results.length,
    status: statusPath,
  })
);
process.exit(summary.ok_count === summary.results.length ? 0 : 1);
