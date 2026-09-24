#!/usr/bin/env node
/**
 * Generate Kaspa TN10 receive addresses from one BIP39 mnemonic
 * via BIP44 path m/44'/111111'/0'/0/i.
 *
 * Fresh generation (legacy behavior):
 *   node gen-snapshot-wallets.mjs [--count 200] [--account 0]
 *
 * Append a range from the existing snapshot mnemonic:
 *   node gen-snapshot-wallets.mjs --from 200 --to 699
 *
 * Secrets land under SECRETS_DIR (chmod 600). Public indexes under OUT_DIR.
 * NEVER prints mnemonic or private keys.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;

const SDK =
  "/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js";
const NETWORK = "testnet-10";
const COIN_TYPE = 111111; // Kaspa BIP44

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function integerArg(name, value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return n;
}

function oneMatchingFile(dir, re, label) {
  const files = fs.readdirSync(dir)
    .filter((name) => re.test(name))
    .sort()
    .map((name) => path.join(dir, name));
  if (files.length !== 1) {
    throw new Error(`expected exactly one ${label} in secrets directory`);
  }
  return files[0];
}

function readCsvRows(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  if (lines[0] !== "index,address,derivation_path") {
    throw new Error("addresses.csv has an unexpected header");
  }
  return lines.slice(1).map((line) => {
    const [index, address, derivation_path] = line.split(",");
    const i = Number(index);
    if (!Number.isSafeInteger(i) || i < 0 || !address || !derivation_path) {
      throw new Error("addresses.csv contains an invalid row");
    }
    return { index: i, address, derivation_path };
  });
}

function readJsonlIndexes(file) {
  if (!fs.existsSync(file)) return new Set();
  const text = fs.readFileSync(file, "utf8");
  const indexes = new Set();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    const rec = JSON.parse(line);
    if (!Number.isSafeInteger(rec.index) || rec.index < 0) {
      throw new Error(`invalid index in ${path.basename(file)}`);
    }
    if (indexes.has(rec.index)) {
      throw new Error(`duplicate index in ${path.basename(file)}`);
    }
    indexes.add(rec.index);
  }
  return indexes;
}

const account = integerArg("--account", arg("--account", "0"));
const outDir = arg(
  "--out",
  "/workspace/artifacts/kns-tn10/snapshot-wallets",
);
const secretsDir = arg(
  "--secrets",
  process.env.KNS_TN10_SNAPSHOT_SECRETS_DIR, // pass --secrets <dir> or set the env var; never inside the repo
);
const rangeMode = hasArg("--from") || hasArg("--to");
const from = integerArg("--from", arg("--from", "0"));
const count = integerArg("--count", arg("--count", "200"));
const to = integerArg(
  "--to",
  arg("--to", String(rangeMode ? from + count - 1 : count - 1)),
);
if (to < from) throw new Error("--to must be >= --from");
if (!rangeMode && from !== 0) throw new Error("--from requires range mode");

fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

const kaspa = await import(pathToFileURL(SDK).href);
kaspa.initConsolePanicHook?.();

const walletsJsonl = path.join(outDir, "wallets.jsonl");
const addressesCsv = path.join(outDir, "addresses.csv");
const metaPath = path.join(outDir, "meta.json");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

let mnemonicPath;
let privkeysPath;
let mnemonic;
if (rangeMode) {
  mnemonicPath = arg(
    "--mnemonic",
    oneMatchingFile(secretsDir, /^master-mnemonic-.*\.txt$/, "master mnemonic"),
  );
  privkeysPath = arg(
    "--privkeys",
    oneMatchingFile(secretsDir, /^privkeys-.*\.jsonl$/, "private-key file"),
  );
  if (!fs.existsSync(mnemonicPath) || !fs.existsSync(privkeysPath)) {
    throw new Error("existing mnemonic and private-key files are required for append mode");
  }
  const phrase = fs.readFileSync(mnemonicPath, "utf8").trim().split(/\s+/).join(" ");
  mnemonic = new kaspa.Mnemonic(phrase);
} else {
  mnemonic = kaspa.Mnemonic.random(24);
  mnemonicPath = path.join(secretsDir, `master-mnemonic-${stamp}.txt`);
  privkeysPath = path.join(secretsDir, `privkeys-${stamp}.jsonl`);
  fs.writeFileSync(mnemonicPath, mnemonic.phrase + "\n", { mode: 0o600 });
  fs.chmodSync(mnemonicPath, 0o600);
}

const seed = mnemonic.toSeed();
const xPrv = new kaspa.XPrv(seed);

const existingCsvRows = readCsvRows(addressesCsv);
const existingIndexes = new Set();
const existingAddresses = new Set();
for (const row of existingCsvRows) {
  if (existingIndexes.has(row.index)) throw new Error(`duplicate CSV index ${row.index}`);
  if (existingAddresses.has(row.address)) throw new Error(`duplicate CSV address at index ${row.index}`);
  existingIndexes.add(row.index);
  existingAddresses.add(row.address);
}
const existingWalletIndexes = readJsonlIndexes(walletsJsonl);
const existingPrivIndexes = readJsonlIndexes(privkeysPath);
if (rangeMode) {
  for (let i = from; i <= to; i++) {
    if (existingIndexes.has(i) || existingWalletIndexes.has(i) || existingPrivIndexes.has(i)) {
      throw new Error(`refusing to overwrite existing index ${i}`);
    }
  }
}

const newRecords = [];
const newAddresses = new Set();
for (let i = from; i <= to; i++) {
  const derPath = `m/44'/${COIN_TYPE}'/${account}'/0/${i}`;
  const priv = xPrv.derivePath(derPath).toPrivateKey();
  const keypair = priv.toKeypair();
  const address = keypair.toAddress(NETWORK).toString();
  if (!address.startsWith("kaspatest:")) {
    throw new Error(`non-tn10 address at index ${i}: ${address.slice(0, 20)}`);
  }
  if (existingAddresses.has(address) || newAddresses.has(address)) {
    throw new Error(`duplicate address at index ${i}`);
  }
  newAddresses.add(address);
  newRecords.push({
    index: i,
    derivation_path: derPath,
    address,
    private_key_hex: priv.toString(),
  });
}

const privFd = fs.openSync(privkeysPath, rangeMode ? "a" : "w", 0o600);
const pubFd = fs.openSync(walletsJsonl, rangeMode ? "a" : "w", 0o600);
const csvFd = fs.openSync(addressesCsv, rangeMode ? "a" : "w", 0o644);
try {
  if (!rangeMode) fs.writeSync(csvFd, "index,address,derivation_path\n");
  const createdAt = new Date().toISOString();
  for (const rec of newRecords) {
    fs.writeSync(privFd, JSON.stringify(rec) + "\n");
    fs.writeSync(pubFd, JSON.stringify({
      index: rec.index,
      address: rec.address,
      derivation_path: rec.derivation_path,
      secrets_file: privkeysPath,
      mnemonic_file: mnemonicPath,
      network: NETWORK,
      created_at: createdAt,
    }) + "\n");
    fs.writeSync(csvFd, `${rec.index},${rec.address},${rec.derivation_path}\n`);
  }
} finally {
  fs.closeSync(privFd);
  fs.closeSync(pubFd);
  fs.closeSync(csvFd);
}

fs.chmodSync(privkeysPath, 0o600);
fs.chmodSync(walletsJsonl, 0o600);
fs.chmodSync(addressesCsv, 0o644);

const total = rangeMode ? existingCsvRows.length + newRecords.length : newRecords.length;
const unique = rangeMode ? existingAddresses.size + newAddresses.size : newAddresses.size;
const meta = fs.existsSync(metaPath) && rangeMode
  ? JSON.parse(fs.readFileSync(metaPath, "utf8"))
  : {};
Object.assign(meta, {
  count: total,
  unique,
  network: NETWORK,
  account,
  derivation_template: `m/44'/${COIN_TYPE}'/${account}'/0/{i}`,
  bip39_words: 24,
  wallets_jsonl: walletsJsonl,
  addresses_csv: addressesCsv,
  secrets_dir: secretsDir,
  mnemonic_file: mnemonicPath,
  privkeys_file: privkeysPath,
  created_at: new Date().toISOString(),
  note: "Secrets are NEVER to be pasted into chat. Share addresses.csv only.",
});
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", { mode: 0o644 });
fs.chmodSync(metaPath, 0o644);

console.log(JSON.stringify({
  ok: true,
  mode: rangeMode ? "append" : "fresh",
  from,
  to,
  count: newRecords.length,
  total,
  wallets_jsonl: walletsJsonl,
  addresses_csv: addressesCsv,
  meta: metaPath,
  secrets_dir: secretsDir,
  mnemonic_file_basename: path.basename(mnemonicPath),
  privkeys_file_basename: path.basename(privkeysPath),
  first_new_address: newRecords[0]?.address,
  last_new_address: newRecords.at(-1)?.address,
}));
