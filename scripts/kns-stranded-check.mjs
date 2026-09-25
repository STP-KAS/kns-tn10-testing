#!/usr/bin/env node
/**
 * READ-ONLY stranded-commit checker (TN10). Loads NO private keys and broadcasts NOTHING.
 * The KNS commit P2SH address is derived from the payer's public address (x-only pubkey = address payload) + label,
 * exactly as the create scripts build it. For every label that ever had a failed attempt (pool/phase-a/s3/r1/bulk logs)
 * or whose child log shows a commit, it queries the public TN10 resolver for UTXOs still sitting on that P2SH address.
 *   stranded_no_domain  : P2SH UTXO exists and no smoke-result artifact -> rerunning that label's runner reuses it
 *                         (kns-s3-pool / kns-snap-pool / kns-snap-r1 / kns-s3-create reuse; kns-smoke-create does NOT)
 *   extra_commit_domain_done : domain already created, an extra 1 TKAS commit remains locked (double commit after a timeout)
 * Usage: node kns-stranded-check.mjs [--since-hours 48] [--labels a,b,c] [--offline 1]
 * Writes snapshot-wallets/stranded-check-latest.json
 */
import fs from "node:fs"; import path from "node:path"; import { pathToFileURL } from "node:url"; import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d; };
const ROOT = "/workspace/artifacts/kns-tn10", OUT = `${ROOT}/snapshot-wallets`, API_DIR = `${ROOT}/api`, NET = "testnet-10";
const SINCE = Date.now() - Number(arg("--since-hours", "48")) * 3600e3;
const OFFLINE = arg("--offline", "0") === "1";
const artifact = (l) => { try { return JSON.parse(fs.readFileSync(`${API_DIR}/smoke-result-${l}.json`, "utf8")); } catch { return null; } };

// public addresses only
const addrByIndex = new Map();
for (const l of fs.readFileSync(`${OUT}/addresses.csv`, "utf8").split("\n").slice(1)) { const [i, a] = l.split(","); if (a) addrByIndex.set(+i, a); }
let bulkPayer = null;

const cand = new Map(); // label -> {payer?, p2sh?, src}
const add = (label, o) => { if (!label || typeof label !== "string") return; const c = cand.get(label) || { srcs: new Set() }; if (o.payer && !c.payer) c.payer = o.payer; if (o.p2sh && !c.p2sh) c.p2sh = o.p2sh; c.srcs.add(o.src); cand.set(label, c); };
const bad = (j) => j.ok === false || ["attempt_failed", "wallet_abort", "wallet_failed"].includes(j.phase) || (j.code != null && j.code !== 0) || j.committed === true && !j.ok;

if (arg("--labels")) for (const l of arg("--labels").split(",")) add(l.trim(), { src: "cli" });
else {
  const files = [
    ...fs.readdirSync(OUT).filter((f) => /^(s3-|phase-a-|r1-worker).*\.jsonl$/.test(f)).map((f) => `${OUT}/${f}`),
    ...fs.readdirSync(API_DIR).filter((f) => /^bulk-log-.*\.jsonl$/.test(f)).map((f) => `${API_DIR}/${f}`),
  ].filter((f) => fs.statSync(f).mtimeMs >= SINCE);
  for (const f of files) {
    for (const l of fs.readFileSync(f, "utf8").split("\n")) {
      if (!l) continue; let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.last?.payer && /^stp-bulk-/.test(j.label || "")) bulkPayer ||= j.last.payer;
      if (!j.label || !bad(j)) continue;
      add(j.label, { src: path.basename(f), payer: Number.isInteger(j.wallet) ? addrByIndex.get(j.wallet) : undefined });
    }
  }
  // child logs of spawn-based runners (bulk, phase-a 0-6): a commit line without a later artifact
  for (const f of fs.readdirSync(API_DIR)) {
    const m = f.match(/^(?:child-(stp-bulk-\d+)-a\d+|snap-child-(stp-snap-w\d+-d\d+))\.log$/); if (!m) continue;
    const p = `${API_DIR}/${f}`; let st; try { st = fs.statSync(p); } catch { continue; } if (st.mtimeMs < SINCE) continue;
    const t = fs.readFileSync(p, "utf8"); if (!/"phase":\s*"commit"/.test(t)) continue;
    const label = m[1] || m[2]; const p2 = t.match(/"p2shAddress":\s*"(kaspatest:[a-z0-9]+)"/); const py = t.match(/"payer":\s*"(kaspatest:[a-z0-9]+)"/);
    // only interesting if the log had a commit and (no artifact, or more than one commit line)
    const commits = (t.match(/"phase":\s*"commit"/g) || []).length;
    if (!artifact(label)?.revealId || commits > 1) add(label, { src: "child-log", p2sh: p2?.[1], payer: py?.[1] });
  }
}
if (!bulkPayer) { try { bulkPayer = artifact("stp-bulk-0001")?.payer || null; } catch {} }

function payerFor(label, c) {
  if (c.payer) return c.payer;
  let m = label.match(/^stp-snap-w(\d{3})-d\d{3}$/) || label.match(/^stp-s3-w(\d{5})-d\d$/); if (m) return addrByIndex.get(+m[1]);
  if (/^stp-bulk-\d+$/.test(label)) return bulkPayer;
  return artifact(label)?.payer || null;
}
function p2shFor(label, payer) {
  const spk = kaspa.payToAddressScript(new kaspa.Address(payer)); const s = String(spk.script);
  if (!/^20[0-9a-f]{64}ac$/.test(s)) throw new Error("not a schnorr P2PK address");
  const payload = JSON.stringify({ op: "create", p: "domain", v: label });
  const script = new kaspa.ScriptBuilder().addData(s.slice(2, 66)).addOp(kaspa.Opcodes.OpCheckSig).addOp(kaspa.Opcodes.OpFalse).addOp(kaspa.Opcodes.OpIf)
    .addData(Buffer.from("kns")).addI64(0n).addData(Buffer.from(payload)).addOp(kaspa.Opcodes.OpEndIf);
  return kaspa.addressFromScriptPublicKey(script.createPayToScriptHashScript(), NET).toString();
}

const rows = []; let unresolved = 0, mismatch = 0;
for (const [label, c] of cand) {
  const payer = payerFor(label, c); if (!payer) { unresolved++; continue; }
  const p2 = p2shFor(label, payer);
  if (c.p2sh && c.p2sh !== p2) mismatch++;
  const a = artifact(label); if (a?.p2shAddress && a.p2shAddress !== p2) mismatch++;
  rows.push({ label, payer, p2sh: p2, done: !!a?.revealId, srcs: [...c.srcs] });
}
const res = { at: new Date().toISOString(), candidates: cand.size, checkable: rows.length, unresolved, derivation_mismatch: mismatch, stranded_no_domain: [], extra_commit_domain_done: [] };
if (!OFFLINE && rows.length) {
  const rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: NET });
  await rpc.connect();
  const by = new Map(rows.map((r) => [r.p2sh, r]));
  const addrs = [...by.keys()];
  for (let i = 0; i < addrs.length; i += 100) {
    const { entries } = await rpc.getUtxosByAddresses(addrs.slice(i, i + 100));
    for (const e of entries || []) {
      const a = e.address?.toString?.() || String(e.address); const r = by.get(a); if (!r) continue;
      const item = { label: r.label, p2sh: a, sompi: String(e.amount), outpoint: `${e.outpoint.transactionId}:${e.outpoint.index}`, srcs: r.srcs };
      (r.done ? res.extra_commit_domain_done : res.stranded_no_domain).push(item);
    }
  }
  await rpc.disconnect();
}
res.stranded_no_domain_count = res.stranded_no_domain.length; res.extra_commit_domain_done_count = res.extra_commit_domain_done.length;
fs.writeFileSync(`${OUT}/stranded-check-latest.json`, JSON.stringify(res, null, 2) + "\n");
console.log(JSON.stringify({ ...res, stranded_no_domain: res.stranded_no_domain.slice(0, 30), extra_commit_domain_done: res.extra_commit_domain_done.slice(0, 10), report: `${OUT}/stranded-check-latest.json` }, null, 1));
process.exit(0);
