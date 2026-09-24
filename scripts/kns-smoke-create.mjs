#!/usr/bin/env node
/**
 * KNS TN10 single-domain smoke create (commit + reveal).
 * Reads privkey from BACKUP_PRIVKEY_FILE (required env var; no default in this published copy).
 * NEVER prints the key.
 *
 * Usage:
 *   node kns-smoke-create.mjs --label stp-smoke-xxx [--broadcast 0|1]
 * Default broadcast=0 (dry planning only). Set --broadcast 1 to submit.
 */
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;

const SDK =
  "/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js";
const FEE =
  "kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru";
const API = "https://api.knsdomains.org/tn10/api/v1";
const PRIV_FILE =
  process.env.BACKUP_PRIVKEY_FILE ||
  (() => { throw new Error("set BACKUP_PRIVKEY_FILE (env only, never commit)"); })();

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

const label = arg("--label", `stp-smoke-${Math.floor(Date.now() / 1000)}`)
  .replace(/\.kas$/i, "")
  .trim()
  .toLowerCase();
const domain = `${label}.kas`;
const broadcast = arg("--broadcast", "0") === "1";
const feeKas = priceKas(label);

const kaspa = await import(pathToFileURL(SDK).href);
kaspa.initConsolePanicHook?.();

const privHex = fs.readFileSync(PRIV_FILE, "utf8").trim();
const privateKey = new kaspa.PrivateKey(privHex);
const keypair = privateKey.toKeypair();
const network = "testnet-10";
const address = keypair.toAddress(network);
const payer = address.toString();

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
const p2shAddress = kaspa.addressFromScriptPublicKey(p2shSpk, network).toString();

const checkRes = await fetch(`${API}/domains/check`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ domainNames: [domain], address: payer }),
});
const checkJson = await checkRes.json();
const available =
  checkJson?.data?.domains?.[0]?.available === true &&
  checkJson?.data?.domains?.[0]?.isReservedDomain === false;

const plan = {
  network,
  broadcast,
  domain,
  payer,
  p2shAddress,
  feeKas,
  feeAddress: FEE,
  payload,
  available,
  check: checkJson,
};
console.log(JSON.stringify({ phase: "plan", ...plan }, null, 2));

if (!available) {
  console.error("Domain not available");
  process.exit(4);
}
if (!broadcast) {
  console.log(JSON.stringify({ ok: true, broadcast: false, note: "pass --broadcast 1 to submit" }));
  process.exit(0);
}

// Prefer public resolver (local node may be unsynced for submit)
const rpc = new kaspa.RpcClient({
  resolver: new kaspa.Resolver(),
  encoding: kaspa.Encoding.Borsh,
  networkId: network,
});
await rpc.connect();
const info = await rpc.getServerInfo();
console.log(
  JSON.stringify({
    phase: "rpc",
    isSynced: info.isSynced,
    serverVersion: info.serverVersion,
    networkId: String(info.networkId),
    url: rpc.url,
  })
);

const commitLock = kaspa.kaspaToSompi("1");
const priorityCommit = kaspa.kaspaToSompi("0.01");
const feeSompi = kaspa.kaspaToSompi(String(feeKas));
const priorityReveal = kaspa.kaspaToSompi("0.02");

const { entries } = await rpc.getUtxosByAddresses([payer]);
if (!entries.length) {
  console.error("No UTXOs for payer");
  await rpc.disconnect();
  process.exit(5);
}
// Prefer fewer large UTXOs
entries.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1));
const commitEntries = entries.slice(0, 20);

const { transactions: commitTxs } = await kaspa.createTransactions({
  priorityEntries: [],
  entries: commitEntries,
  outputs: [{ address: p2shAddress, amount: commitLock }],
  changeAddress: payer,
  priorityFee: priorityCommit,
  networkId: network,
});

let commitId;
for (const pending of commitTxs) {
  pending.sign([privateKey]);
  commitId = await pending.submit(rpc);
  console.log(JSON.stringify({ phase: "commit", txid: commitId }));
}

// Poll for P2SH UTXO
let p2shEntry = null;
const deadline = Date.now() + 180_000;
while (Date.now() < deadline) {
  const { entries: p2 } = await rpc.getUtxosByAddresses([p2shAddress]);
  if (p2 && p2.length) {
    p2shEntry = p2[0];
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!p2shEntry) {
  console.error(JSON.stringify({ phase: "error", error: "p2sh_utxo_timeout", commitId }));
  await rpc.disconnect();
  process.exit(6);
}
console.log(
  JSON.stringify({
    phase: "p2sh_utxo",
    amount: String(p2shEntry.amount),
    outpoint: p2shEntry.outpoint,
  })
);

const { entries: fresh } = await rpc.getUtxosByAddresses([payer]);
fresh.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? 1 : -1));

const { transactions: revealTxs } = await kaspa.createTransactions({
  priorityEntries: [p2shEntry],
  entries: fresh.slice(0, 30),
  outputs: [{ address: FEE, amount: feeSompi }],
  changeAddress: payer,
  priorityFee: priorityReveal,
  networkId: network,
});

let revealId;
for (const pending of revealTxs) {
  pending.sign([privateKey], false);
  const inputs = pending.transaction.inputs;
  const idx = inputs.findIndex((input) => !input.signatureScript || input.signatureScript === "");
  if (idx === -1) {
    console.error("No empty signatureScript input for P2SH");
    process.exit(7);
  }
  const signature = await pending.createInputSignature(idx, privateKey);
  pending.fillInput(idx, script.encodePayToScriptHashSignatureScript(signature));
  revealId = await pending.submit(rpc);
  console.log(JSON.stringify({ phase: "reveal", txid: revealId }));
}

await rpc.disconnect();

const inscriptionId = `${revealId}i0`;
fs.writeFileSync(
  `/workspace/artifacts/kns-tn10/api/smoke-result-${label}.json`,
  JSON.stringify(
    {
      domain,
      payer,
      commitId,
      revealId,
      inscriptionId,
      feeKas,
      p2shAddress,
      at: new Date().toISOString(),
    },
    null,
    2
  ) + "\n"
);

// Poll indexer briefly
let owner = null;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const r = await fetch(`${API}/${encodeURIComponent(domain)}/owner`);
  if (r.status === 200) {
    owner = await r.json();
    break;
  }
}
console.log(
  JSON.stringify({
    phase: "done",
    domain,
    commitId,
    revealId,
    inscriptionId,
    indexer: owner,
  }, null, 2)
);
