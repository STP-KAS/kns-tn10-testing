#!/usr/bin/env node
/**
 * Redistribute tKAS from one snapshot wallet to others (TN10 only).
 * Reads privkeys from secrets jsonl; NEVER prints keys.
 *
 * Usage:
 *   node snap-redistribute.mjs --from-index 0 --to-from 1 --to-to 1 --amount-tkas 200
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;

const SDK =
  "/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js";
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const NETWORK = "testnet-10";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

const fromIndex = Number(arg("--from-index", "0"));
const toFrom = Number(arg("--to-from", "1"));
const toTo = Number(arg("--to-to", "1"));
const amountTkas = arg("--amount-tkas", "200");
const meta = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, "utf8"));
const privPath = meta.privkeys_file;
const logPath = `${OUT}/redistribute-log.jsonl`;

const kaspa = await import(pathToFileURL(SDK).href);
kaspa.initConsolePanicHook?.();

const privLines = fs.readFileSync(privPath, "utf8").trim().split("\n");
const byIndex = new Map();
for (const line of privLines) {
  const j = JSON.parse(line);
  byIndex.set(j.index, j);
}
const src = byIndex.get(fromIndex);
if (!src) throw new Error(`missing from-index ${fromIndex}`);

const privateKey = new kaspa.PrivateKey(src.private_key_hex);
const keypair = privateKey.toKeypair();
const fromAddr = keypair.toAddress(NETWORK).toString();
if (fromAddr !== src.address) throw new Error("address mismatch for from-index");

const rpc = new kaspa.RpcClient({
  resolver: new kaspa.Resolver(),
  encoding: kaspa.Encoding.Borsh,
  networkId: NETWORK,
});
await rpc.connect();
const info = await rpc.getServerInfo();
console.log(
  JSON.stringify({
    phase: "rpc",
    isSynced: info.isSynced,
    networkId: String(info.networkId),
    fromIndex,
    fromAddr,
    amountTkas,
    toFrom,
    toTo,
  })
);

const amountSompi = kaspa.kaspaToSompi(String(amountTkas));
const priorityFee = kaspa.kaspaToSompi("0.01");
const results = [];

for (let i = toFrom; i <= toTo; i++) {
  const dest = byIndex.get(i);
  if (!dest) throw new Error(`missing dest index ${i}`);
  const { entries } = await rpc.getUtxosByAddresses([fromAddr]);
  if (!entries.length) {
    const r = { ok: false, index: i, error: "no_utxos", fromAddr };
    results.push(r);
    fs.appendFileSync(logPath, JSON.stringify(r) + "\n");
    console.log(JSON.stringify({ phase: "fail", ...r }));
    break;
  }
  const { transactions } = await kaspa.createTransactions({
    entries,
    outputs: [{ address: dest.address, amount: amountSompi }],
    priorityFee,
    changeAddress: fromAddr,
    networkId: NETWORK,
  });
  const txids = [];
  for (const pending of transactions) {
    pending.sign([privateKey]);
    const id = await pending.submit(rpc);
    txids.push(id);
  }
  const r = {
    ok: true,
    fromIndex,
    toIndex: i,
    to: dest.address,
    amountTkas,
    txids,
    at: new Date().toISOString(),
  };
  results.push(r);
  fs.appendFileSync(logPath, JSON.stringify(r) + "\n");
  console.log(JSON.stringify({ phase: "sent", ...r }));
  // brief pause for UTXO refresh
  await new Promise((r) => setTimeout(r, 1500));
}

await rpc.disconnect();
console.log(JSON.stringify({ phase: "done", sent: results.filter((x) => x.ok).length, results_count: results.length }));
